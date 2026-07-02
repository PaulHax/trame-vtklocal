// Re-export gl-matrix's `mat4`/`vec3` from the copy vtk.js already bundles, and
// publish them on the shared `window.trameVtklocal` namespace (the same place
// the view registry lives). Modules that load the fork bundle but are served
// separately — notably the map's vanilla `map_init.js`, which has no build step
// — reach gl-matrix via `window.trameVtklocal.glMatrix` instead of hand-rolling
// lookAt / invert / multiply. The bare "gl-matrix" import resolves to vtk.js's
// dependency through the build + test alias, so no new package is added.
import { mat4, vec3 } from "gl-matrix";

export { mat4, vec3 };

const GLOBAL_KEY = "trameVtklocal";

function globalScope() {
  if (typeof window !== "undefined") return window;
  if (typeof globalThis !== "undefined") return globalThis;
  return {};
}

// Attach `{ mat4, vec3 }` alongside the view registry without clobbering it.
export function exposeGlMatrix() {
  const scope = globalScope();
  const ns = (scope[GLOBAL_KEY] = scope[GLOBAL_KEY] || {});
  ns.glMatrix = { mat4, vec3 };
  return ns.glMatrix;
}

exposeGlMatrix();
