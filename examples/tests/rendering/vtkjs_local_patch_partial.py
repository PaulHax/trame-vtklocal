"""VtkJsLocalView patch/partial sequencing test server.

Exercises the real vtk.js local view with a sequence that mirrors Points:
normal update, partial point edit, normal update, then another partial edit.
"""

from urllib.parse import quote as url_quote

import vtk

from trame.app import get_server
from trame.ui.html import DivLayout
from trame.widgets import client, html
from trame_client.utils.testing import enable_testing
from trame_vtklocal.widgets import VtkJsLocalView


FULL_SCREEN = "position:absolute; left:0; top:0; width:600px; height:300px;"


def create_vtk_pipeline():
    renderer = vtk.vtkRenderer()
    renderer.SetBackground(0, 0, 0)
    renderer.SetBackgroundAlpha(0)

    render_window = vtk.vtkRenderWindow()
    render_window.SetSize(600, 300)
    render_window.AddRenderer(renderer)
    render_window.OffScreenRenderingOn()

    points = vtk.vtkPoints()
    points.SetDataTypeToFloat()
    points.InsertNextPoint(0.0, 0.0, 0.0)

    verts = vtk.vtkCellArray()
    verts.InsertNextCell(1)
    verts.InsertCellPoint(0)

    polydata = vtk.vtkPolyData()
    polydata.SetPoints(points)
    polydata.SetVerts(verts)

    mapper = vtk.vtkPolyDataMapper()
    mapper.SetInputData(polydata)

    actor = vtk.vtkActor()
    actor.SetMapper(mapper)
    actor.GetProperty().SetColor(1, 0, 0)
    actor.GetProperty().SetPointSize(20)
    renderer.AddActor(actor)
    renderer.ResetCamera()
    render_window.Render()

    return render_window, polydata, points


JS_CODE = r"""
(function() {
    let vtkView = null;
    let initialized = false;

    function resolveView() {
        const ref = window.trame?.refs?.vtkView;
        return ref?.getRenderWindow ? ref : ref?.$.exposed || ref;
    }

    function getFirstActor() {
        const renderer = vtkView?.getRenderer?.();
        const actors = renderer?.getActors?.() || renderer?.getViewProps?.() || [];
        return actors.find((actor) => actor?.getMapper?.()) || null;
    }

    window.initVtkJsLocalPatchPartialTest = function() {
        if (initialized) return;

        vtkView = resolveView();
        if (!vtkView?.applyQueuedStateSync || !vtkView?.getRenderer) {
            setTimeout(window.initVtkJsLocalPatchPartialTest, 100);
            return;
        }

        initialized = true;
        window.trame.trigger('sync');
    };

    window.testApplyQueuedStateSync = function() {
        return vtkView?.applyQueuedStateSync?.() || false;
    };

    window.testGetDeltaQueueLength = function() {
        return vtkView?.getQueueLength?.() ?? -1;
    };

    window.testFirstPoint = function() {
        vtkView?.applyQueuedStateSync?.();
        const actor = getFirstActor();
        const input = actor?.getMapper?.()?.getInputData?.();
        const data = input?.getPoints?.()?.getData?.();
        return data ? Array.from(data.slice(0, 3)) : null;
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
        setTimeout(window.initVtkJsLocalPatchPartialTest, 100);
    } else {
        window.addEventListener('load', function() {
            setTimeout(window.initVtkJsLocalPatchPartialTest, 100);
        });
    }
})();
"""


class VtkJsLocalPatchPartialTest:
    def __init__(self, server=None):
        self.server = enable_testing(get_server(server), "local_rendering_ready")
        self.render_window, self.polydata, self.points = create_vtk_pipeline()
        self._build_ui()

    def _build_ui(self):
        server = self.server
        server.state.local_rendering_ready = 0

        server.enable_module(
            {"scripts": [f"data:text/javascript,{url_quote(JS_CODE)}"]}
        )

        with DivLayout(server):
            html.Div("{{ local_rendering_ready }}", classes="readyCount")
            client.Style(
                "body { margin: 0; } "
                ".readyCount { z-index: 10; position: absolute; left: 0; top: 0; }"
            )
            view = VtkJsLocalView(
                self.render_window,
                ref="vtkView",
                on_ready="window.initVtkJsLocalPatchPartialTest?.()",
                updated="local_rendering_ready++",
                style=FULL_SCREEN,
            )

        @server.trigger("sync")
        def sync():
            self.render_window.Render()
            view.update()

        @server.trigger("patch_move")
        def patch_move():
            self._set_point_x(0.2)
            view.update()

        @server.trigger("partial_move")
        def partial_move():
            self._set_point_x(0.4)
            view.mark_modified(self.polydata, "points", start=0, count=1)
            view.flush()

        @server.trigger("patch_move_again")
        def patch_move_again():
            self._set_point_x(0.6)
            view.update()

        @server.trigger("partial_move_again")
        def partial_move_again():
            self._set_point_x(0.8)
            view.mark_modified(self.polydata, "points", start=0, count=1)
            view.flush()

    def _set_point_x(self, x):
        self.points.SetPoint(0, x, 0.0, 0.0)
        self.points.GetData().Modified()
        self.points.Modified()
        self.polydata.Modified()
        self.render_window.Render()


def main():
    app = VtkJsLocalPatchPartialTest()
    app.server.start()


if __name__ == "__main__":
    main()
