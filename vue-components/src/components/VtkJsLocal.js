import { ref, inject, onMounted, onBeforeUnmount } from "vue";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import "@kitware/vtk.js/Rendering/Profiles/Glyph";

import macro from "@kitware/vtk.js/macros";
import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import vtkRenderWindowInteractor from "@kitware/vtk.js/Rendering/Core/RenderWindowInteractor";
import vtkOpenGLRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/RenderWindow";
import vtkInteractorStyleTrackballCamera from "@kitware/vtk.js/Interaction/Style/InteractorStyleTrackballCamera";

import { createRafScheduler } from "./rafScheduler";
import { useSceneSync } from "./useSceneSync";
import { createViewApi, VIEW_EMITS, VIEW_PROPS } from "./viewApi";
import { registerView, unregisterView } from "./viewRegistry";
import { getDevicePixelRatio } from "./viewportMetrics";

// Every paint of the owned canvas reaches its OpenGL window as one
// traverseAllPasses call: the interactor paints drag frames itself and ignores
// render requests until the drag ends. `paint` wraps that call, so the
// pre-render pass and the paint record follow the pixels, not a caller.
function newOpenGLRenderWindow(paint) {
  return macro.newInstance((publicAPI, model, initialValues) => {
    vtkOpenGLRenderWindow.extend(publicAPI, model, initialValues);
    const traverseAllPasses = publicAPI.traverseAllPasses;
    publicAPI.traverseAllPasses = () => paint(traverseAllPasses);
  })();
}

export default {
  emits: VIEW_EMITS,
  props: VIEW_PROPS,
  setup(props, { emit }) {
    const trame = inject("trame");
    const container = ref(null);
    const client = props.wsClient || trame?.client;

    let openGLRenderWindow = null;
    let renderWindow = null;
    let interactor = null;
    let resizeObserver = null;
    let cameraSubscriptions = [];

    function paint(traverseAllPasses) {
      scene.beforeRender();
      // Measure the paint's wall-time for the adaptive-quality budget loop.
      const start = performance.now();
      try {
        traverseAllPasses();
      } finally {
        scene.recordPaintDuration(performance.now() - start);
      }
    }

    function renderScene() {
      renderWindow?.render();
    }

    const scene = useSceneSync({
      client,
      emit,
      getRenderWindow: () => renderWindow,
      getOpenGLRenderWindow: () => openGLRenderWindow,
      tiles3dTexturePolicy: props.tiles3dTexturePolicy,
      tiles3dQualityPolicy: props.tiles3dQualityPolicy,
      streamedMemoryBudgetBytes: props.streamedMemoryBudgetBytes,
    });

    // State applies in the websocket handler; only rendering rides rAF (a
    // hidden tab stays current and repaints on the next visible frame).
    const scheduleRender = createRafScheduler(() => {
      renderScene();
    });

    function resize() {
      if (!container.value || !openGLRenderWindow) return;

      const { width, height } = container.value.getBoundingClientRect();
      const devicePixelRatio = getDevicePixelRatio();
      const w = Math.floor(width * devicePixelRatio);
      const h = Math.floor(height * devicePixelRatio);

      if (w === 0 || h === 0) return;

      openGLRenderWindow.setSize(w, h);
      renderScene();
    }

    const viewApi = createViewApi(scene, {
      container,
      render: renderScene,
      resize,
    });
    const registryKeys = [props.viewKey, props.renderWindow];

    onMounted(async () => {
      openGLRenderWindow = newOpenGLRenderWindow(paint);
      openGLRenderWindow.setContainer(container.value);

      renderWindow = vtkRenderWindow.newInstance();
      renderWindow.addView(openGLRenderWindow);

      scene.initialize({
        renderWindowId: props.renderWindow,
        onRenderNeeded() {
          scheduleRender();
        },
      });

      interactor = vtkRenderWindowInteractor.newInstance();
      const interactorStyle = vtkInteractorStyleTrackballCamera.newInstance();
      interactor.setInteractorStyle(interactorStyle);
      interactor.setView(openGLRenderWindow);
      interactor.initialize();
      interactor.bindEvents(container.value);
      scene.enableCameraReports({ during: "interaction", terminal: true });
      // The Start/End/InteractionEvent trio fires on the interactor STYLE;
      // the interactor's .d.ts declares them but its runtime never does.
      cameraSubscriptions = [
        interactorStyle.onStartInteractionEvent(() =>
          scene.beginCameraInteraction(),
        ),
        interactorStyle.onInteractionEvent(scene.cameraInteraction),
        interactorStyle.onEndInteractionEvent(scene.endCameraInteraction),
      ];

      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(container.value);

      resize();
      registerView(registryKeys, viewApi);
      emit("onReady");
    });

    onBeforeUnmount(() => {
      unregisterView(registryKeys, viewApi);
      scene.cleanup();

      cameraSubscriptions.forEach((subscription) =>
        subscription.unsubscribe?.(),
      );
      cameraSubscriptions = [];

      resizeObserver?.disconnect?.();
      resizeObserver = null;

      if (interactor) {
        interactor.unbindEvents();
        interactor.delete();
        interactor = null;
      }

      openGLRenderWindow?.delete?.();
      openGLRenderWindow = null;

      renderWindow?.delete?.();
      renderWindow = null;
    });

    return viewApi;
  },
  template: `<div ref="container" style="position: relative; width: 100%; height: 100%;"></div>`,
};
