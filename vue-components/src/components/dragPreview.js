// Optimistic point-drag overlay. The mirror continues to track server truth;
// this module rewrites only the rendered bound points array while a drag lives.

import { mat4 } from "../glMatrix";
import { getWorldToClipMatrix } from "./cameraMatrix";

const EPSILON = 1e-9;

function unproject(inverse, x, y, z) {
  const w =
    inverse[3] * x +
    inverse[7] * y +
    inverse[11] * z +
    inverse[15];
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
  // stale while the array keeps its size. The pickable block's ids name the
  // point at each index; follow the grabbed id when they're available, and
  // return -1 when the point left this node entirely.
  function currentPointIndex() {
    const ids = getPickableIds?.(active.pick.nodeId);
    if (!Array.isArray(ids)) return active.pick.pointIndex;
    return ids.indexOf(active.pick.pointId);
  }

  function previewWorld(payload) {
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
      active = null;
      return false;
    }
    if (values.length !== active.expectedLength) {
      if (active.expectedLength !== null && !Array.isArray(getPickableIds?.(active.pick.nodeId))) {
        // Structural change with no point identities to re-target by.
        active = null;
        return false;
      }
      active.expectedLength = values.length;
    }
    values[offset] = world[0];
    values[offset + 1] = world[1];
    values[offset + 2] = world[2];
    array.modified?.();
    getInstance?.(active.pointsNodeId)?.modified?.();
    getInstance?.(active.pick.nodeId)?.modified?.();
    active.world = world.slice();
    requestRender?.();
    return true;
  }

  function start(payload) {
    const pick = payload?.pick;
    if (!pick?.preview || pick.pointsNodeId == null) {
      active = null;
      return false;
    }
    active = {
      pick,
      pointsNodeId: String(pick.pointsNodeId),
      world: null,
      expectedLength: null,
    };
    return true;
  }

  function move(payload) {
    return active ? write(previewWorld(payload)) : false;
  }

  function reapply() {
    return active?.world ? write(active.world) : false;
  }

  function end() {
    active = null;
  }

  function targets(nodeId) {
    const id = String(nodeId);
    return !!active &&
      (active.pick.nodeId === id || active.pointsNodeId === id);
  }

  return { start, move, reapply, end, targets, isActive: () => !!active };
}

export default { createDragPreview };
