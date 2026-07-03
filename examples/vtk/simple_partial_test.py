"""
Simple test for automatic array-region updates (push sync v2).
A line grows by adding points, then shrinks by removing them, forever.
Points are pre-allocated; grow reveals them at their sine-wave position,
shrink collapses all hidden points onto the last visible one. Each frame is
published with ``view.sync()`` — the publisher's hot-array differ turns the
in-place point moves into small ``patchArray`` region ops automatically.
"""

import asyncio
import math
import argparse
from urllib.parse import quote as url_quote

from trame.app import get_server
from trame.widgets import html
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

server = get_server()
server.client_type = "vue3"
state, ctrl = server.state, server.controller

state.trame__title = "Simple Partial Update Test"
state.current_points = 0
state.growing = True

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

# Pre-compute positions along a sine wave
all_positions = []
for i in range(MAX_POINTS):
    x = -1.0 + 2.0 * i / (MAX_POINTS - 1)  # -1 to +1
    y = 0.3 * math.sin(4.0 * math.pi * i / (MAX_POINTS - 1))
    all_positions.append((x, y, 0.0))

# Pre-allocate all points collapsed at the first position
points.SetNumberOfPoints(MAX_POINTS)
x0, y0, z0 = all_positions[0]
for i in range(MAX_POINTS):
    points.SetPoint(i, x0, y0, z0)

# Single polyline connecting all points
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

# Frame camera to full extent, then collapse back
for i in range(MAX_POINTS):
    points.SetPoint(i, *all_positions[i])
renderer.ResetCamera()
for i in range(MAX_POINTS):
    points.SetPoint(i, x0, y0, z0)
points.Modified()
renderWindow.Render()

visible_count = 1  # Start with 1 point visible
growing = True


def grow_one():
    """Reveal the next point and collapse remaining hidden points onto it."""
    global visible_count
    if visible_count >= MAX_POINTS:
        return None

    idx = visible_count
    x, y, z = all_positions[idx]
    points.SetPoint(idx, x, y, z)
    # Collapse all remaining hidden points onto the new leading edge
    for i in range(idx + 1, MAX_POINTS):
        points.SetPoint(i, x, y, z)
    visible_count += 1
    state.current_points = visible_count

    points.Modified()
    polydata.Modified()
    return (x, y, z), idx


def shrink_one():
    """Hide the last visible point by collapsing ALL hidden points onto the new tail."""
    global visible_count
    if visible_count <= 1:
        return None

    visible_count -= 1
    # Collapse ALL points from visible_count onward to the new tail position
    px, py, pz = all_positions[visible_count - 1]
    for i in range(visible_count, MAX_POINTS):
        points.SetPoint(i, px, py, pz)
    state.current_points = visible_count

    points.Modified()
    polydata.Modified()
    return (px, py, pz), visible_count


async def animate():
    global growing

    while True:
        if growing:
            result = grow_one()
            if result:
                ctrl.view_sync()
            if visible_count >= MAX_POINTS:
                growing = False
                state.growing = False
        else:
            result = shrink_one()
            if result:
                ctrl.view_sync()
            if visible_count <= 1:
                growing = True
                state.growing = True

        state.flush()
        await asyncio.sleep(1.0 / 30)


animation_task = None


@server.trigger("start_animation")
def start_animation(**kwargs):
    global animation_task
    if animation_task is None:
        animation_task = asyncio.create_task(animate())


with SinglePageLayout(server) as layout:
    layout.title.set_text("Simple Partial Update Test")

    with layout.content:
        with html.Div(
            style="position: relative; width: 100%; height: 100%; overflow: hidden;",
        ):
            with html.Div(
                style="position: absolute; top: 10px; left: 10px; z-index: 100; "
                "background: rgba(0,0,0,0.7); color: white; padding: 10px; "
                "border-radius: 5px; font-family: monospace;",
            ):
                html.Div("Points: {{ current_points }} / 100")
                html.Div("{{ growing ? 'Growing...' : 'Shrinking...' }}")

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
                ctrl.view_sync = view.sync


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

        vtkView.initializeForSharedContext(canvas, gl);

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


server.enable_module({"scripts": [f"data:text/javascript,{url_quote(INIT_SCRIPT_JS)}"]})

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8096)
    parser.add_argument("--server", action="store_true")
    args, _ = parser.parse_known_args()

    server.start(port=args.port, open_browser=not args.server)
