import vtkSynchronizableRenderWindow from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow";
import vtkObjectManager from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/ObjectManager";
import BehaviorManager from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/BehaviorManager";
import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import {
  cleanupRemovedRendererDependencies,
  isLiveInstance,
} from "./sync/syncUpdaters";

let preRenderSkippingRenderWindowUpdaterInstalled = false;

function installRenderWindowUpdaterSkippingPreRender() {
  if (preRenderSkippingRenderWindowUpdaterInstalled) {
    return;
  }

  // Override vtk.js's default vtkRenderWindow updater so async scene sync
  // does not issue the upstream pre-update render() call.
  const renderWindowUpdaterSkippingPreRender = (instance, state, context) => {
    if (!isLiveInstance(instance)) {
      return;
    }

    cleanupRemovedRendererDependencies(state, context);
    vtkObjectManager.genericUpdater(instance, state, context);
    BehaviorManager.applyBehaviors(instance, state, context);
  };

  vtkObjectManager.setTypeMapping(
    "vtkRenderWindow",
    vtkRenderWindow.newInstance,
    renderWindowUpdaterSkippingPreRender,
  );
  preRenderSkippingRenderWindowUpdaterInstalled = true;
}

export function createSyncContext(contextName, renderWindow) {
  installRenderWindowUpdaterSkippingPreRender();
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
