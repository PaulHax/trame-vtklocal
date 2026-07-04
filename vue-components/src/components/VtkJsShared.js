import { inject, onMounted, onBeforeUnmount } from "vue";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import "@kitware/vtk.js/Rendering/Profiles/Glyph";

import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import vtkExternalContextRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/ExternalContextRenderWindow";

import { createRafScheduler } from "./rafScheduler";
import { useSceneSync } from "./useSceneSync";
import { createDistanceToCameraRenderCallback } from "./distanceToCameraGlyphs";
import { registerView, unregisterView } from "./viewRegistry";
import { applyExternalRenderPolicy } from "./externalRenderPolicy";

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

    let externalRenderWindow = null;
    let externalContextGl = null;
    let renderWindow = null;
    let renderRequestedCallbackWithDistanceToCamera = null;
    let repaintCallback = null;

    function renderScene() {
      if (renderRequestedCallbackWithDistanceToCamera) {
        renderRequestedCallbackWithDistanceToCamera();
        return;
      }
      scene.updateDistanceToCameraGlyphs();
      externalRenderWindow?.renderExternal?.();
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

    function initializeForExternalContext(canvas, gl) {
      externalContextGl = gl;

      externalRenderWindow = vtkExternalContextRenderWindow.createFromContext(canvas, gl);
      externalRenderWindow?.setRenderCallback?.(
        renderRequestedCallbackWithDistanceToCamera,
      );

      renderWindow = vtkRenderWindow.newInstance();
      renderWindow.addView(externalRenderWindow);

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

    // options:
    //   clearDepth = true — the shared-buffer depth-clear policy the host
    //     needs around the render (see externalRenderPolicy.js).
    //   framebuffer / drawBuffers — host-declared GL state, forwarded to
    //     vtk.js so the render issues no gl.getParameter readbacks (each one
    //     is a synchronous CPU/GPU stall). Omit to let vtk.js query.
    function renderExternal(options = {}) {
      scene.updateDistanceToCameraGlyphs();
      const hostState =
        "framebuffer" in options
          ? {
              framebuffer: options.framebuffer,
              drawBuffers: options.drawBuffers,
            }
          : undefined;
      applyExternalRenderPolicy(
        externalContextGl,
        () => externalRenderWindow?.renderExternal?.(hostState),
        { clearDepth: options.clearDepth },
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
      externalRenderWindow?.setRenderCallback?.(
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
      initializeForExternalContext,
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
      renderExternal,
      onRenderRequested,
      onSceneApplied: scene.onSceneApplied,
      onCommand: scene.onCommand,
      getInstance: scene.getInstance,
      getSeq: scene.getSeq,
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

      externalRenderWindow?.delete?.();
      externalRenderWindow = null;
      externalContextGl = null;

      renderWindow?.delete?.();
      renderWindow = null;
    });

    return viewApi;
  },
  template: `<div style="display: none;"></div>`,
};
