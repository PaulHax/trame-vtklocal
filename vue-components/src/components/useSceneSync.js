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
  let lastAppliedSeq = 0;
  let lastAppliedEpoch = null;
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
    const payload = message.payload;
    if (payload?.epoch !== undefined) {
      lastAppliedEpoch = payload.epoch;
    }
    if (payload?.seq !== undefined) {
      lastAppliedSeq = payload.seq;
    }
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

  function applyReadyPartialUpdates(syncCtx = null) {
    const resolvedSyncContext =
      syncCtx || managedSyncContext?.synchronizerContext;
    if (!resolvedSyncContext) {
      return { didApply: false, failed: false };
    }

    const partialUpdates = sync?.drainReadyPartialUpdates?.() ?? [];
    if (!partialUpdates.length) {
      return { didApply: false, failed: false };
    }

    for (const partialUpdate of partialUpdates) {
      if (!applySinglePartialUpdate(partialUpdate, resolvedSyncContext)) {
        return { didApply: true, failed: true };
      }
    }

    return { didApply: true, failed: false };
  }

  function applyQueuedStateSyncResult({
    emitLifecycle = true,
    emitUpdated = true,
  } = {}) {
    if (!syncCapability) {
      return { status: "idle", didSync: false };
    }

    if (sync?.takeNextMessage) {
      return applyQueuedOrderedMessages({ emitLifecycle, emitUpdated });
    }

    const states = sync?.drainReadyStates?.() ?? [];
    if (!states.length) {
      const partialResult = applyReadyPartialUpdates();
      if (partialResult.failed) {
        return { status: "failed", didSync: false };
      }
      if (partialResult.didApply) {
        return { status: "applied", didSync: false };
      }
      return {
        status: getQueueLength() > 0 ? "blocked" : "idle",
        didSync: false,
      };
    }

    if (emitLifecycle) {
      emit?.("beforeSceneLoaded");
    }

    let synced = false;
    const appliedStates = [];
    let latestExtraState = null;
    for (const state of states) {
      try {
        if (syncCapability.synchronizePreparedStateSync(state, true)) {
          synced = true;
          appliedStates.push(state);
        }
        if (state?.extra) {
          latestExtraState = state;
        }
      } catch (error) {
        console.warn(`[${syncErrorLabel}] Resync needed:`, error.message);
        requestResync("full-state-apply-exception");
        if (emitLifecycle) {
          emit?.("afterSceneLoaded");
        }
        return { status: "failed", didSync: false };
      }
    }
    sync?.markStatesApplied?.(appliedStates);

    if (latestExtraState?.extra) {
      emit?.("viewStateExtra", latestExtraState.extra);
    }

    const partialResult = applyReadyPartialUpdates();
    if (partialResult.failed) {
      if (emitLifecycle) {
        emit?.("afterSceneLoaded");
      }
      return { status: "failed", didSync: false };
    }

    if (synced && emitUpdated) {
      emit?.("updated");
    }

    if (emitLifecycle) {
      emit?.("afterSceneLoaded");
    }

    return {
      status: getQueueLength() > 0 ? "blocked" : "applied",
      didSync: synced,
    };
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
    lastAppliedSeq = 0;
    lastAppliedEpoch = null;
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
    // Diagnostics / oracle support (not general app integration). Read-only;
    // safe to call from production code (debug panels, dev tools).
    return {
      lastSeq: lastAppliedSeq,
      lastEpoch: lastAppliedEpoch,
      queueLength: getQueueLength(),
      lastAppliedOp,
      syncedRootId,
    };
  }

  function getAppliedSceneState(rwId) {
    // Diagnostics / oracle support: walks live ``synchronizerContext`` and
    // returns a nested-tree dump in the same shape the Python translator
    // emits server-side. Read-only.
    const id = rwId !== undefined ? String(rwId) : syncedRootId;
    if (!id || !managedSyncContext?.synchronizerContext) return null;
    return dumpAppliedScene(id, managedSyncContext.synchronizerContext);
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
