// Shared-context render policy: the state dance a host (e.g. MapLibre) needs
// around a vtk.js shared render. Kept as a pure helper so it can be unit
// tested without a live WebGL context or a mounted component.
//
// Options:
//   clearDepth: true -> wipe the shared depth buffer to 1.0 before rendering.
//     MapLibre's 3D style layers leave depth in the shared WebGL buffer; VTK
//     should overlay the map color, not inherit basemap building depth that
//     punches holes through footprints/lines. vtk.js resetGLState sets the
//     clearDepth value but never issues gl.clear(), so the host must clear.
//
// vtk.js renders with its own winding (resetGLState forces CCW front faces),
// so the host's winding cannot be applied to the vtk render; it is saved
// before and restored after, since vtk.js leaves CCW behind.
export function applySharedRenderPolicy(gl, render, options = {}) {
  const { clearDepth = true } = options;

  if (!gl) {
    render();
    return;
  }

  const previousFrontFace = gl.getParameter(gl.FRONT_FACE);

  try {
    if (clearDepth) {
      gl.depthMask(true);
      gl.clearDepth(1.0);
      gl.clear(gl.DEPTH_BUFFER_BIT);
    }
    render();
  } finally {
    gl.frontFace(previousFrontFace);
  }
}
