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
  let partialAppliedCallback = null;

  function getRenderer() {
    return getPrimaryRenderer(getRenderWindow?.() || null);
  }

  function requestResync() {
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
    if (applied && partialUpdate?.extra) {
      emit?.("viewStateExtra", partialUpdate.extra);
    }
    partialAppliedCallback?.(partialUpdate, syncCtx, applied);
    return applied;
  }

  function applyReadyPartialUpdates(syncCtx = null) {
    const resolvedSyncContext = syncCtx || managedSyncContext?.synchronizerContext;
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
    let latestAppliedState = null;
    for (const state of states) {
      try {
        if (syncCapability.synchronizeSync(state, true)) {
          synced = true;
          latestAppliedState = state;
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

    if (latestAppliedState?.extra) {
      emit?.("viewStateExtra", latestAppliedState.extra);
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
            onStateReceived?.(deltaState);
          },
          onQueueReady() {
            onQueueReady?.();
          },
          onPartialUpdate(partialUpdate, syncCtx) {
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
