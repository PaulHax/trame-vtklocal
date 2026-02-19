import { ref, inject, onMounted, onBeforeUnmount, watchEffect } from "vue";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";

import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import vtkRenderer from "@kitware/vtk.js/Rendering/Core/Renderer";
import vtkRenderWindowInteractor from "@kitware/vtk.js/Rendering/Core/RenderWindowInteractor";
import vtkOpenGLRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/RenderWindow";
import vtkInteractorStyleTrackballCamera from "@kitware/vtk.js/Interaction/Style/InteractorStyleTrackballCamera";
import vtkCamera from "@kitware/vtk.js/Rendering/Core/Camera";

import {
  createSyncContext,
  getSyncedRenderers,
  extractGeometry,
  cleanupSyncContext,
  extractCameraParams,
  applyCameraParams,
} from "./vtkJsSync";

import { createPullSync } from "./pullSync";
import { createPushSync, applyPartialArrayUpdate } from "./pushSync";

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
    syncMode: {
      type: String,
      default: "pull",
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
    let freshRenderer = null;
    let sync = null;

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

    async function updatePull() {
      const state = await sync.update();
      if (!state || !syncRenderWindow) return;

      if (interactor) {
        interactor.setEnableRender(false);
      }

      try {
        emit("updated");

        const syncedRenderers = getSyncedRenderers(renderWindow);
        renderWindow.getRenderers().forEach((ren) =>
          renderWindow.removeRenderer(ren)
        );

        if (!freshRenderer) {
          freshRenderer = vtkRenderer.newInstance();
          if (syncedRenderers.length > 0) {
            const syncedCam = syncedRenderers[0].getActiveCamera();
            if (syncedCam) {
              const freshCam = vtkCamera.newInstance();
              applyCameraParams(freshCam, extractCameraParams(syncedCam));
              freshRenderer.setActiveCamera(freshCam);
            }
          }
        }

        if (syncedRenderers.length > 0) {
          extractGeometry(syncedRenderers[0], freshRenderer);
        }

        renderWindow.addRenderer(freshRenderer);

        if (interactor) {
          interactor.setEnableRender(true);
        }
        renderWindow.render();
      } catch (err) {
        console.error("VtkJsLocal: synchronize error", err);
        if (interactor) {
          interactor.setEnableRender(true);
        }
      }
    }

    async function updatePush() {
      const synced = await sync.applyQueuedState();
      if (synced) {
        const syncedRenderers = getSyncedRenderers(renderWindow);
        if (syncedRenderers.length > 0) {
          freshRenderer = syncedRenderers[0];
        }
        emit("updated");
      }
      renderWindow.render();
    }

    async function update() {
      if (props.syncMode === "push") {
        await updatePush();
      } else {
        await updatePull();
      }
    }

    function setCamera(params) {
      if (!freshRenderer) return;
      const cam = freshRenderer.getActiveCamera();
      if (!cam) return;
      applyCameraParams(cam, params);
      if (renderWindow) renderWindow.render();
    }

    function resetCamera() {
      if (!freshRenderer) return;
      freshRenderer.resetCamera();
      if (renderWindow) renderWindow.render();
    }

    function render() {
      if (renderWindow) {
        renderWindow.render();
      }
    }

    onMounted(async () => {
      const contextName = `vtkjs-local-${props.renderWindow}`;

      openGLRenderWindow = vtkOpenGLRenderWindow.newInstance();
      openGLRenderWindow.setContainer(container.value);

      renderWindow = vtkRenderWindow.newInstance();
      renderWindow.addView(openGLRenderWindow);

      const ctx = createSyncContext(client, contextName, renderWindow);
      synchronizerContext = ctx.synchronizerContext;
      syncRenderWindow = ctx.syncRenderWindow;

      const rwId = String(props.renderWindow);

      if (props.syncMode === "push") {
        sync = createPushSync(client, syncRenderWindow, synchronizerContext, rwId, {
          onStateReceived() {
            update();
          },
          onPartialUpdate(partialUpdate, syncCtx) {
            applyPartialArrayUpdate(partialUpdate, syncCtx);
            renderWindow.render();
          },
        });
      } else {
        sync = createPullSync(client, syncRenderWindow, synchronizerContext, rwId);
      }

      interactor = vtkRenderWindowInteractor.newInstance();
      interactor.setInteractorStyle(
        vtkInteractorStyleTrackballCamera.newInstance()
      );
      interactor.setView(openGLRenderWindow);
      interactor.initialize();
      interactor.bindEvents(container.value);

      interactor.onEndInteraction(() => {
        if (freshRenderer) {
          const cam = freshRenderer.getActiveCamera();
          if (cam) {
            emit("camera", extractCameraParams(cam));
          }
        }
      });

      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(container.value);

      resize();
      if (props.syncMode === "pull") {
        await update();
      }
      resize();
    });

    onBeforeUnmount(() => {
      if (sync) {
        sync.cleanup();
        sync = null;
      }

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

      cleanupSyncContext(`vtkjs-local-${props.renderWindow}`);
      synchronizerContext = null;
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
      setCamera,
      resetCamera,
      render,
      resize,
    };
  },
  template: `<div ref="container" style="position: relative; width: 100%; height: 100%;"></div>`,
};
