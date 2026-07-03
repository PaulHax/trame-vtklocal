import { inject, onMounted, onBeforeUnmount } from "vue";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import "@kitware/vtk.js/Rendering/Profiles/Glyph";

import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import vtkSharedRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/SharedRenderWindow";

import { createRafScheduler } from "./rafScheduler";
import { useSceneSync } from "./useSceneSync";
import { createDistanceToCameraRenderCallback } from "./distanceToCameraGlyphs";
import { registerView, unregisterView } from "./viewRegistry";
import { applySharedRenderPolicy } from "./sharedRenderPolicy";

export default {
  emits: [
    "updated",
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
    // The trame ref name this view is mounted under (e.g. "vtkMapView_map").
    // The Python widget sets it to the same value it uses for `ref`, so
    // consumers resolve the view via window.trameVtklocal.whenView(refName).
    viewKey: {
      type: String,
      default: null,
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
    let sharedContextGl = null;
    let renderWindow = null;
    let renderRequestedCallbackWithDistanceToCamera = null;
    let repaintCallback = null;

    function renderScene() {
      if (renderRequestedCallbackWithDistanceToCamera) {
        renderRequestedCallbackWithDistanceToCamera();
        return;
      }
      scene.updateDistanceToCameraGlyphs();
      sharedRenderWindow?.renderShared?.();
    }

    const scene = useSceneSync({
      client,
      emit,
      getRenderWindow: () => renderWindow,
      renderScene,
    });

    const scheduleRender = createRafScheduler(() => {
      renderRequestedCallbackWithDistanceToCamera?.();
    });

    // State is already applied when this fires; the host only needs to paint.
    // The repaint callback lets a host compositor (e.g. a MapLibre custom
    // layer) own frame timing; otherwise the render callback rides rAF.
    function requestRender() {
      if (repaintCallback) {
        repaintCallback();
      } else {
        scheduleRender();
      }
    }

    function initializeForSharedContext(canvas, gl) {
      sharedContextGl = gl;

      sharedRenderWindow = vtkSharedRenderWindow.createFromContext(canvas, gl);
      sharedRenderWindow?.setRenderCallback?.(
        renderRequestedCallbackWithDistanceToCamera,
      );

      renderWindow = vtkRenderWindow.newInstance();
      renderWindow.addView(sharedRenderWindow);

      scene.initialize({
        contextName: `vtkjs-shared-${props.renderWindow}`,
        renderWindowId: props.renderWindow,
        onRenderNeeded() {
          requestRender();
        },
        onMessageApplied(message) {
          emit("messageApplied", message);
        },
      });
    }

    // options: { clearDepth = true } — the shared-buffer depth-clear policy
    // the host needs around the render (see sharedRenderPolicy.js).
    function renderShared(options = {}) {
      scene.updateDistanceToCameraGlyphs();
      applySharedRenderPolicy(
        sharedContextGl,
        () => sharedRenderWindow?.renderShared?.(),
        options,
      );
    }

    function onRenderRequested(callback) {
      renderRequestedCallbackWithDistanceToCamera =
        typeof callback === "function"
          ? createDistanceToCameraRenderCallback(
              () => scene.updateDistanceToCameraGlyphs(),
              callback,
            )
          : null;
      sharedRenderWindow?.setRenderCallback?.(
        renderRequestedCallbackWithDistanceToCamera,
      );
    }

    function setRepaintCallback(callback) {
      repaintCallback = callback;
    }

    // The public API consumers resolve through the registry — the same object
    // returned from setup, so onSceneApplied/getInstance/render methods keep
    // working without unwrapping the Vue component ref.
    const viewApi = {
      initializeForSharedContext,
      update: scene.update,
      requestResync: scene.requestResync,
      getQueueLength: scene.getQueueLength,
      getRenderWindow: scene.getRenderWindow,
      getRenderer: scene.getRenderer,
      setCamera: scene.setCamera,
      setRenderedCamera: scene.setRenderedCamera,
      getRenderedCamera: scene.getRenderedCamera,
      resetCamera: scene.resetCamera,
      // Diagnostics / oracle support (read-only, not general app integration).
      getSyncDiagnostics: scene.getSyncDiagnostics,
      getAppliedSceneState: scene.getAppliedSceneState,
      renderShared,
      onRenderRequested,
      onSceneApplied: scene.onSceneApplied,
      onCommand: scene.onCommand,
      getInstance: scene.getInstance,
      uploadTexture: scene.uploadTexture,
      pickAt: scene.pickAt,
      startTargetDrag: scene.startTargetDrag,
      emitTargetClick: scene.emitTargetClick,
      setPointerContext: scene.setPointerContext,
      setEmitBackgroundClick: scene.setEmitBackgroundClick,
      setRepaintCallback,
    };

    // Keyed by trame ref name and render-window id so consumers can await
    // whenView(refName) (or look up by render-window id) with no polling.
    const registryKeys = [props.viewKey, props.renderWindow];

    onMounted(() => {
      registerView(registryKeys, viewApi);
      emit("onReady");
    });

    onBeforeUnmount(() => {
      unregisterView(registryKeys, viewApi);
      // A rAF render scheduled before unmount must not reach the host.
      renderRequestedCallbackWithDistanceToCamera = null;
      repaintCallback = null;
      scene.cleanup();

      sharedRenderWindow?.delete?.();
      sharedRenderWindow = null;
      sharedContextGl = null;

      renderWindow?.delete?.();
      renderWindow = null;
    });

    return viewApi;
  },
  template: `<div style="display: none;"></div>`,
};
