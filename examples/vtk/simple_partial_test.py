"""
Simple test for partial array updates.
Uses raw points/lines without tube filter so vtk.js has the actual polydata.
"""

import asyncio
import math
import argparse
from urllib.parse import quote as url_quote

from trame.app import get_server
from trame.widgets import html, vuetify3
from trame.ui.vuetify3 import SinglePageLayout

from trame_vtklocal.widgets import VtkJsSharedView

from vtkmodules.vtkRenderingCore import (
    vtkRenderer,
    vtkRenderWindow,
    vtkPolyDataMapper,
    vtkActor,
)
from vtkmodules.vtkCommonCore import vtkPoints
from vtkmodules.vtkCommonDataModel import vtkPolyData, vtkCellArray
import vtkmodules.vtkRenderingOpenGL2  # noqa

import numpy as np

server = get_server()
server.client_type = "vue3"
state, ctrl = server.state, server.controller

state.trame__title = "Simple Partial Update Test"
state.current_points = 0
state.update_mode = "partial_simple"  # "full_sync", "partial_simple", "partial_fast"

renderer = vtkRenderer()
renderer.SetBackground(0.1, 0.1, 0.2)

renderWindow = vtkRenderWindow()
renderWindow.AddRenderer(renderer)
renderWindow.OffScreenRenderingOn()

MAX_POINTS = 100
points = vtkPoints()
lines = vtkCellArray()
polydata = vtkPolyData()
polydata.SetPoints(points)
polydata.SetLines(lines)

points.SetNumberOfPoints(MAX_POINTS)
for i in range(MAX_POINTS):
    points.SetPoint(i, 0, 0, 0)

# Pre-initialize lines with all points connected (for partial update mode)
lines.InsertNextCell(MAX_POINTS)
for i in range(MAX_POINTS):
    lines.InsertCellPoint(i)

mapper = vtkPolyDataMapper()
mapper.SetInputData(polydata)

actor = vtkActor()
actor.SetMapper(mapper)
actor.GetProperty().SetColor(0.2, 0.8, 1.0)
actor.GetProperty().SetLineWidth(3)
renderer.AddActor(actor)

renderer.ResetCamera()
renderWindow.Render()

trail_state = {"count": 0}
animation_time = 0.0


def add_point(t):
    global animation_time
    count = trail_state["count"]
    if count >= MAX_POINTS:
        return None

    x = math.cos(t) * (0.5 + 0.3 * math.sin(t * 2))
    y = math.sin(t) * (0.5 + 0.3 * math.sin(t * 2))
    z = 0.1 * math.sin(t * 3)

    points.SetPoint(count, x, y, z)
    trail_state["count"] = count + 1
    state.current_points = count + 1

    # Lines are pre-initialized with all 100 points, so no need to rebuild
    points.Modified()
    polydata.Modified()

    return (x, y, z), count


async def animate():
    global animation_time

    # Ensure full initial sync before partial updates
    ctrl.view_update(inline_arrays=True)
    state.flush()
    await asyncio.sleep(0.2)

    while True:
        if trail_state["count"] < MAX_POINTS:
            animation_time += 0.15
            result = add_point(animation_time)

            if result:
                (x, y, z), idx = result

                if state.update_mode == "full_sync":
                    # Full state sync every frame
                    ctrl.view_update(inline_arrays=True)

                elif state.update_mode == "partial_simple":
                    # Simple API - library extracts data from VTK
                    ctrl.mark_modified(polydata, "points", start=idx, count=1)
                    ctrl.view_update()

                elif state.update_mode == "partial_fast":
                    # Fast API - pass pre-computed bytes (use float32 to match vtk.js)
                    point_bytes = np.array([x, y, z], dtype=np.float32).tobytes()
                    ctrl.mark_modified(
                        polydata, "points", start=idx,
                        data=point_bytes, data_type="Float32Array"
                    )
                    ctrl.view_update()

                state.flush()

        await asyncio.sleep(1.0 / 30)


animation_task = None


@server.trigger("start_animation")
def start_animation():
    global animation_task
    if animation_task is None:
        animation_task = asyncio.create_task(animate())


@server.trigger("reset")
def on_reset():
    global animation_time
    trail_state["count"] = 0
    animation_time = 0.0
    for i in range(MAX_POINTS):
        points.SetPoint(i, 0, 0, 0)
    points.Modified()
    lines.Reset()
    polydata.Modified()
    state.current_points = 0
    ctrl.view_update(inline_arrays=True)


with SinglePageLayout(server) as layout:
    layout.title.set_text("Simple Partial Update Test")

    with layout.toolbar:
        vuetify3.VBtn("Reset", click=(on_reset,), variant="text", size="small")
        vuetify3.VDivider(vertical=True, classes="mx-2")
        vuetify3.VSelect(
            v_model=("update_mode",),
            items=("[{title: 'Full Sync', value: 'full_sync'}, {title: 'Partial (Simple)', value: 'partial_simple'}, {title: 'Partial (Fast)', value: 'partial_fast'}]",),
            label="Mode",
            density="compact",
            hide_details=True,
            style="max-width: 200px;",
        )

    with layout.content:
        with html.Div(
            style="position: relative; width: 100%; height: 100%; overflow: hidden;",
        ):
            with html.Div(
                style="position: absolute; top: 10px; left: 10px; z-index: 100; "
                "background: rgba(0,0,0,0.7); color: white; padding: 10px; "
                "border-radius: 5px; font-family: monospace;",
            ):
                html.Div("Mode: {{ update_mode }}")
                html.Div("Points: {{ current_points }} / 100")

            with html.Div(
                id="vtk-container",
                style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;",
            ):
                view = VtkJsSharedView(
                    renderWindow,
                    ref="vtkView",
                    style="width: 100%; height: 100%;",
                    on_ready="window.initVtkView && window.initVtkView()",
                )
                ctrl.view_update = view.update
                ctrl.view_partial_update = view.update_array_region
                ctrl.mark_modified = view.mark_modified
                ctrl.polydata_id = view.get_instance_id(polydata)


INIT_SCRIPT_JS = """
(function() {
    let initialized = false;

    window.initVtkView = async function() {
        if (initialized) return;

        const vtkViewRef = window.trame?.refs?.['vtkView'];
        const vtkView = vtkViewRef?.initializeForSharedContext ? vtkViewRef :
                       vtkViewRef?.$.exposed ? vtkViewRef.$.exposed :
                       vtkViewRef?.$.setupState;

        if (!vtkView?.initializeForSharedContext) {
            setTimeout(window.initVtkView, 100);
            return;
        }

        initialized = true;

        const container = document.getElementById('vtk-container');
        const canvas = document.createElement('canvas');
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        container.appendChild(canvas);

        const gl = canvas.getContext('webgl2', {
            antialias: true,
            alpha: true,
            preserveDrawingBuffer: true,
        });

        const resizeCanvas = () => {
            const rect = container.getBoundingClientRect();
            canvas.width = rect.width * window.devicePixelRatio;
            canvas.height = rect.height * window.devicePixelRatio;
            gl.viewport(0, 0, canvas.width, canvas.height);
        };
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        vtkView.initializeForSharedContext(canvas, gl, {
            syncStateAtRender: true,
            onResyncRequired: () => {
                window.trame.trigger('vtk_request_resync');
            }
        });

        vtkView.onRenderRequested(() => {
            requestAnimationFrame(() => {
                gl.clearColor(0.1, 0.1, 0.2, 1.0);
                gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
                vtkView.renderShared({});
            });
        });

        window.trame.trigger('start_animation');
    };

    if (document.readyState === 'complete') {
        setTimeout(window.initVtkView, 100);
    } else {
        window.addEventListener('load', () => setTimeout(window.initVtkView, 100));
    }
})();
"""


@server.trigger("vtk_request_resync")
def on_vtk_request_resync():
    view.request_resync()


server.enable_module({"scripts": [f"data:text/javascript,{url_quote(INIT_SCRIPT_JS)}"]})

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8096)
    parser.add_argument("--server", action="store_true")
    args, _ = parser.parse_known_args()

    server.start(port=args.port, open_browser=not args.server)
