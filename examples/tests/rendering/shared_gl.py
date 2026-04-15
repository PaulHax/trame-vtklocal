"""Shared GL context — sync state at render time test server.

Creates a VTK scene (red cone) with VtkJsSharedView in syncStateAtRender mode.
Exposes JS helpers for Playwright to verify state is applied during renderShared().

    pytest tests/test_shared_gl_context.py -v --headed
"""

import numpy as np
import vtk
from urllib.parse import quote as url_quote

from trame.app import get_server
from trame.ui.html import DivLayout
from trame.widgets import html, client
from trame_vtklocal.widgets import VtkJsSharedView
from trame_client.utils.testing import enable_testing


def create_vtk_pipeline():
    renderer = vtk.vtkRenderer()
    renderer.SetBackground(0, 0, 0)
    renderer.SetBackgroundAlpha(0)

    rw = vtk.vtkRenderWindow()
    rw.SetSize(600, 300)
    rw.AddRenderer(renderer)
    rw.OffScreenRenderingOn()

    cone = vtk.vtkConeSource()
    mapper = vtk.vtkPolyDataMapper()
    mapper.SetInputConnection(cone.GetOutputPort())
    actor = vtk.vtkActor()
    actor.SetMapper(mapper)
    actor.GetProperty().SetColor(1, 0, 0)
    renderer.AddActor(actor)
    renderer.ResetCamera()
    rw.Render()

    return rw, actor, cone


JS_CODE = r"""
(function() {
    let vtkView = null;
    let initialized = false;

    window.initSharedGLTest = function() {
        if (initialized) return;

        const ref = window.trame?.refs?.vtkView;
        vtkView = ref?.initializeForSharedContext ? ref : ref?.$.exposed || ref;

        if (!vtkView?.initializeForSharedContext) {
            setTimeout(window.initSharedGLTest, 100);
            return;
        }

        initialized = true;

        const canvas = document.getElementById('shared-canvas');
        const gl = canvas.getContext('webgl2', {
            preserveDrawingBuffer: true,
            antialias: false
        });

        vtkView.initializeForSharedContext(canvas, gl, { syncStateAtRender: true });
        vtkView.onRenderRequested(function() {
            vtkView.renderShared({});
        });
        window.trame.trigger('sync');
    };

    window.testDisableAutoRender = function() {
        vtkView.onRenderRequested(function() {});
    };

    window.testRenderSharedDrainsQueue = function() {
        vtkView.renderShared({});
        return !vtkView.applyQueuedStateSync();
    };

    window.testGetDeltaQueueLength = function() {
        return vtkView.getQueueLength();
    };

    window.testCommonSceneApi = function() {
        const methods = [
            "update",
            "requestResync",
            "applyQueuedStateSync",
            "getQueueLength",
            "getRenderWindow",
            "getRenderer",
            "setCamera",
            "resetCamera",
        ];
        const missing = methods.filter((name) => typeof vtkView?.[name] !== "function");
        const renderer = vtkView?.getRenderer?.();
        const camera = renderer?.getActiveCamera?.();

        let cameraChanged = false;
        let cameraReset = false;
        if (camera) {
            const before = camera.getParallelScale();
            vtkView.setCamera({ parallelScale: before * 0.5 });
            const afterSet = camera.getParallelScale();
            vtkView.resetCamera();
            const afterReset = camera.getParallelScale();
            cameraChanged = afterSet !== before;
            cameraReset = afterReset !== afterSet;
        }

        return {
            ready: !!vtkView,
            missing,
            hasRenderer: !!renderer,
            cameraChanged,
            cameraReset,
            idleQueueDrained: !vtkView?.applyQueuedStateSync?.(),
        };
    };

    window.testGetRendererHandlesBrokenRendererCollection = function() {
        const renderWindow = vtkView?.getRenderWindow?.();
        if (!renderWindow) {
            return { ready: false, threw: false, value: null };
        }

        const saved = renderWindow.getRenderersByReference?.();
        const broken = {
            [Symbol.iterator]() {
                throw new TypeError("Cannot read properties of null (reading 'getRenderers')");
            },
        };

        renderWindow.set({ renderers: broken }, true, true);

        try {
            const renderer = vtkView.getRenderer();
            return {
                ready: true,
                threw: false,
                value: renderer === null ? null : renderer.getClassName?.() || "renderer",
            };
        } catch (error) {
            return {
                ready: true,
                threw: true,
                message: error?.message || String(error),
            };
        } finally {
            renderWindow.set({ renderers: saved }, true, true);
        }
    };

    window.testGetRendererIgnoresNullRendererEntries = function() {
        const renderWindow = vtkView?.getRenderWindow?.();
        if (!renderWindow) {
            return { ready: false, threw: false, sameRenderer: false };
        }

        const saved = renderWindow.getRenderersByReference?.();
        const liveRenderer = saved?.[0] || null;

        renderWindow.set({ renderers: [null, liveRenderer] }, true, true);

        try {
            const renderer = vtkView.getRenderer();
            return {
                ready: true,
                threw: false,
                sameRenderer: renderer === liveRenderer,
            };
        } catch (error) {
            return {
                ready: true,
                threw: true,
                sameRenderer: false,
                message: error?.message || String(error),
            };
        } finally {
            renderWindow.set({ renderers: saved }, true, true);
        }
    };

    window.__consoleErrors = [];
    const origError = console.error;
    console.error = function() {
        window.__consoleErrors.push(Array.from(arguments).join(' '));
        origError.apply(console, arguments);
    };
    const origWarn = console.warn;
    console.warn = function() {
        window.__consoleErrors.push(Array.from(arguments).join(' '));
        origWarn.apply(console, arguments);
    };

    if (document.readyState === 'complete') {
        setTimeout(window.initSharedGLTest, 100);
    } else {
        window.addEventListener('load', function() {
            setTimeout(window.initSharedGLTest, 100);
        });
    }
})();
"""


class SharedGLTest:
    def __init__(self, server=None):
        self.server = enable_testing(get_server(server), "rendering_ready")
        self.render_window, self.actor, self.cone = create_vtk_pipeline()
        self._build_ui()

    def _build_ui(self):
        server = self.server
        ctrl = server.controller
        server.state.rendering_ready = 0

        server.enable_module(
            {"scripts": [f"data:text/javascript,{url_quote(JS_CODE)}"]}
        )

        with DivLayout(server):
            html.Div("{{ rendering_ready }}", classes="readyCount")
            client.Style(
                "body { margin: 0; } "
                ".readyCount { z-index: 10; position: absolute; left: 0; top: 0; }"
            )
            html.Canvas(
                id="shared-canvas",
                width=600,
                height=300,
                style="position: absolute; left: 0; top: 0; width: 600px; height: 300px;",
            )
            view = VtkJsSharedView(
                self.render_window,
                ref="vtkView",
                on_ready="window.initSharedGLTest?.()",
                updated="rendering_ready++",
            )

        ctrl.view_update = view.update
        ctrl.view_flush = view.flush
        ctrl.mark_modified = view.mark_modified

        @server.trigger("sync")
        def sync():
            self.render_window.Render()
            view.update()

        @server.trigger("change_color")
        def change_color():
            self.actor.GetProperty().SetColor(0, 1, 0)
            self.render_window.Render()
            view.update()

        @server.trigger("partial_move")
        def partial_move():
            self.cone.Update()
            polydata = self.cone.GetOutput()
            pts = polydata.GetPoints()
            arr = np.array(pts.GetData())
            arr += 0.5
            for i in range(len(arr)):
                pts.SetPoint(i, *arr[i])
            pts.Modified()
            polydata.Modified()
            view.mark_modified(polydata, "points", start=0, count=len(arr))
            view.flush()

        @server.trigger("mark_then_update")
        def mark_then_update():
            self.cone.Update()
            polydata = self.cone.GetOutput()
            pts = polydata.GetPoints()
            arr = np.array(pts.GetData())
            arr -= 0.5
            for i in range(len(arr)):
                pts.SetPoint(i, *arr[i])
            pts.Modified()
            polydata.Modified()
            view.mark_modified(polydata, "points", start=0, count=len(arr))
            view.update()


def main():
    app = SharedGLTest()
    app.server.start()


if __name__ == "__main__":
    main()
