import vtkSynchronizableRenderWindow from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow";
// Registers vtkProjectedTextureMapper with the scene graph and the state-sync
// type mapping on import so serialized scenes can carry the type.
import "./projectedTextureMapper";

export function isLiveInstance(instance) {
  return (
    !!instance &&
    !(typeof instance.isDeleted === "function" && instance.isDeleted())
  );
}

export function createSyncContext(contextName, renderWindow) {
  const synchronizerContext =
    vtkSynchronizableRenderWindow.getSynchronizerContext(contextName);
  const syncRenderWindow = vtkSynchronizableRenderWindow.decorate(
    renderWindow,
    contextName,
  );
  return { synchronizerContext, syncRenderWindow };
}

export function createManagedSyncContext(contextName, renderWindow) {
  const { synchronizerContext, syncRenderWindow } = createSyncContext(
    contextName,
    renderWindow,
  );

  return {
    synchronizerContext,
    syncRenderWindow,
    cleanup() {
      cleanupSyncContext(contextName);
    },
  };
}

function getRenderWindowRenderers(renderWindow, methodName = "getRenderers") {
  if (!isLiveInstance(renderWindow)) {
    return [];
  }

  try {
    const renderers = renderWindow[methodName]?.();
    if (!Array.isArray(renderers)) {
      return [];
    }

    return renderers.filter((renderer) => isLiveInstance(renderer));
  } catch {
    return [];
  }
}

export function getSyncedRenderers(renderWindow) {
  return getRenderWindowRenderers(renderWindow).filter(
    (ren) =>
      ren.get("remoteId")?.remoteId !== undefined ||
      ren.get("managedInstanceId")?.managedInstanceId !== undefined,
  );
}

export function getFirstSyncedRenderer(renderWindow) {
  return getSyncedRenderers(renderWindow)[0] || null;
}

export function getPrimaryRenderer(renderWindow) {
  return (
    getFirstSyncedRenderer(renderWindow) ||
    getRenderWindowRenderers(renderWindow, "getRenderersByReference")[0] ||
    null
  );
}

export function cleanupSyncContext(contextName) {
  vtkSynchronizableRenderWindow.clearSynchronizerContext(contextName);
}

const CAMERA_FIELDS = [
  { name: "position", getter: "getPosition", setter: "setPosition", spread: true },
  { name: "focalPoint", getter: "getFocalPoint", setter: "setFocalPoint", spread: true },
  { name: "viewUp", getter: "getViewUp", setter: "setViewUp", spread: true },
  { name: "viewAngle", getter: "getViewAngle", setter: "setViewAngle", spread: false },
  { name: "parallelProjection", getter: "getParallelProjection", setter: "setParallelProjection", spread: false },
  { name: "parallelScale", getter: "getParallelScale", setter: "setParallelScale", spread: false },
  { name: "clippingRange", getter: "getClippingRange", setter: "setClippingRange", spread: true },
];

export function extractCameraParams(camera) {
  const params = {};
  for (const { name, getter } of CAMERA_FIELDS) {
    params[name] = camera[getter]();
  }
  return params;
}

export function applyCameraParams(camera, params) {
  for (const { name, setter, spread } of CAMERA_FIELDS) {
    const value = params[name];
    if (value === undefined) continue;
    if (spread) {
      if (value) camera[setter](...value);
    } else {
      camera[setter](value);
    }
  }
}
