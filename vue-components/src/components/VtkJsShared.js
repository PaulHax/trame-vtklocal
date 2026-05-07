import { inject, onMounted, onBeforeUnmount } from "vue";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import "@kitware/vtk.js/Rendering/Profiles/Glyph";

import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import vtkSharedRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/SharedRenderWindow";

import { createRafScheduler } from "./rafScheduler";
import { useSceneSync } from "./useSceneSync";

export default {
  emits: [
    "updated",
    "viewStateExtra",
    "onReady",
    "beforeSceneLoaded",
    "afterSceneLoaded",
    "messageApplied",
  ],
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
      validator: (value) => value === "push",
    },
  },
  setup(props, { emit }) {
    const trame = inject("trame");
    const client = props.wsClient || trame?.client;

    let sharedRenderWindow = null;
    let renderWindow = null;
    let renderRequestedCallback = null;
    let repaintCallback = null;
    let syncStateAtRenderFlag = false;
    let disposed = false;

    function renderScene() {
      if (renderRequestedCallback) {
        renderRequestedCallback();
        return;
      }
      sharedRenderWindow?.renderShared?.({});
    }

    const scene = useSceneSync({
      client,
      emit,
      getRenderWindow: () => renderWindow,
      renderScene,
      syncErrorLabel: "VtkJsShared",
    });

    const scheduleQueuedStateApply = createRafScheduler(() => {
      scene.update().then(() => {
        if (!disposed && renderRequestedCallback) {
          renderRequestedCallback();
        }
      });
    });

    function requestQueuedStateApply(deltaState = null) {
      if (repaintCallback) {
        repaintCallback(deltaState);
      } else if (syncStateAtRenderFlag) {
        renderRequestedCallback?.();
      } else {
        scheduleQueuedStateApply();
      }
    }

    function initializeForSharedContext(canvas, gl, options = {}) {
      const { syncStateAtRender = false } = options;

      syncStateAtRenderFlag = syncStateAtRender;

      sharedRenderWindow = vtkSharedRenderWindow.createFromContext(canvas, gl);

      renderWindow = vtkRenderWindow.newInstance();
      renderWindow.addView(sharedRenderWindow);

      scene.initialize({
        contextName: `vtkjs-shared-${props.renderWindow}`,
        renderWindowId: props.renderWindow,
        onStateReceived(deltaState) {
          requestQueuedStateApply(deltaState);
        },
        onQueueReady() {
          requestQueuedStateApply();
        },
        onPartialApplied(_update, _syncCtx, applied) {
          if (applied) {
            renderRequestedCallback?.();
          }
        },
        onMessageApplied(message) {
          emit("messageApplied", message);
        },
      });
    }

    function renderShared(options = {}) {
      if (syncStateAtRenderFlag) {
        scene.applyQueuedStateSync();
      }

      sharedRenderWindow?.renderShared?.(options);
    }

    function onRenderRequested(callback) {
      renderRequestedCallback = callback;
      sharedRenderWindow?.setRenderCallback?.(callback);
    }

    function setRepaintCallback(callback) {
      repaintCallback = callback;
    }

    onMounted(() => {
      emit("onReady");
    });

    onBeforeUnmount(() => {
      disposed = true;
      scene.cleanup();

      sharedRenderWindow?.delete?.();
      sharedRenderWindow = null;

      renderWindow?.delete?.();
      renderWindow = null;
    });

    return {
      initializeForSharedContext,
      update: scene.update,
      requestResync: scene.requestResync,
      applyQueuedStateSync: scene.applyQueuedStateSync,
      getQueueLength: scene.getQueueLength,
      getRenderWindow: scene.getRenderWindow,
      getRenderer: scene.getRenderer,
      setCamera: scene.setCamera,
      resetCamera: scene.resetCamera,
      // Diagnostics / oracle support (read-only, not general app integration).
      getSyncDiagnostics: scene.getSyncDiagnostics,
      getAppliedSceneState: scene.getAppliedSceneState,
      renderShared,
      onRenderRequested,
      setRepaintCallback,
    };
  },
  template: `<div style="display: none;"></div>`,
};
