import { ref, inject, onBeforeUnmount } from "vue";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";

import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import vtkSharedRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/SharedRenderWindow";
import vtkSynchronizableRenderWindow from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow";
import vtkRenderPass from "@kitware/vtk.js/Rendering/SceneGraph/RenderPass";

export default {
  emits: ["updated", "viewStateChange", "onReady"],
  props: {
    renderWindow: {
      type: Number,
      required: true,
    },
    wsClient: {
      type: Object,
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
    let wsSubscription = null;
    let stateQueue = [];
    let rwId = null;
    let visibilityHandler = null;

    async function fetchArray(hash) {
      const session = client.getConnection().getSession();
      const content = await session.call("vtkjs.get.array", [hash, null]);
      if (content.arrayBuffer) {
        return await content.arrayBuffer();
      }
      if (content instanceof Uint8Array) {
        return content.buffer.slice(
          content.byteOffset,
          content.byteOffset + content.byteLength
        );
      }
      if (content instanceof ArrayBuffer) {
        return content;
      }
      return content;
    }

    function initializeForSharedContext(canvas, gl, options = {}) {
      const { syncStateAtRender = false, onResyncRequired = null } = options;

      const contextName = `vtkjs-shared-${props.renderWindow}`;
      synchronizerContext =
        vtkSynchronizableRenderWindow.getSynchronizerContext(contextName);
      synchronizerContext.setFetchArrayFunction(fetchArray);

      sharedRenderWindow = vtkSharedRenderWindow.createFromContext(canvas, gl);

      renderWindow = vtkRenderWindow.newInstance();
      renderWindow.addView(sharedRenderWindow);

      buildOnlyPass = vtkRenderPass.newInstance({
        preDelegateOperations: ["buildPass"],
      });

      syncRenderWindow = vtkSynchronizableRenderWindow.decorate(
        renderWindow,
        contextName
      );

      rwId = String(props.renderWindow);

      // Subscribe to delta updates from server
      wsSubscription = client
        .getConnection()
        .getSession()
        .subscribe("trame.vtk.delta", ([deltaState]) => {
          if (!rwId || deltaState.id === rwId) {
            if (!rwId) {
              rwId = deltaState.id;
            }
            stateQueue.push(deltaState);
            emit("viewStateChange", deltaState);
            if (renderRequestedCallback) {
              renderRequestedCallback();
            }
          }
        });

      // Handle visibility change for browser sleep/wake
      if (onResyncRequired) {
        visibilityHandler = () => {
          if (document.visibilityState === "visible") {
            stateQueue.length = 0;
            onResyncRequired();
          }
        };
        document.addEventListener("visibilitychange", visibilityHandler);
      }

      ready.value = true;
      emit("onReady", true);
    }

    async function applyQueuedState() {
      if (!stateQueue.length || !syncRenderWindow) return false;

      while (stateQueue.length) {
        const state = stateQueue.shift();
        try {
          synchronizerContext.emptyCachedInstances();
          synchronizerContext.emptyCachedArrays();

          const synced = await syncRenderWindow.synchronize(state);
          if (synced) {
            buildOnlyPass.traverse(sharedRenderWindow);
            emit("updated");
          }
        } catch (err) {
          console.error("VtkJsShared: synchronize error", err);
        }
      }
      return true;
    }

    function renderShared(options = {}) {
      const { skipRender = false } = options;

      applyQueuedState();

      if (!skipRender && sharedRenderWindow) {
        sharedRenderWindow.renderShared({});
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
      return renderWindow?.getRenderersByReference?.()?.[0] || null;
    }

    onBeforeUnmount(() => {
      if (wsSubscription && client) {
        client.getConnection().getSession().unsubscribe(wsSubscription);
        wsSubscription = null;
      }

      if (visibilityHandler) {
        document.removeEventListener("visibilitychange", visibilityHandler);
        visibilityHandler = null;
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

      if (synchronizerContext) {
        vtkSynchronizableRenderWindow.clearSynchronizerContext(
          `vtkjs-shared-${props.renderWindow}`
        );
        synchronizerContext = null;
      }
    });

    return {
      initializeForSharedContext,
      renderShared,
      onRenderRequested,
      getRenderWindow,
      getRenderer,
    };
  },
  template: `<div style="display: none;"></div>`,
};
