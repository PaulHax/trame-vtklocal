"""Shared GL context — push sync v2 test server.

Creates a VTK scene (red cone) with VtkJsSharedView on the scene-ops
protocol. Exposes JS helpers for Playwright to verify broadcast state
reaches the client engine (including the automatic patchArray region path)
and that the common scene API stays intact.

    pytest tests/test_shared_gl_context.py -v --headed
"""

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
        vtkView = ref?.initializeForExternalContext ? ref : ref?.$.exposed || ref;

        if (!vtkView?.initializeForExternalContext) {
            setTimeout(window.initSharedGLTest, 100);
            return;
        }

        initialized = true;

        const canvas = document.getElementById('shared-canvas');
        const gl = canvas.getContext('webgl2', {
            preserveDrawingBuffer: true,
            antialias: false
        });

        vtkView.initializeForExternalContext(canvas, gl);
        vtkView.onRenderRequested(function() {
            vtkView.renderExternal({});
        });
    };

    window.testGetDiagnostics = function() {
        return vtkView?.getSyncDiagnostics?.() || null;
    };

    window.testWaitForSeq = function(target, timeoutMs) {
        const deadline = Date.now() + (timeoutMs || 5000);
        return new Promise(function (resolve, reject) {
            function tick() {
                const diag = window.testGetDiagnostics();
                if (diag && diag.mySeq >= target) {
                    resolve(diag);
                    return;
                }
                if (Date.now() > deadline) {
                    reject(new Error(
                        'waitForSeq(' + target + ') timed out; diagnostics=' +
                        JSON.stringify(diag)));
                    return;
                }
                setTimeout(tick, 16);
            }
            tick();
        });
    };

    // Color-bearing props of every applied vtkProperty node, so the test can
    // assert a server-side SetColor reached the client's live instances.
    window.testGetAppliedPropertyColors = function() {
        const state = vtkView?.getAppliedSceneState?.();
        if (!state) return null;
        const colors = [];
        for (const node of Object.values(state.nodes || {})) {
            if (node.type === 'vtkProperty' && node.props) {
                colors.push({
                    color: node.props.color || null,
                    diffuseColor: node.props.diffuseColor || null,
                });
            }
        }
        return colors;
    };

    // Flat content of every applied polydata "points" array (base64), so the
    // test can assert in-place point moves reached the bound vtk.js arrays.
    window.testGetAppliedPointsContent = function() {
        const state = vtkView?.getAppliedSceneState?.();
        if (!state) return null;
        const contents = [];
        for (const node of Object.values(state.nodes || {})) {
            const entry = node.arrays && node.arrays.points;
            if (entry && entry.content) {
                contents.push(entry.content);
            }
        }
        return contents;
    };

    window.testCommonSceneApi = function() {
        const methods = [
            "requestResync",
            "getQueueLength",
            "getRenderWindow",
            "getRenderer",
            "setCamera",
            "resetCamera",
            "getSyncDiagnostics",
            "getAppliedSceneState",
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
        self.view = view

        @server.trigger("change_color")
        def change_color():
            self.actor.GetProperty().SetColor(0, 1, 0)
            view.sync()
            return {"seq": int(view._publisher.store.seq)}

        @server.trigger("nudge_point")
        def nudge_point():
            # In-place single-point move: the first call pays the full array
            # send that starts hot-array retention; subsequent calls must ride
            # the wire as patchArray region ops.
            self.cone.Update()
            polydata = self.cone.GetOutput()
            pts = polydata.GetPoints()
            x, y, z = pts.GetPoint(0)
            pts.SetPoint(0, x + 0.1, y, z)
            pts.Modified()
            polydata.Modified()
            view.sync()
            return {"seq": int(view._publisher.store.seq)}


def main():
    app = SharedGLTest()
    app.server.start()


if __name__ == "__main__":
    main()
