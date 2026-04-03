import { ref, inject, onMounted, onBeforeUnmount } from "vue";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";

import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import vtkSharedRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/SharedRenderWindow";

import {
  createManagedSyncContext,
  getPrimaryRenderer,
} from "./vtkJsSync";

import { withSyncCapability } from "./SyncExtension";
import vtkObjectManager from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/ObjectManager";

import { createPullSync } from "./pullSync";
import { createPushSync, applyPartialArrayUpdate } from "./pushSync";
import { createRafScheduler } from "./rafScheduler";
import { createSyncController } from "./syncController";

export default {
  emits: ["updated", "viewStateChange", "onReady", "beforeSceneLoaded", "afterSceneLoaded"],
  props: {
    renderWindow: {
      type: Number,
      required: true,
    },
    wsClient: {
      type: Object,
    },
    syncMode: {
      type: String,
      default: "push",
    },
  },
  setup(props, { emit }) {
    const trame = inject("trame");
    const client = props.wsClient || trame?.client;
    const ready = ref(false);

    let sharedRenderWindow = null;
    let renderWindow = null;
    let managedSyncContext = null;
    let renderRequestedCallback = null;
    let repaintCallback = null;
    let syncStateAtRenderFlag = false;
    let sync = null;
    let syncCapability = null;
    let disposed = false;

    function createSceneSyncRunner(canSync, synchronize) {
      return createSyncController({
        canSync,
        synchronize,
        beforeSync() {
          emit("beforeSceneLoaded");
        },
        onSynced() {
          emit("updated");
        },
        afterSync() {
          emit("afterSceneLoaded");
        },
        rethrowError: true,
      });
    }

    const queuedStateController = createSceneSyncRunner(
      () => !disposed && !!sync?.getQueueLength?.(),
      () => sync.applyQueuedState()
    );

    const updateController = createSceneSyncRunner(
      () => !disposed && !!sync?.update,
      () => sync.update()
    );

    function initializeForSharedContext(canvas, gl, options = {}) {
      const { syncStateAtRender = false } = options;

      syncStateAtRenderFlag = syncStateAtRender;

      sharedRenderWindow = vtkSharedRenderWindow.createFromContext(canvas, gl);

      renderWindow = vtkRenderWindow.newInstance();
      renderWindow.addView(sharedRenderWindow);

      managedSyncContext = createManagedSyncContext(
        client,
        `vtkjs-shared-${props.renderWindow}`,
        renderWindow,
      );
      const { synchronizerContext, syncRenderWindow } = managedSyncContext;

      const rwId = String(props.renderWindow);
      syncCapability = withSyncCapability(syncRenderWindow, synchronizerContext, vtkObjectManager);

      if (props.syncMode === "pull") {
        sync = createPullSync(client, syncRenderWindow, synchronizerContext, rwId);
      } else {
        const scheduleQueuedStateApply = createRafScheduler(() => {
          if (disposed) return;
          applyQueuedState().catch((err) => {
            if (!disposed) {
              console.warn("[VtkJsShared] State sync failed:", err.message);
              sync?.requestResync?.();
            }
          }).then(() => {
            if (!disposed && renderRequestedCallback) renderRequestedCallback();
          });
        });
        sync = createPushSync(client, syncRenderWindow, synchronizerContext, rwId, {
          onStateReceived(deltaState) {
            emit("viewStateChange", deltaState);
            if (repaintCallback) {
              repaintCallback(deltaState);
            } else if (syncStateAtRenderFlag) {
              if (renderRequestedCallback) renderRequestedCallback();
            } else {
              scheduleQueuedStateApply();
            }
          },
          onPartialUpdate(update, syncCtx) {
            // Apply any queued full-state delta before patching arrays so the
            // partial update lands on the latest synchronized scene.
            if (syncStateAtRenderFlag && sync?.getQueueLength?.() > 0) {
              applyQueuedStateSync();
            }
            applyPartialArrayUpdate(update, syncCtx);
            if (renderRequestedCallback) renderRequestedCallback();
          },
        });
      }

      ready.value = true;
      emit("onReady", true);
    }

    function applyQueuedStateSync() {
      if (!sync?.drainQueue) return false;

      const states = sync.drainQueue();
      if (!states.length || !syncCapability) return false;

      emit("beforeSceneLoaded");

      let synced = false;
      for (const state of states) {
        try {
          if (syncCapability.synchronizeSync(state, true)) synced = true;
        } catch (e) {
          console.warn("[VtkJsShared] Resync needed:", e.message);
          sync.requestResync();
          return false;
        }
      }

      if (synced) emit("updated");
      emit("afterSceneLoaded");
      return synced;
    }

    async function applyQueuedState() {
      const result = await queuedStateController.runSync();
      return result.didSync;
    }

    async function update() {
      await updateController.runSync();
    }

    function renderShared() {
      if (syncStateAtRenderFlag) {
        applyQueuedStateSync();
      }

      if (sharedRenderWindow) {
        sharedRenderWindow.renderShared({});
      }
    }

    function onRenderRequested(callback) {
      renderRequestedCallback = callback;
      if (sharedRenderWindow?.setRenderCallback) {
        sharedRenderWindow.setRenderCallback(callback);
      }
    }

    function getQueueLength() {
      return sync?.getQueueLength?.() ?? 0;
    }

    function getRenderWindow() {
      return renderWindow;
    }

    function getRenderer() {
      return getPrimaryRenderer(renderWindow);
    }

    function setRepaintCallback(callback) {
      repaintCallback = callback;
    }

    function connectAndSync() {
      if (sync?.requestResync) {
        sync.requestResync();
      }
    }

    onMounted(() => {
      emit("onReady");
    });

    onBeforeUnmount(() => {
      disposed = true;
      sync?.cleanup();
      sync = null;
      sharedRenderWindow?.delete();
      sharedRenderWindow = null;
      renderWindow?.delete();
      renderWindow = null;
      managedSyncContext?.cleanup();
      managedSyncContext = null;
    });

    return {
      initializeForSharedContext,
      update,
      applyQueuedStateSync,
      renderShared,
      onRenderRequested,
      getQueueLength,
      getRenderWindow,
      getRenderer,
      setRepaintCallback,
      connectAndSync,
    };
  },
  template: `<div style="display: none;"></div>`,
};
