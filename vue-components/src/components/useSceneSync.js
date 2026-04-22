import vtkObjectManager from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/ObjectManager";

import {
  createManagedSyncContext,
  getPrimaryRenderer,
  applyCameraParams,
} from "./vtkJsSync";
import { withSyncCapability } from "./sync/syncCapability";
import { createPullSync } from "./pullSync";
import { createPushSync, applyPartialArrayUpdate } from "./pushSync";
import { createSyncController } from "./syncController";

export function useSceneSync({
  client,
  emit,
  getRenderWindow,
  renderScene,
  beforeSync,
  finalizeSync,
  syncErrorLabel = "SceneSync",
}, dependencies = {}) {
  const {
    applyPartialArrayUpdate: applyPartialArrayUpdateImpl = applyPartialArrayUpdate,
    createManagedSyncContext: createManagedSyncContextImpl = createManagedSyncContext,
    createPullSync: createPullSyncImpl = createPullSync,
    createPushSync: createPushSyncImpl = createPushSync,
    createSyncController: createSyncControllerImpl = createSyncController,
    vtkObjectManager: vtkObjectManagerImpl = vtkObjectManager,
    withSyncCapability: withSyncCapabilityImpl = withSyncCapability,
  } = dependencies;

  let managedSyncContext = null;
  let sync = null;
  let syncCapability = null;
  let currentSyncMode = "pull";
  let disposed = false;
  let pendingPartialUpdates = [];
  let partialAppliedCallback = null;

  function getRenderer() {
    return getPrimaryRenderer(getRenderWindow?.() || null);
  }

  function requestResync() {
    pendingPartialUpdates = [];
    sync?.requestResync?.();
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

  function applySinglePartialUpdate(partialUpdate, syncCtx) {
    const applied = applyPartialArrayUpdateImpl(partialUpdate, syncCtx);
    if (!applied) {
      requestResync();
    }
    partialAppliedCallback?.(partialUpdate, syncCtx, applied);
    return applied;
  }

  function flushBufferedPartialUpdates(syncCtx = null) {
    const resolvedSyncContext = syncCtx || managedSyncContext?.synchronizerContext;
    if (!resolvedSyncContext || !pendingPartialUpdates.length) {
      return true;
    }

    const bufferedUpdates = pendingPartialUpdates;
    pendingPartialUpdates = [];

    for (const partialUpdate of bufferedUpdates) {
      if (!applySinglePartialUpdate(partialUpdate, resolvedSyncContext)) {
        return false;
      }
    }

    return true;
  }

  function applyQueuedStateSyncResult({
    emitLifecycle = true,
    emitUpdated = true,
  } = {}) {
    if (!syncCapability) {
      return { status: "idle", didSync: false };
    }

    const states =
      sync?.drainReadyQueue?.() ??
      sync?.drainQueue?.() ??
      [];
    if (!states.length) {
      return {
        status: getQueueLength() > 0 ? "blocked" : "idle",
        didSync: false,
      };
    }

    if (emitLifecycle) {
      emit?.("beforeSceneLoaded");
    }

    let synced = false;
    for (const state of states) {
      try {
        if (syncCapability.synchronizeSync(state, true)) {
          synced = true;
        }
      } catch (error) {
        console.warn(`[${syncErrorLabel}] Resync needed:`, error.message);
        requestResync();
        if (emitLifecycle) {
          emit?.("afterSceneLoaded");
        }
        return { status: "failed", didSync: false };
      }
    }

    if (!flushBufferedPartialUpdates()) {
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

    return { status: "applied", didSync: synced };
  }

  function applyQueuedStateSync(options = {}) {
    return applyQueuedStateSyncResult(options).didSync;
  }

  const updateController = createSyncControllerImpl({
    canSync: () => !disposed && !!sync && !!getRenderWindow?.(),
    synchronize() {
      return currentSyncMode === "push"
        ? applyQueuedStateSync({ emitLifecycle: false, emitUpdated: false })
        : sync.update();
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
      requestResync();
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
    pendingPartialUpdates = [];
    partialAppliedCallback = null;
    managedSyncContext?.cleanup?.();
    managedSyncContext = null;
  }

  function initialize({
    contextName,
    renderWindowId,
    syncMode,
    onStateReceived,
    onQueueReady,
    onPartialApplied,
  }) {
    disposed = false;
    cleanupSyncContext();
    currentSyncMode = syncMode;
    partialAppliedCallback = onPartialApplied || null;

    managedSyncContext = createManagedSyncContextImpl(
      client,
      contextName,
      getRenderWindow(),
    );

    const { synchronizerContext, syncRenderWindow } = managedSyncContext;
    const rwId = String(renderWindowId);

    if (syncMode === "push") {
      syncCapability = withSyncCapabilityImpl(
        syncRenderWindow,
        synchronizerContext,
        vtkObjectManagerImpl,
      );
      syncCapability.updateGarbageCollectorThreshold(10000);
      sync = createPushSyncImpl(
        client,
        syncRenderWindow,
        synchronizerContext,
        rwId,
        {
          onStateReceived(deltaState) {
            emit?.("viewStateChange", deltaState);
            onStateReceived?.(deltaState);
          },
          onQueueReady() {
            onQueueReady?.();
          },
          onPartialUpdate(partialUpdate, syncCtx) {
            if (getQueueLength() > 0) {
              const queuedStateResult = applyQueuedStateSyncResult();
              if (queuedStateResult.status === "blocked") {
                pendingPartialUpdates.push(partialUpdate);
                return;
              }
              if (queuedStateResult.status === "failed") return;
            }

            applySinglePartialUpdate(partialUpdate, syncCtx);
          },
        },
      );
      return;
    }

    sync = createPullSyncImpl(client, syncRenderWindow, synchronizerContext, rwId);
  }

  function cleanup() {
    disposed = true;
    cleanupSyncContext();
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
  };
}
