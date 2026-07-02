import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

let mat4;
let vec3;

before(async () => {
  const mod = await loadModule("/src/glMatrix.js");
  mat4 = mod.mat4;
  vec3 = mod.vec3;
});

after(async () => {
  await closeModuleLoader();
});

// --- gl-matrix passthrough is exposed --------------------------------------

test("exports the gl-matrix mat4/vec3 helpers used by the map camera math", () => {
  for (const fn of ["lookAt", "invert", "multiply"]) {
    assert.equal(typeof mat4[fn], "function", `mat4.${fn}`);
  }
  for (const fn of ["rotateZ", "rotateX", "normalize"]) {
    assert.equal(typeof vec3[fn], "function", `vec3.${fn}`);
  }
});

test("publishes { mat4, vec3 } on the shared trameVtklocal namespace", () => {
  const ns = globalThis.trameVtklocal;
  assert.ok(ns && ns.glMatrix, "window.trameVtklocal.glMatrix is set");
  assert.equal(ns.glMatrix.mat4, mat4);
  assert.equal(ns.glMatrix.vec3, vec3);
});

// --- regression: gl-matrix reproduces the deleted hand-rolled matrix math ---
//
// map_init.js and video_projection.js used to hand-roll computeViewUp,
// mat4LookAt, mat4Invert, and multiplyMatrices. Those originals are copied
// verbatim below (the numeric safety net for chunk A7) so we can assert the
// gl-matrix passthrough produces the same view/projection matrices for a known
// MapLibre-camera transform. Watch items baked in here: gl-matrix's arg order
// (out first), its column-major layout, and its default Float32Array
// ARRAY_TYPE — the new computeViewUp keeps a Float64Array temp so precision
// matches the old plain-number math.

const MAPLIBRE_NORTH_UP = [0, -1, 0];

function oldComputeViewUp(transform) {
  let ux = MAPLIBRE_NORTH_UP[0],
    uy = MAPLIBRE_NORTH_UP[1],
    uz = MAPLIBRE_NORTH_UP[2];
  const cb = Math.cos(transform.bearingInRadians),
    sb = Math.sin(transform.bearingInRadians);
  let nx = cb * ux - sb * uy,
    ny = sb * ux + cb * uy,
    nz = uz;
  ux = nx;
  uy = ny;
  uz = nz;
  const cp = Math.cos(-transform.pitchInRadians),
    sp = Math.sin(-transform.pitchInRadians);
  nx = ux;
  ny = cp * uy - sp * uz;
  nz = sp * uy + cp * uz;
  ux = nx;
  uy = ny;
  uz = nz;
  const cr = Math.cos(transform.rollInRadians),
    sr = Math.sin(transform.rollInRadians);
  nx = cr * ux - sr * uy;
  ny = sr * ux + cr * uy;
  nz = uz;
  ux = nx;
  uy = ny;
  uz = nz;
  const len = Math.sqrt(ux * ux + uy * uy + uz * uz);
  return [ux / len, uy / len, uz / len];
}

function oldLookAt(out, eye, center, up) {
  const ex = eye[0],
    ey = eye[1],
    ez = eye[2];
  let fx = center[0] - ex,
    fy = center[1] - ey,
    fz = center[2] - ez;
  let len = Math.sqrt(fx * fx + fy * fy + fz * fz);
  if (len > 0) {
    fx /= len;
    fy /= len;
    fz /= len;
  }
  let sx = fy * up[2] - fz * up[1];
  let sy = fz * up[0] - fx * up[2];
  let sz = fx * up[1] - fy * up[0];
  len = Math.sqrt(sx * sx + sy * sy + sz * sz);
  if (len > 0) {
    sx /= len;
    sy /= len;
    sz /= len;
  }
  const ux = sy * fz - sz * fy;
  const uy = sz * fx - sx * fz;
  const uz = sx * fy - sy * fx;
  out[0] = sx;
  out[1] = ux;
  out[2] = -fx;
  out[3] = 0;
  out[4] = sy;
  out[5] = uy;
  out[6] = -fy;
  out[7] = 0;
  out[8] = sz;
  out[9] = uz;
  out[10] = -fz;
  out[11] = 0;
  out[12] = -(sx * ex + sy * ey + sz * ez);
  out[13] = -(ux * ex + uy * ey + uz * ez);
  out[14] = fx * ex + fy * ey + fz * ez;
  out[15] = 1;
  return out;
}

function oldInvert(out, a) {
  const a00 = a[0],
    a01 = a[1],
    a02 = a[2],
    a03 = a[3],
    a10 = a[4],
    a11 = a[5],
    a12 = a[6],
    a13 = a[7],
    a20 = a[8],
    a21 = a[9],
    a22 = a[10],
    a23 = a[11],
    a30 = a[12],
    a31 = a[13],
    a32 = a[14],
    a33 = a[15];
  const b00 = a00 * a11 - a01 * a10,
    b01 = a00 * a12 - a02 * a10,
    b02 = a00 * a13 - a03 * a10,
    b03 = a01 * a12 - a02 * a11,
    b04 = a01 * a13 - a03 * a11,
    b05 = a02 * a13 - a03 * a12,
    b06 = a20 * a31 - a21 * a30,
    b07 = a20 * a32 - a22 * a30,
    b08 = a20 * a33 - a23 * a30,
    b09 = a21 * a32 - a22 * a31,
    b10 = a21 * a33 - a23 * a31,
    b11 = a22 * a33 - a23 * a32;
  let det =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1.0 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

function oldMultiply(a, b) {
  const r = new Float64Array(16);
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      let s = 0;
      for (let k = 0; k < 4; k += 1) s += a[i + k * 4] * b[k + j * 4];
      r[i + j * 4] = s;
    }
  }
  return r;
}

// The new computeViewUp that replaces the hand-rolled one in map_init.js.
const ORIGIN = [0, 0, 0];
function newComputeViewUp(transform) {
  const up = new Float64Array([0, -1, 0]);
  vec3.rotateZ(up, up, ORIGIN, transform.bearingInRadians);
  vec3.rotateX(up, up, ORIGIN, -transform.pitchInRadians);
  vec3.rotateZ(up, up, ORIGIN, transform.rollInRadians);
  vec3.normalize(up, up);
  return [up[0], up[1], up[2]];
}

// Numeric anchors captured from the OLD implementations before deletion.
const OLD = {
  viewUp: [
    0.6341309709095448, -0.6643114722435717, 0.39568697170730366,
  ],
  lookAt: [
    -0.7512207286577715, 0.6075273826721117, 0.2580269290955118, 0,
    -0.4080900320724331, -0.7347475782555016, 0.5418565511007466, 0,
    0.5187773535516053, 0.301755655375751, 0.7998834801961745, 0,
    0.5796553803651022, 0.06361009779169496, -0.40032929654563076, 1,
  ],
  viewMatrix: [
    -0.0000015024414573155428, 0.0000012150547653442233, 5.160538581910235e-7,
    0, 8.161800641448662e-7, 0.0000014694951565110032, -0.0000010837131022014932,
    0, 0.0000015563320606548158, 9.05266966127253e-7, 0.0000023996504405885234,
    0, 0.0005187773535515472, 0.00030175565537575444, 0.0004123270326946149, 1,
  ],
  invLookAt: [
    -0.7512207286577718, -0.40809003207243333, 0.5187773535516054, 0,
    0.6075273826721118, -0.7347475782555017, 0.30175565537575105, 0,
    0.2580269290955119, 0.5418565511007466, 0.7998834801961745, 0,
    0.5001000000000001, 0.5002100000000002, 0.00031000000000008804,
    1.0000000000000002,
  ],
  projectionMatrix: [
    -0.8495871390341656, -0.508379577398329, -0.5192961309051569,
    -0.5187773535516054, 0.7592084247441092, -1.0417702363081025,
    -0.30205741103112677, -0.30175565537575105, 0.3896206629342317,
    0.9727615226903549, -0.8006833636763706, -0.7998834801961745,
    0.6001510000000001, 0.7503770000000003, -0.20031031000000016,
    -0.00031000000000008804,
  ],
};

function assertClose(actual, expected, label, tol = 1e-9) {
  assert.equal(actual.length, expected.length, `${label} length`);
  let maxDiff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    maxDiff = Math.max(maxDiff, Math.abs(actual[i] - expected[i]));
  }
  assert.ok(
    maxDiff <= tol,
    `${label}: maxDiff ${maxDiff.toExponential(3)} > tol ${tol}`,
  );
}

test("gl-matrix reproduces the deleted map-camera matrix pipeline", () => {
  const transform = {
    bearingInRadians: 0.6,
    pitchInRadians: 0.5,
    rollInRadians: 0.1,
  };
  const eye = [0.5001, 0.50021, 0.00031];
  const center = [0.5, 0.5, 0.0];
  // Stand-ins for localEnuToMercator (B) and a MapLibre projection (P), both
  // column-major like the real matrices.
  const B = [
    2e-6, 0, 0, 0, 0, -2e-6, 0, 0, 0, 0, 3e-6, 0, 0.5, 0.5, 0.001, 1,
  ];
  const P = [
    1.2, 0, 0, 0, 0, 1.5, 0, 0, 0.1, 0.2, -1.001, -1, 0, 0, -0.2, 0,
  ];

  // Old hand-rolled path.
  const oldViewUp = oldComputeViewUp(transform);
  const oldLook = oldLookAt(new Float64Array(16), eye, center, oldViewUp);
  const oldView = oldMultiply(oldLook, B);
  const oldInv = oldInvert(new Float64Array(16), oldLook);
  const oldProj = oldMultiply(P, oldInv);

  // New gl-matrix path (arg order: out first; multiply is a*b, column-major).
  const newViewUp = newComputeViewUp(transform);
  const newLook = mat4.lookAt(new Float64Array(16), eye, center, newViewUp);
  const newView = mat4.multiply(new Float64Array(16), newLook, B);
  const newInv = mat4.invert(new Float64Array(16), newLook);
  const newProj = mat4.multiply(new Float64Array(16), P, newInv);

  // gl-matrix path matches the freshly recomputed old path...
  assertClose(newViewUp, oldViewUp, "viewUp vs old-impl");
  assertClose(newLook, oldLook, "lookAt vs old-impl");
  assertClose(newView, oldView, "viewMatrix vs old-impl");
  assertClose(newInv, oldInv, "invLookAt vs old-impl");
  assertClose(newProj, oldProj, "projectionMatrix vs old-impl");

  // ...and the captured numeric anchors, guarding against silent drift.
  assertClose(newViewUp, OLD.viewUp, "viewUp vs captured", 1e-9);
  assertClose(newLook, OLD.lookAt, "lookAt vs captured", 1e-9);
  assertClose(newView, OLD.viewMatrix, "viewMatrix vs captured", 1e-9);
  assertClose(newInv, OLD.invLookAt, "invLookAt vs captured", 1e-9);
  assertClose(newProj, OLD.projectionMatrix, "projectionMatrix vs captured", 1e-9);
});
