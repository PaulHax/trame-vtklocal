// Shared-context render policy: the depth-clear + triangle-winding dance a host
// (e.g. MapLibre) needs around a vtk.js shared render. Kept as a pure helper so
// it can be unit tested without a live WebGL context or a mounted component.
//
// Options (both optional, defaults preserve the historical app behavior):
//   clearDepth: true  -> wipe the shared depth buffer to 1.0 before rendering.
//     MapLibre's 3D style layers leave depth in the shared WebGL buffer; VTK
//     should overlay the map color, not inherit basemap building depth that
//     punches holes through footprints/lines. vtk.js resetGLState sets the
//     clearDepth value but never issues gl.clear(), so the host must clear.
//   frontFace: "CW"   -> set the winding for the render, restoring the host's
//     previous winding afterward. Pass "CCW" for counter-clockwise, or a falsy
//     value to leave the winding untouched.
export function applySharedRenderPolicy(gl, render, options = {}) {
  const { clearDepth = true, frontFace = "CW" } = options;

  if (!gl) {
    render();
    return;
  }

  let previousFrontFace = null;
  if (frontFace) {
    previousFrontFace = gl.getParameter(gl.FRONT_FACE);
    gl.frontFace(frontFace === "CCW" ? gl.CCW : gl.CW);
  }

  try {
    if (clearDepth) {
      gl.depthMask(true);
      gl.clearDepth(1.0);
      gl.clear(gl.DEPTH_BUFFER_BIT);
    }
    render();
  } finally {
    if (previousFrontFace !== null) {
      gl.frontFace(previousFrontFace);
    }
  }
}
