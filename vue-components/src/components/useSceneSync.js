import vtkObjectManager from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/ObjectManager";

import {
  createManagedSyncContext,
  getPrimaryRenderer,
  applyCameraParams,
} from "./vtkJsSync";
import { withSyncCapability } from "./sync/syncCapability";
import {
  createPushSync,
  applyPartialArrayUpdate,
  applyPatchUpdate,
  bindPartialResultToCache as bindPartialResultToCacheDefault,
  getPartialUpdates,
} from "./pushSync";
import { createSyncController } from "./syncController";
import { dumpAppliedScene } from "./dumpAppliedScene";
import {
  createDistanceToCameraGlyphRegistry,
  describeDistanceToCameraGlyphRegistry,
  syncDistanceToCameraGlyphPatch,
  syncDistanceToCameraGlyphState,
  updateDistanceToCameraGlyphs,
} from "./distanceToCameraGlyphs";
import {
  createPickableRegistry,
  describePickableRegistry,
  getDevicePixelRatio,
  getViewportMetrics,
  pickAt as pickAtRegistry,
  syncPickablePatch,
  syncPickableState,
} from "./pickables";
import { createPickableGestures } from "./pickableGestures";
import { getExternalTextures, peekExternalTextures } from "./externalTextures";

export function useSceneSync(
  {
    client,
    emit,
    getRenderWindow,
    renderScene,
    beforeSync,
    finalizeSync,
    syncErrorLabel = "SceneSync",
  },
  dependencies = {},
) {
  const {
    applyPartialArrayUpdate:
      applyPartialArrayUpdateImpl = applyPartialArrayUpdate,
    applyPatchUpdate: applyPatchUpdateImpl = applyPatchUpdate,
    bindPartialResultToCache:
      bindPartialResultToCacheImpl = bindPartialResultToCacheDefault,
    createManagedSyncContext:
      createManagedSyncContextImpl = createManagedSyncContext,
    createPushSync: createPushSyncImpl = createPushSync,
    createSyncController: createSyncControllerImpl = createSyncController,
    vtkObjectManager: vtkObjectManagerImpl = vtkObjectManager,
    withSyncCapability: withSyncCapabilityImpl = withSyncCapability,
  } = dependencies;

  let managedSyncContext = null;
  let sync = null;
  let syncCapability = null;
  let pushCache = null;
  let disposed = false;
  let partialAppliedCallback = null;
  let messageAppliedCallback = null;
  const sceneAppliedCallbacks = new Set();
  let lastAppliedOp = null;
  let syncedRootId = null;
  let renderedCamera = null;
  const distanceToCameraGlyphs = createDistanceToCameraGlyphRegistry();
  const pickables = createPickableRegistry();

  function getRenderer() {
    return getPrimaryRenderer(getRenderWindow?.() || null);
  }

  function recordLastAppliedOp(message) {
    if (!message) return;
    const { kind, payload } = message;
    if (kind === "patch" && Array.isArray(payload?.ops) && payload.ops.length) {
      const lastOp = payload.ops[payload.ops.length - 1];
      lastAppliedOp = { kind: lastOp?.op || "patch" };
      if (lastOp?.id !== undefined) {
        lastAppliedOp.id = String(lastOp.id);
      }
      return;
    }
    lastAppliedOp = { kind: kind || "unknown" };
  }

  function noteMessageApplied(message) {
    if (!message) return;
    recordLastAppliedOp(message);
    sync?.markMessageApplied?.(message);
    messageAppliedCallback?.(message);
    sceneAppliedCallbacks.forEach((callback) => callback(message));
  }

  function onSceneApplied(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    sceneAppliedCallbacks.add(callback);
    return () => {
      sceneAppliedCallbacks.delete(callback);
    };
  }

  function getInstance(id) {
    if (id === undefined || id === null) return null;
    return (
      managedSyncContext?.synchronizerContext?.getInstance?.(String(id)) ?? null
    );
  }

  // Stage a texture source for this view's external-texture registry;
  // vtkProjectedTextureMapper instances resolve it by textureKey at render
  // time. Upload happens on the next render — triggering that render stays
  // the caller's job.
  function uploadTexture(key, source, options = {}) {
    const registry = getExternalTextures(getRenderWindow?.() || null);
    if (!registry || key == null) {
      return false;
    }
    registry.setSource(key, source, options);
    return true;
  }

  function requestResync(reason = "scene-sync") {
    sync?.requestResync?.(reason);
  }

  function getQueueLength() {
    return sync?.getQueueLength?.() ?? 0;
  }

  function setCamera(params) {
    const camera = getRenderer()?.getActiveCamera?.();
    if (!camera) return;
    applyCameraParams(camera, params);
    renderScene?.();
  }

  function matrixCopy16(value) {
    if (!value || value.length !== 16) return null;
    const copy = Array.from(value, Number);
    return copy.every((v) => Number.isFinite(v)) ? copy : null;
  }

  function setRenderedCamera({
    viewMatrix,
    projectionMatrix,
    clippingRange,
    physicalScale,
  } = {}) {
    const camera = getRenderer()?.getActiveCamera?.();
    const recordedViewMatrix = matrixCopy16(viewMatrix);
    const recordedProjectionMatrix = matrixCopy16(projectionMatrix);
    if (!camera || !recordedViewMatrix || !recordedProjectionMatrix)
      return false;

    renderedCamera = {
      viewMatrix: recordedViewMatrix,
      projectionMatrix: recordedProjectionMatrix,
    };
    camera.setViewMatrix(recordedViewMatrix.slice());
    camera.setProjectionMatrix(recordedProjectionMatrix.slice());
    if (
      Array.isArray(clippingRange) &&
      clippingRange.length >= 2 &&
      Number.isFinite(clippingRange[0]) &&
      Number.isFinite(clippingRange[1]) &&
      clippingRange[1] > clippingRange[0]
    ) {
      camera.setClippingRange?.(clippingRange[0], clippingRange[1]);
    }
    if (Number.isFinite(physicalScale)) {
      camera.setPhysicalScale?.(physicalScale);
    }
    camera.modified?.();
    return true;
  }

  function getRenderedCamera() {
    if (!renderedCamera) return null;
    const rendererViewport = getRenderer()?.getViewport?.();
    const views = getRenderWindow?.()?.getViews?.() || [];
    const view = views.length > 0 ? views[0] : null;
    const size = view?.getSize?.();
    return {
      viewMatrix: renderedCamera.viewMatrix.slice(),
      projectionMatrix: renderedCamera.projectionMatrix.slice(),
      rendererViewport: rendererViewport
        ? Array.from(rendererViewport, Number)
        : null,
      size: size ? Array.from(size, Number) : null,
    };
  }

  function resetCamera() {
    const renderer = getRenderer();
    if (!renderer) return;
    renderer.resetCamera();
    renderScene?.();
  }

  function bindPartialResultToCache(partialUpdate, syncCtx) {
    bindPartialResultToCacheImpl(partialUpdate, syncCtx, pushCache);
  }

  function applyArrayPartialMessage(message, syncCtx) {
    const payload = message?.payload || message;
    const updates = getPartialUpdates(payload);
    const appliedUpdates = [];

    for (const update of updates) {
      if (sync?.validatePartialUpdate && !sync.validatePartialUpdate(update)) {
        return { didApply: appliedUpdates.length > 0, failed: true };
      }

      const applied = applyPartialArrayUpdateImpl(update, syncCtx);
      if (!applied) {
        requestResync("partial-message-apply-failed");
        partialAppliedCallback?.(update, syncCtx, false);
        return { didApply: appliedUpdates.length > 0, failed: true };
      }

      bindPartialResultToCache(update, syncCtx);
      appliedUpdates.push(update);
    }

    const extra =
      payload?.extra ?? (updates.length === 1 ? updates[0]?.extra : undefined);
    if (extra) {
      emit?.("viewStateExtra", extra);
    }

    appliedUpdates.forEach((update) => {
      partialAppliedCallback?.(update, syncCtx, true);
    });

    return { didApply: appliedUpdates.length > 0, failed: false };
  }

  function applyPatchMessage(message, syncCtx) {
    const payload = message?.payload || message;
    const applied = applyPatchUpdateImpl(
      payload,
      syncCtx,
      vtkObjectManagerImpl,
      pushCache,
    );
    if (!applied) {
      requestResync("patch-apply-failed");
      return { didApply: false, failed: true };
    }

    if (payload?.extra) {
      emit?.("viewStateExtra", payload.extra);
    }

    return {
      didApply: true,
      failed: false,
    };
  }

  function applyQueuedStateSyncResult({
    emitLifecycle = true,
    emitUpdated = true,
  } = {}) {
    if (!syncCapability) {
      return { status: "idle", didSync: false };
    }
    return applyQueuedOrderedMessages({ emitLifecycle, emitUpdated });
  }

  function applyQueuedOrderedMessages({
    emitLifecycle = true,
    emitUpdated = true,
  } = {}) {
    let synced = false;
    let didApply = false;
    let emittedLifecycleStart = false;
    let message = sync?.takeNextMessage?.();

    if (!message) {
      return {
        status: getQueueLength() > 0 ? "blocked" : "idle",
        didSync: false,
      };
    }

    while (message) {
      if (message.kind === "full") {
        if (emitLifecycle && !emittedLifecycleStart) {
          emit?.("beforeSceneLoaded");
          emittedLifecycleStart = true;
        }

        try {
          if (syncCapability(message.payload, true)) {
            syncDistanceToCameraGlyphState(
              message.payload,
              managedSyncContext?.synchronizerContext,
              distanceToCameraGlyphs,
              { reset: true },
            );
            syncPickableState(
              message.payload,
              managedSyncContext?.synchronizerContext,
              pickables,
              { reset: true },
            );
            synced = true;
          }
        } catch (error) {
          console.warn(`[${syncErrorLabel}] Resync needed:`, error.message);
          requestResync("full-state-apply-exception");
          if (emitLifecycle && emittedLifecycleStart) {
            emit?.("afterSceneLoaded");
          }
          return { status: "failed", didSync: false };
        }

        if (message.payload?.extra) {
          emit?.("viewStateExtra", message.payload.extra);
        }
        noteMessageApplied(message);
        didApply = true;
      } else if (message.kind === "arrayPartial") {
        const resolvedSyncContext = managedSyncContext?.synchronizerContext;
        if (!resolvedSyncContext) {
          requestResync("missing-sync-context-for-partial");
          return { status: "failed", didSync: false };
        }

        const partialResult = applyArrayPartialMessage(
          message,
          resolvedSyncContext,
        );
        if (partialResult.failed) {
          return { status: "failed", didSync: synced };
        }
        noteMessageApplied(message);
        didApply = didApply || partialResult.didApply;
      } else if (message.kind === "patch") {
        const resolvedSyncContext = managedSyncContext?.synchronizerContext;
        if (!resolvedSyncContext) {
          requestResync("missing-sync-context-for-patch");
          return { status: "failed", didSync: false };
        }

        const patchResult = applyPatchMessage(message, resolvedSyncContext);
        if (patchResult.failed) {
          return { status: "failed", didSync: synced };
        }
        syncDistanceToCameraGlyphPatch(
          message.payload,
          resolvedSyncContext,
          distanceToCameraGlyphs,
        );
        syncPickablePatch(message.payload, resolvedSyncContext, pickables);
        noteMessageApplied(message);
        didApply = didApply || patchResult.didApply;
      } else {
        console.warn(
          `[${syncErrorLabel}] Unknown push message kind`,
          message.kind,
        );
        requestResync("unknown-message-kind");
        return { status: "failed", didSync: synced };
      }

      message = sync?.takeNextMessage?.();
    }

    if (didApply) {
      updateDistanceToCameraGlyphsForRender();
    }

    if (synced && emitUpdated) {
      emit?.("updated");
    }

    if (emitLifecycle && emittedLifecycleStart) {
      emit?.("afterSceneLoaded");
    }

    return {
      status: getQueueLength() > 0 ? "blocked" : didApply ? "applied" : "idle",
      didSync: synced,
    };
  }

  function applyQueuedStateSync(options = {}) {
    return applyQueuedStateSyncResult(options).didSync;
  }

  const updateController = createSyncControllerImpl({
    canSync: () => !disposed && !!sync && !!getRenderWindow?.(),
    synchronize() {
      return applyQueuedStateSync({ emitLifecycle: false, emitUpdated: false });
    },
    beforeSync() {
      emit?.("beforeSceneLoaded");
      return beforeSync?.();
    },
    onSynced() {
      emit?.("updated");
    },
    afterSync() {
      emit?.("afterSceneLoaded");
    },
    onError(error) {
      console.error(`${syncErrorLabel}: synchronize error`, error);
      requestResync("sync-controller-failed");
    },
    finalizeSync(syncContext) {
      finalizeSync?.(syncContext);
    },
  });

  function update() {
    return updateController.requestSync();
  }

  function cleanupSyncContext() {
    sync?.cleanup?.();
    sync = null;
    syncCapability = null;
    pushCache = null;
    partialAppliedCallback = null;
    messageAppliedCallback = null;
    lastAppliedOp = null;
    syncedRootId = null;
    distanceToCameraGlyphs.clear();
    pickables.clear();
    managedSyncContext?.cleanup?.();
    managedSyncContext = null;
  }

  function initialize({
    contextName,
    renderWindowId,
    onStateReceived,
    onQueueReady,
    onPartialApplied,
    onMessageApplied,
  }) {
    disposed = false;
    cleanupSyncContext();
    partialAppliedCallback = onPartialApplied || null;
    messageAppliedCallback = onMessageApplied || null;
    syncedRootId = renderWindowId !== undefined ? String(renderWindowId) : null;

    managedSyncContext = createManagedSyncContextImpl(
      contextName,
      getRenderWindow(),
    );

    const { synchronizerContext, syncRenderWindow } = managedSyncContext;
    const rwId = String(renderWindowId);
    pushCache = new Map();

    syncCapability = withSyncCapabilityImpl(
      syncRenderWindow,
      synchronizerContext,
      vtkObjectManagerImpl,
      pushCache,
    );
    sync = createPushSyncImpl(
      client,
      syncRenderWindow,
      synchronizerContext,
      rwId,
      pushCache,
      {
        onStateReceived(deltaState) {
          onStateReceived?.(deltaState);
        },
        onQueueReady() {
          onQueueReady?.();
        },
      },
    );
  }

  function cleanup() {
    disposed = true;
    // Force-end any drag in flight so its window listeners and pointer capture
    // don't outlive the view.
    gestures.teardown();
    // The GL context is shared across views and outlives this one, so its
    // textures must be deleted explicitly, before the render window goes away.
    peekExternalTextures(getRenderWindow?.() || null)?.clear();
    cleanupSyncContext();
    sceneAppliedCallbacks.clear();
  }

  function getSyncDiagnostics() {
    const { epoch = null, lastSeq = 0 } = sync?.getDiagnostics?.() ?? {};
    let pushCacheSize = 0;
    let pushCacheBytes = 0;
    if (pushCache) {
      pushCacheSize = pushCache.size;
      for (const value of pushCache.values()) {
        if (value && typeof value.byteLength === "number") {
          pushCacheBytes += value.byteLength;
        }
      }
    }
    return {
      lastSeq,
      lastEpoch: epoch,
      queueLength: getQueueLength(),
      lastAppliedOp,
      syncedRootId,
      pushCacheSize,
      pushCacheBytes,
      distanceToCamera: describeDistanceToCameraGlyphRegistry(
        distanceToCameraGlyphs,
      ),
      pickables: describePickableRegistry(pickables),
      externalTextures: peekExternalTextures(
        getRenderWindow?.() || null,
      )?.describe() ?? { size: 0, entries: [] },
    };
  }

  function getAppliedSceneState(rwId) {
    const id = rwId !== undefined ? String(rwId) : syncedRootId;
    if (!id || !managedSyncContext?.synchronizerContext) return null;
    const rootInstance = getRenderWindow?.();
    if (!rootInstance) return null;
    return dumpAppliedScene(
      id,
      rootInstance,
      managedSyncContext.synchronizerContext,
    );
  }

  function updateDistanceToCameraGlyphsForRender() {
    return updateDistanceToCameraGlyphs(distanceToCameraGlyphs, {
      renderer: getRenderer(),
      renderWindow: getRenderWindow?.(),
      synchronizerContext: managedSyncContext?.synchronizerContext,
    });
  }

  // Answer "what pickable glyph point is under (cssX, cssY)" from what this
  // view actually rendered. Coordinates are canvas CSS px, top-left origin.
  function pickAt(cssX, cssY) {
    return pickAtRegistry(pickables, cssX, cssY, {
      renderer: getRenderer(),
      renderWindow: getRenderWindow?.(),
      synchronizerContext: managedSyncContext?.synchronizerContext,
    });
  }

  // The camera matrices this view last rendered with, in the flat layout the
  // consuming server already speaks (the same arrays setRenderedCamera stored).
  // Null until a rendered camera has been pushed. Read at event time so a
  // gesture payload is self-contained — it carries its own frame.
  function readGestureCamera() {
    const rendered = getRenderedCamera();
    if (!rendered) return null;
    return {
      viewMatrix: rendered.viewMatrix,
      projectionMatrix: rendered.projectionMatrix,
    };
  }

  // The rendered viewport in canvas CSS px plus its device-pixel ratio, matching
  // the space pickAt measures pointer coordinates in.
  function readGestureViewport() {
    const metrics = getViewportMetrics(getRenderer(), getRenderWindow?.());
    if (!metrics) return null;
    return {
      width: metrics.width,
      height: metrics.height,
      dpr: getDevicePixelRatio(),
    };
  }

  function getViewCanvas() {
    const view = getRenderWindow?.()?.getViews?.()?.[0];
    return view?.getCanvas?.() ?? null;
  }

  // The drag/click gesture state machine. It emits semantic pointer events as a
  // Vue "pointerEvent"; each payload carries the pick, the pointer (grab-offset
  // applied on drags), and the camera/viewport it was measured against.
  const gestures = createPickableGestures({
    pick: (cssX, cssY) => pickAt(cssX, cssY),
    readCamera: readGestureCamera,
    readViewport: readGestureViewport,
    getCanvas: getViewCanvas,
    emit: (payload) => emit?.("pointerEvent", payload),
  });

  return {
    initialize,
    cleanup,
    update,
    requestResync,
    applyQueuedStateSync,
    getQueueLength,
    getRenderWindow,
    getRenderer,
    setCamera,
    setRenderedCamera,
    getRenderedCamera,
    resetCamera,
    onSceneApplied,
    getInstance,
    uploadTexture,
    pickAt,
    startTargetDrag: gestures.startTargetDrag,
    emitTargetClick: gestures.emitTargetClick,
    setPointerContext: gestures.setPointerContext,
    setEmitBackgroundClick: gestures.setEmitBackgroundClick,
    updateDistanceToCameraGlyphs: updateDistanceToCameraGlyphsForRender,
    getSyncDiagnostics,
    getAppliedSceneState,
  };
}
