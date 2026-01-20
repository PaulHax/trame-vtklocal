import { ref, inject, onMounted, onBeforeUnmount, watchEffect } from "vue";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";

import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import vtkRenderWindowInteractor from "@kitware/vtk.js/Rendering/Core/RenderWindowInteractor";
import vtkOpenGLRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/RenderWindow";
import vtkInteractorStyleTrackballCamera from "@kitware/vtk.js/Interaction/Style/InteractorStyleTrackballCamera";
import vtkSynchronizableRenderWindow from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow";
import vtkRenderPass from "@kitware/vtk.js/Rendering/SceneGraph/RenderPass";

export default {
  emits: ["updated", "camera"],
  props: {
    renderWindow: {
      type: Number,
      required: true,
    },
    wsClient: {
      type: Object,
    },
    interactorSettings: {
      type: Array,
      default: () => [],
    },
  },
  setup(props, { emit }) {
    const trame = inject("trame");
    const container = ref(null);
    const client = props.wsClient || trame?.client;

    let openGLRenderWindow = null;
    let renderWindow = null;
    let syncRenderWindow = null;
    let interactor = null;
    let resizeObserver = null;
    let synchronizerContext = null;
    let buildOnlyPass = null;

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

    async function fetchState() {
      const session = client.getConnection().getSession();
      return await session.call("vtkjs.get.state", [props.renderWindow]);
    }

    function resize() {
      if (!container.value || !openGLRenderWindow) return;

      const { width, height } = container.value.getBoundingClientRect();
      const devicePixelRatio = window.devicePixelRatio || 1;
      const w = Math.floor(width * devicePixelRatio);
      const h = Math.floor(height * devicePixelRatio);

      if (w === 0 || h === 0) return;

      openGLRenderWindow.setSize(w, h);
      renderWindow.render();
    }

    async function update() {
      const state = await fetchState();
      if (!state || !syncRenderWindow) return;

      try {
        synchronizerContext.emptyCachedInstances();
        synchronizerContext.emptyCachedArrays();

        const synced = await syncRenderWindow.synchronize(state);
        if (!synced) return;

        // Build the OpenGL scene graph (view nodes) before rendering.
        // This ensures all view nodes exist before render passes try to use them.
        buildOnlyPass.traverse(openGLRenderWindow);

        renderWindow.render();
        emit("updated");
      } catch (err) {
        console.error("VtkJsLocal: synchronize error", err);
      }
    }

    function render() {
      if (renderWindow) {
        renderWindow.render();
      }
    }

    onMounted(async () => {
      const contextName = `vtkjs-local-${props.renderWindow}`;
      synchronizerContext =
        vtkSynchronizableRenderWindow.getSynchronizerContext(contextName);
      synchronizerContext.setFetchArrayFunction(fetchArray);

      openGLRenderWindow = vtkOpenGLRenderWindow.newInstance();
      openGLRenderWindow.setContainer(container.value);

      renderWindow = vtkRenderWindow.newInstance();
      renderWindow.addView(openGLRenderWindow);

      buildOnlyPass = vtkRenderPass.newInstance({
        preDelegateOperations: ["buildPass"],
      });

      syncRenderWindow = vtkSynchronizableRenderWindow.decorate(renderWindow, contextName);

      interactor = vtkRenderWindowInteractor.newInstance();
      interactor.setInteractorStyle(
        vtkInteractorStyleTrackballCamera.newInstance()
      );
      interactor.setView(openGLRenderWindow);
      interactor.initialize();
      interactor.bindEvents(container.value);

      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(container.value);

      resize();
      await update();
      resize();
    });

    onBeforeUnmount(() => {
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }

      if (interactor) {
        interactor.unbindEvents();
        interactor.delete();
        interactor = null;
      }

      if (openGLRenderWindow) {
        openGLRenderWindow.delete();
        openGLRenderWindow = null;
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
          `vtkjs-local-${props.renderWindow}`
        );
        synchronizerContext = null;
      }
    });

    watchEffect(() => {
      if (props.interactorSettings && interactor) {
        const style = interactor.getInteractorStyle();
        if (style && style.applySettings) {
          style.applySettings(props.interactorSettings);
        }
      }
    });

    return {
      container,
      update,
      render,
      resize,
    };
  },
  template: `<div ref="container" style="position: relative; width: 100%; height: 100%;"></div>`,
};
