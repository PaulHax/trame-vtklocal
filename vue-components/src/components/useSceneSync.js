import vtkObjectManager from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/ObjectManager";

import {
  createManagedSyncContext,
  getPrimaryRenderer,
  applyCameraParams,
} from "./vtkJsSync";
import { withSyncCapability } from "./SyncExtension";
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
}) {
  let managedSyncContext = null;
  let sync = null;
  let syncCapability = null;
  let currentSyncMode = "pull";
  let disposed = false;

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

  function applyQueuedStateSync({ emitLifecycle = true, emitUpdated = true } = {}) {
    if (!sync?.drainQueue || !syncCapability) return false;

    const states = sync.drainQueue();
    if (!states.length) return false;

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
        return false;
      }
    }

    if (synced && emitUpdated) {
      emit?.("updated");
    }

    if (emitLifecycle) {
      emit?.("afterSceneLoaded");
    }

    return synced;
  }

  const updateController = createSyncController({
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
    managedSyncContext?.cleanup?.();
    managedSyncContext = null;
  }

  function initialize({
    contextName,
    renderWindowId,
    syncMode,
    onStateReceived,
    onPartialApplied,
  }) {
    disposed = false;
    cleanupSyncContext();
    currentSyncMode = syncMode;

    managedSyncContext = createManagedSyncContext(
      client,
      contextName,
      getRenderWindow(),
    );

    const { synchronizerContext, syncRenderWindow } = managedSyncContext;
    const rwId = String(renderWindowId);

    if (syncMode === "push") {
      syncCapability = withSyncCapability(
        syncRenderWindow,
        synchronizerContext,
        vtkObjectManager,
      );
      sync = createPushSync(
        client,
        syncRenderWindow,
        synchronizerContext,
        rwId,
        {
          onStateReceived(deltaState) {
            emit?.("viewStateChange", deltaState);
            onStateReceived?.(deltaState);
          },
          onPartialUpdate(partialUpdate, syncCtx) {
            if (getQueueLength() > 0) {
              applyQueuedStateSync();
            }

            const applied = applyPartialArrayUpdate(partialUpdate, syncCtx);
            if (!applied) {
              requestResync();
            }
            onPartialApplied?.(partialUpdate, syncCtx, applied);
          },
        },
      );
      return;
    }

    sync = createPullSync(client, syncRenderWindow, synchronizerContext, rwId);
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
