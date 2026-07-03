import { ref, inject, onMounted, onBeforeUnmount, watchEffect } from "vue";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import "@kitware/vtk.js/Rendering/Profiles/Glyph";

import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import vtkRenderWindowInteractor from "@kitware/vtk.js/Rendering/Core/RenderWindowInteractor";
import vtkOpenGLRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/RenderWindow";
import vtkInteractorStyleTrackballCamera from "@kitware/vtk.js/Interaction/Style/InteractorStyleTrackballCamera";

import { extractCameraParams } from "./vtkJsSync";
import { createRafScheduler } from "./rafScheduler";
import { useSceneSync } from "./useSceneSync";
import { bindDistanceToCameraInteractorRenderEvent } from "./distanceToCameraGlyphs";

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
    wsClient: {
      type: Object,
    },
    syncMode: {
      type: String,
      default: "push",
      validator: (value) => value === "push",
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
    let interactor = null;
    let resizeObserver = null;
    let interactorRenderSubscription = null;

    function renderScene() {
      scene.updateDistanceToCameraGlyphs();
      renderWindow?.render?.();
    }

    const scene = useSceneSync({
      client,
      emit,
      getRenderWindow: () => renderWindow,
      renderScene,
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
      interactor.setInteractorStyle(
        vtkInteractorStyleTrackballCamera.newInstance(),
      );
      interactor.setView(openGLRenderWindow);
      interactor.initialize();
      interactor.bindEvents(container.value);
      interactorRenderSubscription = bindDistanceToCameraInteractorRenderEvent(
        interactor,
        () => scene.updateDistanceToCameraGlyphs(),
      );

      interactor.onEndInteraction(() => {
        const camera = scene.getRenderer()?.getActiveCamera?.();
        if (camera) {
          emit("camera", extractCameraParams(camera));
        }
      });

      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(container.value);

      resize();
      emit("onReady");
    });

    onBeforeUnmount(() => {
      scene.cleanup();

      interactorRenderSubscription?.unsubscribe?.();
      interactorRenderSubscription = null;

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

    watchEffect(() => {
      if (props.interactorSettings && interactor) {
        const style = interactor.getInteractorStyle();
        if (style?.applySettings) {
          style.applySettings(props.interactorSettings);
        }
      }
    });

    return {
      container,
      update: scene.update,
      requestResync: scene.requestResync,
      getQueueLength: scene.getQueueLength,
      getRenderWindow: scene.getRenderWindow,
      getRenderer: scene.getRenderer,
      setCamera: scene.setCamera,
      resetCamera: scene.resetCamera,
      onCommand: scene.onCommand,
      pickAt: scene.pickAt,
      startTargetDrag: scene.startTargetDrag,
      emitTargetClick: scene.emitTargetClick,
      setPointerContext: scene.setPointerContext,
      setEmitBackgroundClick: scene.setEmitBackgroundClick,
      // Diagnostics / oracle support (read-only, not general app integration).
      getSyncDiagnostics: scene.getSyncDiagnostics,
      getAppliedSceneState: scene.getAppliedSceneState,
      render: renderScene,
      resize,
    };
  },
  template: `<div ref="container" style="position: relative; width: 100%; height: 100%;"></div>`,
};
