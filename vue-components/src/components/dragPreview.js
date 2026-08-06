// Optimistic point-drag overlay. The mirror continues to track server truth;
// this module rewrites only the rendered bound points array while a drag lives.

import { mat4 } from "../glMatrix";
import { getWorldToClipMatrix } from "./cameraMatrix";
import { viewAsTypedArray } from "./sync/base64";

const EPSILON = 1e-9;

function unproject(inverse, x, y, z) {
  const w = inverse[3] * x + inverse[7] * y + inverse[11] * z + inverse[15];
  if (Math.abs(w) < EPSILON) return null;
  return [
    (inverse[0] * x + inverse[4] * y + inverse[8] * z + inverse[12]) / w,
    (inverse[1] * x + inverse[5] * y + inverse[9] * z + inverse[13]) / w,
    (inverse[2] * x + inverse[6] * y + inverse[10] * z + inverse[14]) / w,
  ];
}

function intersectPlane(near, far, origin, normal) {
  const direction = far.map((value, index) => value - near[index]);
  const denominator = direction.reduce(
    (sum, value, index) => sum + value * normal[index],
    0,
  );
  if (Math.abs(denominator) < EPSILON) return null;
  const numerator = origin.reduce(
    (sum, value, index) => sum + (value - near[index]) * normal[index],
    0,
  );
  const t = numerator / denominator;
  if (!Number.isFinite(t)) return null;
  return near.map((value, index) => value + direction[index] * t);
}

export function createDragPreview({
  getCamera,
  getViewportMetrics,
  getBoundArray,
  getInstance,
  getPickableIds,
  requestRender,
} = {}) {
  let active = null;

  // Where does the grabbed point live in the bound array right now? The app
  // may reorder or re-bucket points mid-drag (e.g. selecting the grabbed
  // point moves it between render buckets), so the pick-time index can go
  // stale while the array keeps its size. When the pick was made against an
  // ids block, follow the grabbed id (returning -1 when the point left this
  // node). An index-fallback pointId is just a number that ids arriving
  // mid-drag would never contain, so those picks stay on the index path.
  function currentPointIndex() {
    if (!active.trackById) return active.pick.pointIndex;
    const ids = getPickableIds?.(active.pick.nodeId);
    if (!Array.isArray(ids)) return active.pick.pointIndex;
    return ids.indexOf(active.pick.pointId);
  }

  function previewWorld(payload) {
    if (active.pick.preview === "cloud") {
      const world = payload?.cloud_solve?.world;
      return payload?.cloud_solve?.status === "hit" &&
        Array.isArray(world) &&
        world.length === 3 &&
        world.every(Number.isFinite)
        ? world.map(Number)
        : null;
    }
    const pointer = payload?.pointer;
    const camera = getCamera?.();
    const metrics = getViewportMetrics?.();
    if (!pointer || !camera || !metrics) return null;
    // The same world->clip the pick projection reads, inverted for the
    // pointer-ray unprojection — preview and hit-test share one convention.
    const worldToClip = getWorldToClipMatrix(camera, metrics.aspect);
    const inverse =
      worldToClip && mat4.invert(new Float64Array(16), worldToClip);
    if (!inverse) return null;
    const ndcX = (pointer.x / metrics.width) * 2 - 1;
    const ndcY = 1 - (pointer.y / metrics.height) * 2;
    const near = unproject(inverse, ndcX, ndcY, -1);
    const far = unproject(inverse, ndcX, ndcY, 1);
    if (!near || !far) return null;
    const plane = active.pick.plane;
    const origin =
      active.pick.preview === "plane" ? plane?.origin : active.pick.world;
    const normal =
      active.pick.preview === "plane"
        ? plane?.normal
        : camera.getDirectionOfProjection?.();
    return origin && normal ? intersectPlane(near, far, origin, normal) : null;
  }

  function journalSlot(array, values, offset) {
    let journal = active.undo.find(
      (entry) => entry.array === array && entry.offset === offset,
    );
    if (!journal) {
      journal = {
        array,
        values,
        offset,
        confirmed: values.slice(offset, offset + 3),
        optimistic: null,
      };
      active.undo.push(journal);
    }
    return journal;
  }

  function restoreUndo({ clear = false } = {}) {
    if (!active) return false;
    let restored = false;
    for (const entry of active.undo) {
      if (entry.offset + 2 >= entry.values.length) continue;
      for (let component = 0; component < 3; component += 1) {
        // A structural replacement may reuse the same typed array and overwrite
        // this slot without a patch op. Restore only bytes still carrying our
        // last overlay; anything else is newer external/server state.
        if (
          entry.optimistic &&
          Object.is(
            entry.values[entry.offset + component],
            entry.optimistic[component],
          )
        ) {
          entry.values[entry.offset + component] = entry.confirmed[component];
        } else if (entry.optimistic) {
          entry.confirmed[component] = entry.values[entry.offset + component];
        }
      }
      entry.optimistic = null;
      entry.array.modified?.();
      restored = true;
    }
    if (clear) active.undo.length = 0;
    if (restored) {
      getInstance?.(active.pointsNodeId)?.modified?.();
      getInstance?.(active.pick.nodeId)?.modified?.();
      requestRender?.();
    }
    return restored;
  }

  function cancelPreview() {
    if (!active) return false;
    const restored = restoreUndo({ clear: true });
    active = null;
    return restored;
  }

  function write(world) {
    if (!active || !world) return false;
    const array = getBoundArray?.(active.pointsNodeId, "points");
    const values = array?.getData?.();
    const pointIndex = currentPointIndex();
    const offset = pointIndex * 3;
    if (pointIndex < 0 || !values || offset + 2 >= values.length) {
      // The grabbed point left this node (re-bucketed by the app) or the
      // array shrank past it: writing through a stale index would move a
      // DIFFERENT point. Stop previewing; server confirmations own the rest
      // of the drag.
      cancelPreview();
      return false;
    }
    if (values.length !== active.expectedLength) {
      if (active.expectedLength !== null && !active.trackById) {
        // Structural change with no point identity to re-target by.
        cancelPreview();
        return false;
      }
      active.expectedLength = values.length;
    }
    const journal = journalSlot(array, values, offset);
    values.set(world, offset);
    journal.optimistic = values.slice(offset, offset + 3);
    array.modified?.();
    getInstance?.(active.pointsNodeId)?.modified?.();
    getInstance?.(active.pick.nodeId)?.modified?.();
    active.world = world.slice();
    requestRender?.();
    return true;
  }

  function matchingPatchData(op) {
    if (
      !active ||
      op?.op !== "patchArray" ||
      String(op.id) !== active.pointsNodeId ||
      op.key !== "points"
    ) {
      return null;
    }
    try {
      return viewAsTypedArray(op.data, op.dataType);
    } catch {
      return null;
    }
  }

  // Reconciler patches have already landed when reapply() runs. Fold exactly
  // the covered typed-array elements into the undo journal before putting the
  // optimistic overlay back; untouched components retain their prior server
  // values instead of accidentally adopting optimistic neighbors.
  function absorbConfirmations(message) {
    if (!active || !Array.isArray(message?.ops)) return;
    const currentArray = getBoundArray?.(active.pointsNodeId, "points");
    for (const op of message.ops) {
      const data = matchingPatchData(op);
      if (!data) continue;
      const patchStart = Number(op.offset);
      const patchEnd = patchStart + data.length;
      for (const entry of active.undo) {
        if (entry.array !== currentArray) continue;
        const overlapStart = Math.max(entry.offset, patchStart);
        const overlapEnd = Math.min(entry.offset + 3, patchEnd);
        for (let index = overlapStart; index < overlapEnd; index += 1) {
          entry.confirmed[index - entry.offset] = data[index - patchStart];
        }
      }
    }
  }

  function start(payload) {
    cancelPreview();
    const pick = payload?.pick;
    if (!pick?.preview || pick.pointsNodeId == null) {
      active = null;
      return false;
    }
    const ids = getPickableIds?.(String(pick.nodeId));
    active = {
      pick,
      pointsNodeId: String(pick.pointsNodeId),
      // Identity tracking only holds when the pick actually carries an id
      // from the pickable's ids block; otherwise pointId is the numeric
      // index fallback and ids can never resolve it.
      trackById: Array.isArray(ids) && ids[pick.pointIndex] != null,
      world: null,
      expectedLength: null,
      undo: [],
    };
    return true;
  }

  function move(payload) {
    if (!active) return false;
    const world = previewWorld(payload);
    if (active.pick.preview === "cloud" && !world) {
      if (active.world) restoreUndo();
      active.world = null;
      return false;
    }
    return write(world);
  }

  function reapply(message = null) {
    absorbConfirmations(message);
    return active?.world ? write(active.world) : false;
  }

  function end() {
    cancelPreview();
  }

  function targets(nodeId) {
    const id = String(nodeId);
    return (
      !!active && (active.pick.nodeId === id || active.pointsNodeId === id)
    );
  }

  return { start, move, reapply, end, targets, isActive: () => !!active };
}

export default { createDragPreview };
