import { inject, onMounted, onBeforeUnmount } from "vue";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import "@kitware/vtk.js/Rendering/Profiles/Glyph";

import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import vtkExternalContextRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/ExternalContextRenderWindow";

import { createRafScheduler } from "./rafScheduler";
import { useSceneSync } from "./useSceneSync";
import { createDistanceToCameraRenderCallback } from "./distanceToCameraGlyphs";
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
  },
  setup(props, { emit }) {
    const trame = inject("trame");
    const client = props.wsClient || trame?.client;

    let externalRenderWindow = null;
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
      cameraAuthority: props.cameraAuthority,
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
      externalRenderWindow = vtkExternalContextRenderWindow.createFromContext(
        canvas,
        gl,
      );
      // Apply the stock vtkRenderer preserve-color/depth policy for every
      // layer. The synchronized renderer state decides which attachments load
      // existing contents and which clear before drawing.
      externalRenderWindow.setAutoClear(true);
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
      externalRenderWindow?.renderExternal?.(hostState);
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
    const viewApi = createViewApi(scene, {
      initializeForExternalContext,
      renderExternal,
      onRenderRequested,
      setRepaintCallback,
    });

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

      renderWindow?.delete?.();
      renderWindow = null;
    });

    return viewApi;
  },
  template: `<div style="display: none;"></div>`,
};
