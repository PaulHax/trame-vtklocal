// One public scene API shared by the owned-canvas and external-context views.

// The component contract both views declare. It has to match what useSceneSync
// emits and what the Python widget binds, and the two views present the same
// one, so it is stated once.
export const VIEW_EMITS = Object.freeze([
  "updated",
  "camera",
  "command",
  "onReady",
  "beforeSceneLoaded",
  "afterSceneLoaded",
  "messageApplied",
  "pointerEvent",
]);

export const VIEW_PROPS = Object.freeze({
  renderWindow: {
    type: Number,
    required: true,
  },
  tiles3dTexturePolicy: {
    type: String,
    default: "auto",
    validator: (value) => ["auto", "native", "rgba"].includes(value),
  },
  streamedMemoryBudgetBytes: {
    type: Number,
    default: null,
    validator: (value) =>
      value == null || (Number.isSafeInteger(value) && value > 0),
  },
  tiles3dQualityPolicy: {
    type: String,
    default: "adaptive",
    validator: (value) => ["adaptive", "fixed"].includes(value),
  },
  // The trame ref name this view is mounted under (e.g. "vtkMapView_map").
  // The Python widget sets it to the same value it uses for `ref`, so
  // consumers resolve the view via window.trameVtklocal.whenView(refName).
  viewKey: {
    type: String,
    default: null,
  },
  wsClient: {
    type: Object,
  },
});

export const COMMON_VIEW_API_KEYS = Object.freeze([
  "getQueueLength",
  "getRenderWindow",
  "getRenderer",
  "getRenderers",
  "setRenderedCamera",
  "getRenderedCamera",
  "enableCameraReports",
  "reportCamera",
  "beginCameraInteraction",
  "cameraInteraction",
  "endCameraInteraction",
  "recordHostFrame",
  "requestFrameIfNeeded",
  "onSceneApplied",
  "onPaintCompleted",
  "registerSceneGate",
  "retrySceneGate",
  "getAppliedCommand",
  "onCommand",
  "uploadTexture",
  "removeTexture",
  "pickAt",
  "pickCloudPoint",
  "setArmedCloudPick",
  "startTargetDrag",
  "emitTargetClick",
  "setPointerContext",
  "setEmitBackgroundClick",
  "setShouldGrab",
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

export default { VIEW_EMITS, VIEW_PROPS, COMMON_VIEW_API_KEYS, createViewApi };
