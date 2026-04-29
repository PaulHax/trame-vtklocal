import vtkSynchronizableRenderWindow from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow";
import vtkObjectManager from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/ObjectManager";
import BehaviorManager from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/BehaviorManager";
import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import {
  cleanupRemovedRendererDependencies,
  isLiveInstance,
} from "./sync/syncUpdaters";

let preRenderSkippingRenderWindowUpdaterInstalled = false;
const SYNC_ARRAY_CACHE_KEY = "__trameVtkLocalSyncArrayCache";

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

export async function normalizeFetchedArrayContent(content) {
  if (content?.arrayBuffer) {
    return await content.arrayBuffer();
  }
  if (content instanceof Uint8Array) {
    return content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    );
  }
  if (content instanceof ArrayBuffer) {
    return content;
  }
  return content;
}

export function createFetchArray(client) {
  const session = client.getConnection().getSession();

  return async function fetchArray(hash) {
    const content = await session.call("vtkjs.get.array", [hash, null]);
    return normalizeFetchedArrayContent(content);
  };
}

export function createFetchArrays(client) {
  const session = client.getConnection().getSession();

  return async function fetchArrays(hashes) {
    const results = new Map();
    const response = await session.call("vtkjs.get.arrays", [hashes, null]);

    await Promise.all(
      (response || []).map(async ({ hash, content }) => {
        results.set(hash, await normalizeFetchedArrayContent(content));
      }),
    );

    return results;
  };
}

// Polyfill cacheArray/getCachedArray on a synchronizer context so the push
// prefetch path and synchronizeSync's validator/updater share arrays — including
// zero-length arrays, which otherwise stall a full-scene load when the underlying
// context doesn't expose working cache methods.
export function installSyncArrayCache(synchronizerContext) {
  if (!synchronizerContext || synchronizerContext[SYNC_ARRAY_CACHE_KEY]) {
    return synchronizerContext;
  }

  const arrayCache = new Map();
  const originalCacheArray =
    typeof synchronizerContext.cacheArray === "function"
      ? synchronizerContext.cacheArray.bind(synchronizerContext)
      : null;
  const originalGetCachedArray =
    typeof synchronizerContext.getCachedArray === "function"
      ? synchronizerContext.getCachedArray.bind(synchronizerContext)
      : null;
  const originalEmptyCachedArrays =
    typeof synchronizerContext.emptyCachedArrays === "function"
      ? synchronizerContext.emptyCachedArrays.bind(synchronizerContext)
      : null;
  const originalFreeOldArrays =
    typeof synchronizerContext.freeOldArrays === "function"
      ? synchronizerContext.freeOldArrays.bind(synchronizerContext)
      : null;

  Object.defineProperty(synchronizerContext, SYNC_ARRAY_CACHE_KEY, {
    value: arrayCache,
    enumerable: false,
  });

  const getActiveViewId = (context = synchronizerContext) =>
    context?.getActiveViewId?.() || "default";
  const getMTime = (
    context = synchronizerContext,
    viewId = getActiveViewId(context),
  ) => context?.getMTime?.(viewId) || 0;

  synchronizerContext.cacheArray = (
    hash,
    values,
    context = synchronizerContext,
  ) => {
    const result = originalCacheArray
      ? originalCacheArray(hash, values, context)
      : values;

    if (!hash || !values) {
      return result;
    }

    const viewId = getActiveViewId(context);
    const entry = arrayCache.get(hash) || { mtimes: {} };
    entry.values = values;
    entry.mtimes[viewId] = getMTime(context, viewId);
    arrayCache.set(hash, entry);
    return result;
  };

  synchronizerContext.getCachedArray = (
    hash,
    context = synchronizerContext,
  ) => {
    const entry = arrayCache.get(hash);
    if (entry) {
      const viewId = getActiveViewId(context);
      entry.mtimes[viewId] = getMTime(context, viewId);
      return entry.values || null;
    }

    return originalGetCachedArray
      ? originalGetCachedArray(hash, context)
      : null;
  };

  synchronizerContext.emptyCachedArrays = (...args) => {
    originalEmptyCachedArrays?.(...args);
    arrayCache.clear();
  };

  synchronizerContext.freeOldArrays = (
    threshold,
    context = synchronizerContext,
  ) => {
    originalFreeOldArrays?.(threshold, context);

    const viewId = getActiveViewId(context);
    const mtimeThreshold = getMTime(context, viewId) - threshold;
    arrayCache.forEach((entry, hash) => {
      const lastMTime = entry.mtimes[viewId];
      if (lastMTime !== undefined && lastMTime < mtimeThreshold) {
        arrayCache.delete(hash);
      }
    });
  };

  return synchronizerContext;
}

export function createSyncContext(client, contextName, renderWindow) {
  installRenderWindowUpdaterSkippingPreRender();
  const synchronizerContext =
    vtkSynchronizableRenderWindow.getSynchronizerContext(contextName);
  installSyncArrayCache(synchronizerContext);
  synchronizerContext.setFetchArrayFunction(createFetchArray(client));
  const syncRenderWindow = vtkSynchronizableRenderWindow.decorate(
    renderWindow,
    contextName,
  );
  return { synchronizerContext, syncRenderWindow };
}

export function createManagedSyncContext(client, contextName, renderWindow) {
  const { synchronizerContext, syncRenderWindow } = createSyncContext(
    client,
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

export function extractCameraParams(camera) {
  return {
    position: camera.getPosition(),
    focalPoint: camera.getFocalPoint(),
    viewUp: camera.getViewUp(),
    viewAngle: camera.getViewAngle(),
    parallelProjection: camera.getParallelProjection(),
    parallelScale: camera.getParallelScale(),
    clippingRange: camera.getClippingRange(),
  };
}

export function applyCameraParams(camera, params) {
  if (params.position) camera.setPosition(...params.position);
  if (params.focalPoint) camera.setFocalPoint(...params.focalPoint);
  if (params.viewUp) camera.setViewUp(...params.viewUp);
  if (params.viewAngle !== undefined) camera.setViewAngle(params.viewAngle);
  if (params.parallelProjection !== undefined)
    camera.setParallelProjection(params.parallelProjection);
  if (params.parallelScale !== undefined)
    camera.setParallelScale(params.parallelScale);
  if (params.clippingRange) camera.setClippingRange(...params.clippingRange);
}
