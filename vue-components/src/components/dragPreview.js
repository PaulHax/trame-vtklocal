// Optimistic point-drag overlay. The mirror continues to track server truth;
// this module rewrites only the rendered bound points array while a drag lives.

import { mat4 } from "../glMatrix";
import { getWorldToClipMatrix } from "./cameraMatrix";

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
  resolveTarget,
  requestRender,
} = {}) {
  const previews = new Set();
  let current = null;

  function samePoint(preview, pick) {
    if (preview.pick.previewGroup != null || pick.previewGroup != null) {
      return (
        preview.pick.previewGroup === pick.previewGroup &&
        preview.pick.pointId === pick.pointId
      );
    }
    return (
      preview.pick.nodeId === pick.nodeId &&
      (preview.trackById
        ? preview.pick.pointId === pick.pointId
        : preview.pick.pointIndex === pick.pointIndex)
    );
  }

  function previewWorld(active, payload) {
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

  function restore(preview) {
    const saved = preview.undo;
    preview.undo = null;
    if (!saved) return false;
    // Each overlay owns exactly one point. Undo before reconciling scene
    // messages so partial patches and rebucketing always read server data.
    saved.values.set(saved.confirmed, saved.offset);
    saved.array.modified?.();
    getInstance?.(saved.pointsNodeId)?.modified?.();
    getInstance?.(saved.nodeId)?.modified?.();
    requestRender?.();
    return true;
  }

  function remove(preview) {
    const restored = restore(preview);
    previews.delete(preview);
    if (current === preview) current = null;
    return restored;
  }

  function targetFor(preview) {
    const { pick } = preview;
    if (pick.previewGroup != null) return resolveTarget?.(pick) ?? null;
    const ids = getPickableIds?.(pick.nodeId);
    const pointIndex = preview.trackById
      ? Array.isArray(ids)
        ? ids.indexOf(pick.pointId)
        : -1
      : pick.pointIndex;
    return { nodeId: pick.nodeId, pointsNodeId: pick.pointsNodeId, pointIndex };
  }

  function write(preview, world) {
    if (!world) return false;
    const target = targetFor(preview);
    const array =
      target && getBoundArray?.(String(target.pointsNodeId), "points");
    const values = array?.getData?.();
    const offset = target?.pointIndex * 3;
    if (
      !target ||
      target.pointIndex < 0 ||
      !values ||
      offset + 2 >= values.length ||
      (!preview.trackById &&
        preview.expectedLength !== null &&
        preview.expectedLength !== values.length)
    ) {
      remove(preview);
      return false;
    }
    if (
      preview.undo &&
      (preview.undo.array !== array ||
        preview.undo.values !== values ||
        preview.undo.offset !== offset)
    ) {
      restore(preview);
    }
    preview.expectedLength = values.length;
    if (!preview.undo) {
      preview.undo = {
        ...target,
        array,
        values,
        offset,
        confirmed: values.slice(offset, offset + 3),
      };
    }
    values.set(world, offset);
    array.modified?.();
    getInstance?.(String(target.pointsNodeId))?.modified?.();
    getInstance?.(target.nodeId)?.modified?.();
    preview.world = world.slice();
    requestRender?.();
    return true;
  }

  function start(payload) {
    if (current) remove(current);
    const pick = payload?.pick;
    if (!pick?.preview || pick.pointsNodeId == null) return false;
    // A regrab takes over that point's pending overlay and its authoritative
    // baseline. Other points keep their own pending release previews.
    const pending = [...previews].find((preview) => samePoint(preview, pick));
    if (pending) {
      current = pending;
      current.pick = pick;
      current.gestureId = payload.gesture_id;
      current.released = false;
      return true;
    }
    const ids = getPickableIds?.(String(pick.nodeId));
    current = {
      pick,
      gestureId: payload.gesture_id,
      released: false,
      trackById: Array.isArray(ids) && ids[pick.pointIndex] != null,
      world: null,
      expectedLength: null,
      undo: null,
    };
    previews.add(current);
    return true;
  }

  function move(payload) {
    if (!current) return false;
    const world = previewWorld(current, payload);
    if (current.pick.preview === "cloud" && !world) {
      restore(current);
      current.world = null;
      return false;
    }
    return write(current, world);
  }

  function beforeApply() {
    for (const preview of previews) restore(preview);
  }

  function reapply(message = null) {
    let changed = false;
    for (const preview of previews) {
      if (
        preview.released &&
        message?.commands?.some(
          (command) =>
            command.name === "pointer.drag.end" &&
            command.payload?.gesture_id === preview.gestureId,
        )
      ) {
        changed = remove(preview) || changed;
      } else if (preview.world) {
        changed = write(preview, preview.world) || changed;
      } else if (!targetFor(preview)) {
        remove(preview);
      }
    }
    return changed;
  }

  function release(payload) {
    if (!current) return;
    if (!payload?.cancelled) move(payload);
    if (!current) return;
    current.released = true;
    current = null;
  }

  function end() {
    for (const preview of previews) remove(preview);
  }

  return { start, move, beforeApply, reapply, release, end };
}
