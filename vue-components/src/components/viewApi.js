// One public scene API shared by the owned-canvas and external-context views.

export const COMMON_VIEW_API_KEYS = Object.freeze([
  "requestResync",
  "getQueueLength",
  "getRenderWindow",
  "getRenderer",
  "getRenderers",
  "setCamera",
  "setRenderedCamera",
  "getRenderedCamera",
  "resetCamera",
  "enableCameraReports",
  "reportCamera",
  "beginCameraInteraction",
  "cameraInteraction",
  "endCameraInteraction",
  "recordHostFrame",
  "onSceneApplied",
  "onCommand",
  "getInstance",
  "getSeq",
  "uploadTexture",
  "pickAt",
  "pickCloudPoint",
  "startTargetDrag",
  "emitTargetClick",
  "setPointerContext",
  "setEmitBackgroundClick",
  "setShouldGrab",
  "setHoverEnabled",
  "getSyncDiagnostics",
  "getAppliedSceneState",
]);

export function createViewApi(scene, backend = {}) {
  const api = {};
  for (const key of COMMON_VIEW_API_KEYS) {
    api[key] = scene[key];
  }
  return Object.assign(api, backend);
}

export default { COMMON_VIEW_API_KEYS, createViewApi };
