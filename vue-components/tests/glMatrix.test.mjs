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
  for (const fn of ["targetTo", "invert", "multiply"]) {
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

// The map-camera view-up: bearing -> pitch -> roll applied to MapLibre north-up.
const ORIGIN = [0, 0, 0];
function newComputeViewUp(transform) {
  const up = new Float64Array([0, -1, 0]);
  vec3.rotateZ(up, up, ORIGIN, transform.bearingInRadians);
  vec3.rotateX(up, up, ORIGIN, -transform.pitchInRadians);
  vec3.rotateZ(up, up, ORIGIN, transform.rollInRadians);
  vec3.normalize(up, up);
  return [up[0], up[1], up[2]];
}

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

// The map-camera pipeline: the camera-to-world matrix from targetTo, the view
// matrix as its inverse, and the projection decomposition reusing the
// camera-to-world matrix directly.
function newPipeline(transform, eye, center, B, P) {
  const viewUp = newComputeViewUp(transform);
  const inverseLook = mat4.targetTo(new Float64Array(16), eye, center, viewUp);
  const look = mat4.invert(new Float64Array(16), inverseLook);
  const view = mat4.multiply(new Float64Array(16), look, B);
  const proj = mat4.multiply(new Float64Array(16), P, inverseLook);
  return { viewUp, look, inverseLook, view, proj };
}

const TRANSFORM = {
  bearingInRadians: 0.6,
  pitchInRadians: 0.5,
  rollInRadians: 0.1,
};
// Stand-ins for localEnuToMercator (B) and a MapLibre projection (P), both
// column-major like the real matrices.
const B = [2e-6, 0, 0, 0, 0, -2e-6, 0, 0, 0, 0, 3e-6, 0, 0.5, 0.5, 0.001, 1];
const P = [1.2, 0, 0, 0, 0, 1.5, 0, 0, 0.1, 0.2, -1.001, -1, 0, 0, -0.2, 0];


test("look-at pipeline survives sub-epsilon eye-center spans (close zoom)", () => {
  // A nadir camera ~19 m above its target in normalized-Mercator units:
  // every |eye - center| component is below gl-matrix's 1e-6 EPSILON, the
  // regime where mat4.lookAt silently returns the identity matrix.
  const eye = [0.5, 0.50002, 6e-7];
  const center = [0.5, 0.50002, 0.0];

  const newOut = newPipeline(TRANSFORM, eye, center, B, P);

  // Document the trap this test exists to block: mat4.lookAt degenerates
  // to identity here, so it must never rejoin the pipeline.
  const viewUp = newComputeViewUp(TRANSFORM);
  const bailed = mat4.lookAt(new Float64Array(16), eye, center, viewUp);
  assertClose(bailed, mat4.identity(new Float64Array(16)), "lookAt identity bail");
  assert.ok(
    Math.abs(bailed[12] - newOut.look[12]) > 0.1,
    "identity bail diverges from the real view matrix",
  );
});
