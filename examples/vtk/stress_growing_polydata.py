"""
Stress Test: Growing PolyData

Tests VtkJsSharedView performance with incrementally growing geometry.
Adds points to a polydata each frame and measures FPS and latency.

Target: 1000+ points at 30+ fps without visible lag.

Usage:
    .venv/bin/python examples/vtk/stress_growing_polydata.py --port 8090
"""

import asyncio
import time
import argparse
from urllib.parse import quote as url_quote

from trame.app import get_server
from trame.widgets import html, vuetify3
from trame.ui.vuetify3 import SinglePageLayout

from trame_vtklocal.widgets import VtkJsSharedView

from vtkmodules.vtkFiltersSources import vtkSphereSource
from vtkmodules.vtkRenderingCore import (
    vtkRenderer,
    vtkRenderWindow,
    vtkPolyDataMapper,
    vtkActor,
)
from vtkmodules.vtkCommonCore import vtkPoints
from vtkmodules.vtkCommonDataModel import vtkPolyData, vtkCellArray
from vtkmodules.vtkFiltersCore import vtkTubeFilter
import vtkmodules.vtkRenderingOpenGL2  # noqa

import math

server = get_server()
server.client_type = "vue3"
state, ctrl = server.state, server.controller

state.trame__title = "Stress Test: Growing PolyData"
state.animation_paused = False
state.points_per_frame = 5
state.max_points = 2000
state.current_points = 0
state.fps = 0.0
state.frame_time_ms = 0.0
state.update_mode = "sync"

renderer = vtkRenderer()
renderer.SetBackground(0.1, 0.1, 0.2)

renderWindow = vtkRenderWindow()
renderWindow.AddRenderer(renderer)
renderWindow.OffScreenRenderingOn()

sphere_source = vtkSphereSource()
sphere_source.SetRadius(0.02)
sphere_source.SetThetaResolution(8)
sphere_source.SetPhiResolution(8)
sphere_mapper = vtkPolyDataMapper()
sphere_mapper.SetInputConnection(sphere_source.GetOutputPort())
sphere_actor = vtkActor()
sphere_actor.SetMapper(sphere_mapper)
sphere_actor.GetProperty().SetColor(1.0, 0.3, 0.0)
sphere_actor.GetProperty().SetAmbient(1.0)
sphere_actor.GetProperty().SetDiffuse(0.0)
renderer.AddActor(sphere_actor)

trail_points = vtkPoints()
trail_lines = vtkCellArray()
trail_polydata = vtkPolyData()
trail_polydata.SetPoints(trail_points)
trail_polydata.SetLines(trail_lines)

trail_tube = vtkTubeFilter()
trail_tube.SetInputData(trail_polydata)
trail_tube.SetRadius(0.01)
trail_tube.SetNumberOfSides(8)
trail_tube.CappingOn()

trail_mapper = vtkPolyDataMapper()
trail_mapper.SetInputConnection(trail_tube.GetOutputPort())
trail_actor = vtkActor()
trail_actor.SetMapper(trail_mapper)
trail_actor.GetProperty().SetColor(0.2, 0.6, 1.0)
trail_actor.GetProperty().SetAmbient(1.0)
trail_actor.GetProperty().SetDiffuse(0.0)
renderer.AddActor(trail_actor)

renderer.ResetCamera()
renderWindow.Render()

animation_task = None
frame_times = []
animation_time = 0.0


def reset_trail():
    global animation_time
    trail_points.Reset()
    trail_lines.Reset()
    trail_polydata.Modified()
    animation_time = 0.0
    state.current_points = 0


def add_trail_points(count):
    global animation_time
    num_points = trail_points.GetNumberOfPoints()

    for i in range(count):
        t = animation_time + i * 0.05

        radius = 0.5 + 0.2 * math.sin(t * 2)
        x = radius * math.cos(t)
        y = radius * math.sin(t)
        z = 0.1 * math.sin(t * 3)

        trail_points.InsertNextPoint(x, y, z)

    animation_time += count * 0.05

    new_num_points = trail_points.GetNumberOfPoints()

    if new_num_points >= 2:
        trail_lines.Reset()
        trail_lines.InsertNextCell(new_num_points)
        for i in range(new_num_points):
            trail_lines.InsertCellPoint(i)

    trail_polydata.Modified()

    if new_num_points >= 2:
        trail_tube.Update()
        trail_mapper.Update()

    last_point = trail_points.GetPoint(new_num_points - 1)
    sphere_actor.SetPosition(*last_point)

    state.current_points = new_num_points


async def animate():
    global frame_times

    last_time = time.time()
    target_fps = 30
    frame_interval = 1.0 / target_fps

    while True:
        frame_start = time.time()

        if not state.animation_paused:
            num_points = trail_points.GetNumberOfPoints()
            if num_points < state.max_points:
                add_trail_points(state.points_per_frame)

                ctrl.view_update()

        frame_end = time.time()
        frame_time = (frame_end - frame_start) * 1000
        frame_times.append(frame_time)

        if len(frame_times) > 30:
            frame_times = frame_times[-30:]

        if len(frame_times) >= 5:
            avg_frame_time = sum(frame_times) / len(frame_times)
            state.frame_time_ms = round(avg_frame_time, 2)
            state.fps = round(1000.0 / avg_frame_time, 1) if avg_frame_time > 0 else 0

        elapsed = frame_end - frame_start
        sleep_time = max(0, frame_interval - elapsed)
        await asyncio.sleep(sleep_time)


@server.trigger("start_animation")
def start_animation():
    global animation_task
    if animation_task is None:
        animation_task = asyncio.create_task(animate())


@server.trigger("reset")
def on_reset():
    reset_trail()


with SinglePageLayout(server) as layout:
    layout.title.set_text("Stress Test: Growing PolyData")

    with layout.toolbar:
        vuetify3.VBtn(
            "{{ animation_paused ? 'Play' : 'Pause' }}",
            click="animation_paused = !animation_paused",
            variant="text",
            size="small",
        )
        vuetify3.VBtn(
            "Reset",
            click=(on_reset,),
            variant="text",
            size="small",
        )
        vuetify3.VDivider(vertical=True, classes="mx-2")

        html.Span("Points/frame:", classes="mr-2")
        vuetify3.VSlider(
            v_model=("points_per_frame",),
            min=1,
            max=50,
            step=1,
            hide_details=True,
            density="compact",
            style="max-width: 150px;",
            thumb_label=True,
        )
        vuetify3.VDivider(vertical=True, classes="mx-2")

        html.Span("Max points:", classes="mr-2")
        vuetify3.VSlider(
            v_model=("max_points",),
            min=100,
            max=5000,
            step=100,
            hide_details=True,
            density="compact",
            style="max-width: 150px;",
            thumb_label=True,
        )
        vuetify3.VDivider(vertical=True, classes="mx-2")

        vuetify3.VSelect(
            v_model=("update_mode",),
            items=("[{title: 'Sync (inline)', value: 'sync'}, {title: 'Async (fetch)', value: 'async'}]",),
            label="Mode",
            density="compact",
            hide_details=True,
            style="max-width: 130px;",
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
                html.Div("Points: {{ current_points }} / {{ max_points }}")
                html.Div("FPS: {{ fps }}")
                html.Div("Frame time: {{ frame_time_ms }} ms")

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
                ctrl.view_resync = view.request_resync


INIT_SCRIPT_JS = """
(function() {
    let initialized = false;
    let renderWindow = null;
    let renderer = null;
    let glContext = null;

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
        glContext = gl;

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

        renderWindow = vtkView.getRenderWindow();
        renderer = vtkView.getRenderer();

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
    ctrl.view_resync()


server.enable_module({"scripts": [f"data:text/javascript,{url_quote(INIT_SCRIPT_JS)}"]})

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--server", action="store_true")
    args, _ = parser.parse_known_args()

    server.start(port=args.port, open_browser=not args.server)
