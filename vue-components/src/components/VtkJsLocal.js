import { ref, inject, onMounted, onBeforeUnmount, watchEffect } from "vue";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";

import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import vtkRenderWindowInteractor from "@kitware/vtk.js/Rendering/Core/RenderWindowInteractor";
import vtkOpenGLRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/RenderWindow";
import vtkInteractorStyleTrackballCamera from "@kitware/vtk.js/Interaction/Style/InteractorStyleTrackballCamera";

import {
  createManagedSyncContext,
  getFirstSyncedRenderer,
  extractCameraParams,
  applyCameraParams,
} from "./vtkJsSync";

import { createPullSync } from "./pullSync";
import { createPushSync, applyPartialArrayUpdate } from "./pushSync";
import { createRafScheduler } from "./rafScheduler";
import { createSyncController } from "./syncController";

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
    let managedSyncContext = null;
    let interactor = null;
    let resizeObserver = null;
    let synchronizerContext = null;
    let activeRenderer = null;
    let sync = null;
    let disposed = false;

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

    function canRunUpdate() {
      return !disposed && !!sync && !!renderWindow;
    }

    function shouldPauseInteractorRender() {
      return props.syncMode !== "push" && !!interactor;
    }

    async function synchronizeScene() {
      return props.syncMode === "push"
        ? sync.applyQueuedState()
        : sync.update();
    }

    function updateActiveRenderer() {
      const syncedRenderer = getFirstSyncedRenderer(renderWindow);
      if (syncedRenderer) {
        activeRenderer = syncedRenderer;
      }
    }

    function renderScene() {
      if (!disposed && renderWindow) {
        renderWindow.render();
      }
    }

    const updateController = createSyncController({
      canSync: canRunUpdate,
      synchronize: synchronizeScene,
      beforeSync() {
        const pauseInteractorRender = shouldPauseInteractorRender();
        if (pauseInteractorRender) {
          interactor.setEnableRender(false);
        }

        return { pauseInteractorRender };
      },
      onSynced() {
        updateActiveRenderer();
        emit("updated");
      },
      onError(err) {
        console.error("VtkJsLocal: synchronize error", err);
        sync?.requestResync?.();
      },
      finalizeSync(syncContext) {
        if (syncContext?.pauseInteractorRender && interactor) {
          interactor.setEnableRender(true);
        }
        renderScene();
      },
    });

    async function update() {
      return updateController.requestSync();
    }

    function setCamera(params) {
      if (!activeRenderer) return;
      const cam = activeRenderer.getActiveCamera();
      if (!cam) return;
      applyCameraParams(cam, params);
      renderScene();
    }

    function resetCamera() {
      if (!activeRenderer) return;
      activeRenderer.resetCamera();
      renderScene();
    }

    function render() {
      renderScene();
    }

    onMounted(async () => {
      openGLRenderWindow = vtkOpenGLRenderWindow.newInstance();
      openGLRenderWindow.setContainer(container.value);

      renderWindow = vtkRenderWindow.newInstance();
      renderWindow.addView(openGLRenderWindow);

      managedSyncContext = createManagedSyncContext(
        client,
        `vtkjs-local-${props.renderWindow}`,
        renderWindow,
      );
      synchronizerContext = managedSyncContext.synchronizerContext;
      syncRenderWindow = managedSyncContext.syncRenderWindow;

      const rwId = String(props.renderWindow);

      if (props.syncMode === "push") {
        const scheduleUpdate = createRafScheduler(() => {
          update();
        });
        sync = createPushSync(
          client,
          syncRenderWindow,
          synchronizerContext,
          rwId,
          {
            onStateReceived() {
              scheduleUpdate();
            },
            async onPartialUpdate(partialUpdate, syncCtx) {
              if (sync?.getQueueLength?.() > 0) {
                await sync.applyQueuedState();
              }

              const applied = applyPartialArrayUpdate(partialUpdate, syncCtx);
              if (applied) {
                renderScene();
              } else {
                sync?.requestResync?.();
              }
            },
          },
        );
      } else {
        sync = createPullSync(
          client,
          syncRenderWindow,
          synchronizerContext,
          rwId,
        );
      }

      if (props.syncMode === "pull") {
        await update();
      }

      interactor = vtkRenderWindowInteractor.newInstance();
      interactor.setInteractorStyle(
        vtkInteractorStyleTrackballCamera.newInstance(),
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
      disposed = true;

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

      managedSyncContext?.cleanup();
      managedSyncContext = null;
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
