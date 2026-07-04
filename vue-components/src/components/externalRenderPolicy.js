// External-context render policy: what a host (e.g. MapLibre) needs around a
// vtk.js render into its WebGL context. Kept as a pure helper so it can be
// unit tested without a live WebGL context or a mounted component.
//
// Options:
//   clearDepth: true -> wipe the shared depth buffer to 1.0 before rendering.
//     MapLibre's 3D style layers leave depth in the shared WebGL buffer; VTK
//     should overlay the map color, not inherit basemap building depth that
//     punches holes through footprints/lines. vtk.js resetGLState sets the
//     clearDepth value but never issues gl.clear(), so the host must clear.
//
// No GL state is saved or restored here. Every gl.getParameter readback is a
// synchronous CPU/GPU stall, and MapLibre re-establishes its own tracked
// state after every custom-layer render (context.setDirty() +
// painter.setBaseState()), so a save/restore would be both slow and
// redundant.
export function applyExternalRenderPolicy(gl, render, options = {}) {
  const { clearDepth = true } = options;

  if (!gl) {
    render();
    return;
  }

  if (clearDepth) {
    gl.depthMask(true);
    gl.clearDepth(1.0);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }
  render();
}
