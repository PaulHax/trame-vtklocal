// Optimistic point-drag overlay. The mirror continues to track server truth;
// this module rewrites only the rendered bound points array while a drag lives.

import { mat4 } from "../glMatrix";

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
  requestRender,
} = {}) {
  let active = null;

  function previewWorld(payload) {
    const pointer = payload?.pointer;
    const camera = getCamera?.();
    const metrics = getViewportMetrics?.();
    if (!pointer || !camera || !metrics) return null;
    const composite = camera.getCompositeProjectionMatrix?.(
      metrics.aspect,
      -1,
      1,
    );
    const inverse = composite && mat4.invert(new Float64Array(16), composite);
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
    const offset = active.pick.pointIndex * 3;
    if (!values || offset < 0 || offset + 2 >= values.length) {
      active = null;
      return false;
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
