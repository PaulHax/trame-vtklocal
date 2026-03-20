import { ref, inject, onMounted, onBeforeUnmount } from "vue";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";

import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import vtkSharedRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/SharedRenderWindow";

import {
  createSyncContext,
  getSyncedRenderers,
  cleanupSyncContext,
} from "./vtkJsSync";

import { withSyncCapability } from "./SyncExtension";
import vtkObjectManager from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/ObjectManager";

import { createPullSync } from "./pullSync";
import { createPushSync, applyPartialArrayUpdate } from "./pushSync";

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
    let renderRequestedCallback = null;
    let repaintCallback = null;
    let syncStateAtRenderFlag = false;
    let sync = null;
    let syncCapability = null;

    function emitIfSynced(synced) {
      if (synced) emit("updated");
      emit("afterSceneLoaded");
      return synced;
    }

    function initializeForSharedContext(canvas, gl, options = {}) {
      const { syncStateAtRender = false } = options;

      syncStateAtRenderFlag = syncStateAtRender;

      sharedRenderWindow = vtkSharedRenderWindow.createFromContext(canvas, gl);

      renderWindow = vtkRenderWindow.newInstance();
      renderWindow.addView(sharedRenderWindow);

      const contextName = `vtkjs-shared-${props.renderWindow}`;
      const { synchronizerContext, syncRenderWindow } = createSyncContext(client, contextName, renderWindow);

      const rwId = String(props.renderWindow);
      syncCapability = withSyncCapability(syncRenderWindow, synchronizerContext, vtkObjectManager);

      if (props.syncMode === "pull") {
        sync = createPullSync(client, syncRenderWindow, synchronizerContext, rwId);
      } else {
        let sharedRafPending = false;
        sync = createPushSync(client, syncRenderWindow, synchronizerContext, rwId, {
          onStateReceived(deltaState) {
            emit("viewStateChange", deltaState);
            if (repaintCallback) {
              repaintCallback(deltaState);
            } else if (syncStateAtRenderFlag) {
              if (renderRequestedCallback) renderRequestedCallback();
            } else if (!sharedRafPending) {
              sharedRafPending = true;
              requestAnimationFrame(() => {
                sharedRafPending = false;
                applyQueuedState().catch((err) => {
                  console.warn("[VtkJsShared] State sync failed:", err.message);
                  sync?.requestResync?.();
                }).then(() => {
                  if (renderRequestedCallback) renderRequestedCallback();
                });
              });
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

      return emitIfSynced(synced);
    }

    async function applyQueuedState() {
      if (!sync?.getQueueLength?.()) return false;

      emit("beforeSceneLoaded");
      return emitIfSynced(await sync.applyQueuedState());
    }

    async function update() {
      if (!sync?.update) return;

      emit("beforeSceneLoaded");
      emitIfSynced(!!(await sync.update()));
    }

    function renderShared(options = {}) {
      if (syncStateAtRenderFlag) {
        applyQueuedStateSync();
      }

      if (!options.skipRender && sharedRenderWindow) {
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
      return getSyncedRenderers(renderWindow)[0]
        || renderWindow?.getRenderersByReference?.()?.[0]
        || null;
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
      sync?.cleanup();
      sync = null;
      sharedRenderWindow?.delete();
      sharedRenderWindow = null;
      renderWindow?.delete();
      renderWindow = null;
      cleanupSyncContext(`vtkjs-shared-${props.renderWindow}`);
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
