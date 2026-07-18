import { ref, inject, onMounted, onBeforeUnmount } from "vue";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import "@kitware/vtk.js/Rendering/Profiles/Glyph";

import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import vtkRenderWindowInteractor from "@kitware/vtk.js/Rendering/Core/RenderWindowInteractor";
import vtkOpenGLRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/RenderWindow";
import vtkInteractorStyleTrackballCamera from "@kitware/vtk.js/Interaction/Style/InteractorStyleTrackballCamera";

import { createRafScheduler } from "./rafScheduler";
import { useSceneSync } from "./useSceneSync";
import { bindDistanceToCameraInteractorRenderEvent } from "./distanceToCameraGlyphs";
import { createViewApi } from "./viewApi";
import { registerView, unregisterView } from "./viewRegistry";

export default {
  emits: [
    "updated",
    "camera",
    "command",
    "onReady",
    "beforeSceneLoaded",
    "afterSceneLoaded",
    "messageApplied",
    "pointerEvent",
  ],
  props: {
    renderWindow: {
      type: Number,
      required: true,
    },
    cameraAuthority: {
      type: String,
      default: "server",
      validator: (value) => value === "server" || value === "client",
    },
    wsClient: {
      type: Object,
    },
    viewKey: {
      type: String,
      default: null,
    },
  },
  setup(props, { emit }) {
    const trame = inject("trame");
    const container = ref(null);
    const client = props.wsClient || trame?.client;

    let openGLRenderWindow = null;
    let renderWindow = null;
    let interactor = null;
    let resizeObserver = null;
    let interactorRenderSubscription = null;
    let cameraSubscriptions = [];

    function renderScene() {
      scene.updateDistanceToCameraGlyphs();
      // Measure the paint's wall-time for the adaptive-quality budget loop.
      const start = performance.now();
      try {
        renderWindow?.render?.();
      } finally {
        scene.recordFrameDuration(performance.now() - start);
      }
    }

    const scene = useSceneSync({
      client,
      emit,
      getRenderWindow: () => renderWindow,
      renderScene,
      cameraAuthority: props.cameraAuthority,
    });

    // State applies in the websocket handler; only rendering rides rAF (a
    // hidden tab stays current and repaints on the next visible frame).
    const scheduleRender = createRafScheduler(() => {
      renderScene();
    });

    function resize() {
      if (!container.value || !openGLRenderWindow) return;

      const { width, height } = container.value.getBoundingClientRect();
      const devicePixelRatio = window.devicePixelRatio || 1;
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
      openGLRenderWindow = vtkOpenGLRenderWindow.newInstance();
      openGLRenderWindow.setContainer(container.value);

      renderWindow = vtkRenderWindow.newInstance();
      renderWindow.addView(openGLRenderWindow);

      scene.initialize({
        contextName: `vtkjs-local-${props.renderWindow}`,
        renderWindowId: props.renderWindow,
        onRenderNeeded() {
          scheduleRender();
        },
        onMessageApplied(message) {
          emit("messageApplied", message);
        },
      });

      interactor = vtkRenderWindowInteractor.newInstance();
      const interactorStyle = vtkInteractorStyleTrackballCamera.newInstance();
      interactor.setInteractorStyle(interactorStyle);
      interactor.setView(openGLRenderWindow);
      interactor.initialize();
      interactor.bindEvents(container.value);
      interactorRenderSubscription = bindDistanceToCameraInteractorRenderEvent(
        interactor,
        () => {
          scene.updateDistanceToCameraGlyphs();
          scene.updatePointCloudLods();
        },
      );
      scene.enableCameraReports({ during: "interaction", terminal: true });
      // The Start/End/InteractionEvent trio fires on the interactor STYLE;
      // the interactor's .d.ts declares them but its runtime never does.
      cameraSubscriptions = [
        interactorStyle.onStartInteractionEvent(scene.beginCameraInteraction),
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

      interactorRenderSubscription?.unsubscribe?.();
      interactorRenderSubscription = null;
      cameraSubscriptions.forEach((subscription) => subscription.unsubscribe?.());
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
