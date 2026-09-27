import { inject, onMounted, onBeforeUnmount } from "vue";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import "@kitware/vtk.js/Rendering/Profiles/Glyph";

import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import vtkExternalContextRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/ExternalContextRenderWindow";

import { createRafScheduler } from "./rafScheduler";
import { useSceneSync } from "./useSceneSync";
import { createViewApi, VIEW_EMITS, VIEW_PROPS } from "./viewApi";
import { registerView, unregisterView } from "./viewRegistry";

export default {
  emits: VIEW_EMITS,
  props: VIEW_PROPS,
  setup(props, { emit }) {
    const trame = inject("trame");
    const client = props.wsClient || trame?.client;

    let externalRenderWindow = null;
    let renderWindow = null;
    let renderRequested = null;
    let repaintCallback = null;

    const scene = useSceneSync({
      client,
      emit,
      getRenderWindow: () => renderWindow,
      getOpenGLRenderWindow: () => externalRenderWindow,
      tiles3dTexturePolicy: props.tiles3dTexturePolicy,
      tiles3dQualityPolicy: props.tiles3dQualityPolicy,
      streamedMemoryBudgetBytes: props.streamedMemoryBudgetBytes,
    });

    const scheduleRender = createRafScheduler(() => {
      renderRequested?.();
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
      externalRenderWindow.setRenderCallback(renderRequested);

      renderWindow = vtkRenderWindow.newInstance();
      renderWindow.addView(externalRenderWindow);

      scene.initialize({
        renderWindowId: props.renderWindow,
        onRenderNeeded() {
          requestRender();
        },
      });
    }

    // options:
    //   framebuffer / drawBuffers — host-declared GL state, forwarded to
    //     vtk.js so the render issues no gl.getParameter readbacks (each one
    //     is a synchronous CPU/GPU stall). Omit to let vtk.js query.
    function renderExternal(options = {}) {
      if (!externalRenderWindow) return;
      scene.beforeRender();
      const hostState =
        "framebuffer" in options
          ? {
              framebuffer: options.framebuffer,
              drawBuffers: options.drawBuffers,
            }
          : undefined;
      // Measure only the paint's wall-time, not the pre-render pass, for the
      // adaptive-quality budget loop.
      const start = performance.now();
      try {
        externalRenderWindow.renderExternal(hostState);
      } finally {
        scene.recordPaintDuration(performance.now() - start);
      }
    }

    // vtk.js hands its own render requests (renderWindow.render(), widget
    // updates) to this callback instead of drawing; the host answers by
    // calling renderExternal when it paints.
    function onRenderRequested(callback) {
      renderRequested = typeof callback === "function" ? callback : null;
      externalRenderWindow?.setRenderCallback(renderRequested);
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
      renderRequested = null;
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
