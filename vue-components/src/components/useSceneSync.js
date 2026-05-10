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
  let lastAppliedOp = null;
  let syncedRootId = null;

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

  function resetCamera() {
    const renderer = getRenderer();
    if (!renderer) return;
    renderer.resetCamera();
    renderScene?.();
  }

  function bindPartialResultToCache(partialUpdate, syncCtx) {
    bindPartialResultToCacheImpl(partialUpdate, syncCtx, pushCache);
  }

  function applySinglePartialUpdate(partialUpdate, syncCtx) {
    const applied = applyPartialArrayUpdateImpl(partialUpdate, syncCtx);
    if (!applied) {
      requestResync("partial-apply-failed");
    }
    if (applied) {
      bindPartialResultToCache(partialUpdate, syncCtx);
      if (partialUpdate?.extra) {
        emit?.("viewStateExtra", partialUpdate.extra);
      }
    }
    partialAppliedCallback?.(partialUpdate, syncCtx, applied);
    return applied;
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
          if (
            syncCapability.synchronizePreparedStateSync(message.payload, true)
          ) {
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
        onPartialUpdate(partialUpdate, syncCtx) {
          return applySinglePartialUpdate(partialUpdate, syncCtx);
        },
      },
    );
  }

  function cleanup() {
    disposed = true;
    cleanupSyncContext();
  }

  function getSyncDiagnostics() {
    const { epoch = null, lastSeq = 0 } = sync?.getDiagnostics?.() ?? {};
    return {
      lastSeq,
      lastEpoch: epoch,
      queueLength: getQueueLength(),
      lastAppliedOp,
      syncedRootId,
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
    resetCamera,
    getSyncDiagnostics,
    getAppliedSceneState,
  };
}
