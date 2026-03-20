import { ref, inject, onMounted, onBeforeUnmount, watchEffect } from "vue";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";

import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import vtkRenderWindowInteractor from "@kitware/vtk.js/Rendering/Core/RenderWindowInteractor";
import vtkOpenGLRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/RenderWindow";
import vtkInteractorStyleTrackballCamera from "@kitware/vtk.js/Interaction/Style/InteractorStyleTrackballCamera";

import {
  createSyncContext,
  getSyncedRenderers,
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
    let activeRenderer = null;
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

    async function update() {
      const isPull = props.syncMode !== "push";
      if (isPull && interactor) {
        interactor.setEnableRender(false);
      }

      try {
        const synced = isPull
          ? await sync.update()
          : await sync.applyQueuedState();

        if (synced) {
          const syncedRenderers = getSyncedRenderers(renderWindow);
          if (syncedRenderers.length > 0) {
            activeRenderer = syncedRenderers[0];
          }
          emit("updated");
        }
      } catch (err) {
        console.error("VtkJsLocal: synchronize error", err);
      } finally {
        if (isPull && interactor) {
          interactor.setEnableRender(true);
        }
        renderWindow.render();
      }
    }

    function setCamera(params) {
      if (!activeRenderer) return;
      const cam = activeRenderer.getActiveCamera();
      if (!cam) return;
      applyCameraParams(cam, params);
      if (renderWindow) renderWindow.render();
    }

    function resetCamera() {
      if (!activeRenderer) return;
      activeRenderer.resetCamera();
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
        let rafPending = false;
        sync = createPushSync(client, syncRenderWindow, synchronizerContext, rwId, {
          onStateReceived() {
            if (!rafPending) {
              rafPending = true;
              requestAnimationFrame(() => {
                rafPending = false;
                update();
              });
            }
          },
          async onPartialUpdate(partialUpdate, syncCtx) {
            if (sync?.getQueueLength?.() > 0) {
              await sync.applyQueuedState();
            }

            const applied = applyPartialArrayUpdate(partialUpdate, syncCtx);
            if (applied) {
              renderWindow.render();
            } else {
              sync?.requestResync?.();
            }
          },
        });
      } else {
        sync = createPullSync(client, syncRenderWindow, synchronizerContext, rwId);
      }

      if (props.syncMode === "pull") {
        await update();
      }

      interactor = vtkRenderWindowInteractor.newInstance();
      interactor.setInteractorStyle(
        vtkInteractorStyleTrackballCamera.newInstance()
      );
      interactor.setView(openGLRenderWindow);
      interactor.initialize();
      interactor.bindEvents(container.value);

      interactor.onEndInteraction(() => {
        if (activeRenderer) {
          const cam = activeRenderer.getActiveCamera();
          if (cam) {
            emit("camera", extractCameraParams(cam));
          }
        }
      });

      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(container.value);

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
