"""
Animated vtkGlyph3DMapper example for vtk.js local rendering.

Three crosshair glyphs reuse one shared source polydata while their center
points are mutated in place every second.
"""

import asyncio

from trame.app import asynchronous, get_server
from trame.ui.html import DivLayout
from trame.widgets import client, html
from trame_vtklocal.widgets import VtkJsLocalView

from vtkmodules.vtkCommonCore import vtkPoints
from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData
from vtkmodules.vtkRenderingCore import (
    vtkActor,
    vtkGlyph3DMapper,
    vtkRenderer,
    vtkRenderWindow,
    vtkRenderWindowInteractor,
)

import vtkmodules.vtkRenderingOpenGL2  # noqa
from vtkmodules.vtkInteractionStyle import vtkInteractorStyleSwitch  # noqa

CLIENT_TYPE = "vue3"
STEP_SECONDS = 1.0
GLYPH_SCALE = 0.12

POSITIONS = [
    [(-0.8, -0.3, 0.0), (0.0, 0.65, 0.0), (0.75, -0.15, 0.0)],
    [(-0.45, 0.25, 0.0), (0.45, 0.65, 0.0), (0.75, -0.55, 0.0)],
    [(-0.8, 0.55, 0.0), (-0.1, -0.5, 0.0), (0.7, 0.2, 0.0)],
    [(-0.55, -0.55, 0.0), (0.2, 0.15, 0.0), (0.8, 0.55, 0.0)],
]


def build_cross_source():
    points = vtkPoints()
    lines = vtkCellArray()
    for dx, dy, dz in ((1, 0, 0), (0, 1, 0), (0, 0, 1)):
        a = points.InsertNextPoint(-dx, -dy, -dz)
        b = points.InsertNextPoint(dx, dy, dz)
        lines.InsertNextCell(2)
        lines.InsertCellPoint(a)
        lines.InsertCellPoint(b)

    polydata = vtkPolyData()
    polydata.SetPoints(points)
    polydata.SetLines(lines)
    return polydata


def update_centers(polydata, centers):
    points = polydata.GetPoints()
    points.SetNumberOfPoints(len(centers))
    for index, center in enumerate(centers):
        points.SetPoint(index, *center)
    points.Modified()
    polydata.Modified()


def create_vtk_pipeline():
    renderer = vtkRenderer()
    renderer.SetBackground(0.09, 0.11, 0.16)

    render_window = vtkRenderWindow()
    render_window.AddRenderer(renderer)
    render_window.SetOffScreenRendering(1)

    interactor = vtkRenderWindowInteractor()
    interactor.SetRenderWindow(render_window)
    interactor.GetInteractorStyle().SetCurrentStyleToTrackballCamera()

    centers = vtkPolyData()
    centers.SetPoints(vtkPoints())
    update_centers(centers, POSITIONS[0])

    mapper = vtkGlyph3DMapper()
    mapper.SetInputData(centers)
    mapper.SetSourceData(build_cross_source())
    mapper.SetScaleFactor(GLYPH_SCALE)
    mapper.OrientOff()
    mapper.SetScalarVisibility(False)

    actor = vtkActor()
    actor.SetMapper(mapper)
    prop = actor.GetProperty()
    prop.SetColor(0.35, 0.85, 1.0)
    prop.SetLineWidth(3.0)
    prop.LightingOff()

    renderer.AddActor(actor)
    renderer.ResetCamera()
    render_window.Render()

    return render_window, centers


server = get_server(client_type=CLIENT_TYPE)
state = server.state
state.trame__title = "vtk.js Glyph Mapper Demo"

render_window, centers_polydata = create_vtk_pipeline()


async def animate():
    index = 1
    while True:
        update_centers(centers_polydata, POSITIONS[index])
        view.sync()
        state.flush()
        index = (index + 1) % len(POSITIONS)
        await asyncio.sleep(STEP_SECONDS)


@server.controller.on_server_ready.add
def on_server_ready(**_kwargs):
    asynchronous.create_task(animate())


with DivLayout(server) as layout:
    layout.root.style = "width: 100vw; height: 100vh;"
    client.Style("body { margin: 0; font-family: sans-serif; }")

    with html.Div(style="position: absolute; inset: 0;"):
        view = VtkJsLocalView(render_window, sync_mode="push")

    with html.Div(
        style=(
            "position: absolute; top: 1rem; left: 1rem; z-index: 10; "
            "background: rgba(255, 255, 255, 0.92); padding: 0.8rem 0.95rem; "
            "border-radius: 0.75rem; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);"
        ),
    ):
        html.Div("vtk.js Glyph Mapper Demo", style="font-weight: 700; margin-bottom: 0.35rem;")
        html.Div("Three glyph centers move every second.")


if __name__ == "__main__":
    server.start()
