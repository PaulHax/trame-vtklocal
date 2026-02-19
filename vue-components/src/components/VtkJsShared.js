import { ref, inject, onBeforeUnmount } from "vue";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";

import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import vtkSharedRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/SharedRenderWindow";
import vtkRenderPass from "@kitware/vtk.js/Rendering/SceneGraph/RenderPass";

import {
  createSyncContext,
  getSyncedRenderers,
  cleanupSyncContext,
} from "./vtkJsSync";

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
    let syncRenderWindow = null;
    let synchronizerContext = null;
    let buildOnlyPass = null;
    let renderRequestedCallback = null;
    let repaintCallback = null;
    let syncStateAtRenderFlag = false;
    let sync = null;
    let rwId = null;
    let freshRenderer = null;
    let glContext = null;

    function resetGLStateForSharedContext() {
      const gl = glContext;
      if (!gl) return;

      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;

      gl.disable(gl.SCISSOR_TEST);
      gl.viewport(0, 0, width, height);
      gl.scissor(0, 0, width, height);
    }

    function setRepaintCallback(fn) {
      repaintCallback = fn;
    }

    function initializeForSharedContext(canvas, gl, options = {}) {
      const { syncStateAtRender = false, onResyncRequired = null } = options;

      syncStateAtRenderFlag = syncStateAtRender;
      glContext = gl;

      const contextName = `vtkjs-shared-${props.renderWindow}`;

      sharedRenderWindow = vtkSharedRenderWindow.createFromContext(canvas, gl);

      renderWindow = vtkRenderWindow.newInstance();
      renderWindow.addView(sharedRenderWindow);

      buildOnlyPass = vtkRenderPass.newInstance({
        preDelegateOperations: ["buildPass"],
      });

      const ctx = createSyncContext(client, contextName, renderWindow);
      synchronizerContext = ctx.synchronizerContext;
      syncRenderWindow = ctx.syncRenderWindow;

      rwId = String(props.renderWindow);

      if (props.syncMode === "pull") {
        sync = createPullSync(client, syncRenderWindow, synchronizerContext, rwId);
      } else {
        sync = createPushSync(client, syncRenderWindow, synchronizerContext, rwId, {
          onStateReceived(deltaState) {
            emit("viewStateChange", deltaState);
            if (syncStateAtRenderFlag) {
              if (repaintCallback) {
                repaintCallback();
              }
            } else {
              applyQueuedState().then(() => {
                if (renderRequestedCallback) {
                  renderRequestedCallback();
                }
              });
            }
          },
          onPartialUpdate(update, syncCtx) {
            applyPartialArrayUpdate(update, syncCtx);
            if (renderRequestedCallback) {
              renderRequestedCallback();
            }
          },
          onResyncRequired,
        });
      }

      ready.value = true;
      emit("onReady", true);
    }

    async function applyQueuedState() {
      if (!sync || !sync.getQueueLength || !sync.getQueueLength()) return false;

      emit("beforeSceneLoaded");

      const synced = await sync.applyQueuedState();

      if (synced) {
        const syncedRenderers = getSyncedRenderers(renderWindow);
        if (syncedRenderers.length > 0) {
          freshRenderer = syncedRenderers[0];
        }
        emit("updated");
      }

      emit("afterSceneLoaded");
      return synced;
    }

    async function update() {
      if (!sync || !sync.update) return;

      emit("beforeSceneLoaded");

      const state = await sync.update();
      if (state) {
        const syncedRenderers = getSyncedRenderers(renderWindow);
        if (syncedRenderers.length > 0) {
          freshRenderer = syncedRenderers[0];
        }
        emit("updated");
      }

      emit("afterSceneLoaded");
    }

    async function renderShared(options = {}) {
      const { skipRender = false } = options;

      await applyQueuedState();

      if (!skipRender && sharedRenderWindow) {
        sharedRenderWindow.renderShared({});
        resetGLStateForSharedContext();
      }
    }

    function onRenderRequested(callback) {
      renderRequestedCallback = callback;
      if (sharedRenderWindow?.setRenderCallback) {
        sharedRenderWindow.setRenderCallback(callback);
      }
    }

    function getRenderWindow() {
      return renderWindow;
    }

    function getRenderer() {
      return freshRenderer || renderWindow?.getRenderersByReference?.()?.[0] || null;
    }

    onBeforeUnmount(() => {
      if (sync) {
        sync.cleanup();
        sync = null;
      }

      if (sharedRenderWindow) {
        sharedRenderWindow.delete();
        sharedRenderWindow = null;
      }

      if (renderWindow) {
        renderWindow.delete();
        renderWindow = null;
      }

      if (buildOnlyPass) {
        buildOnlyPass.delete();
        buildOnlyPass = null;
      }

      cleanupSyncContext(`vtkjs-shared-${props.renderWindow}`);
      synchronizerContext = null;
    });

    return {
      initializeForSharedContext,
      update,
      renderShared,
      onRenderRequested,
      setRepaintCallback,
      getRenderWindow,
      getRenderer,
      resetGLStateForSharedContext,
    };
  },
  template: `<div style="display: none;"></div>`,
};
