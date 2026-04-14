"""Test: actor add/remove sync via push mode."""

import asyncio

from trame.app import get_server, asynchronous
from trame.ui.html import DivLayout
from trame_vtklocal.widgets import VtkJsLocalView

from vtkmodules.vtkFiltersSources import vtkSphereSource
from vtkmodules.vtkRenderingCore import (
    vtkActor,
    vtkPolyDataMapper,
    vtkRenderer,
    vtkRenderWindow,
    vtkRenderWindowInteractor,
)

import vtkmodules.vtkRenderingOpenGL2  # noqa
from vtkmodules.vtkInteractionStyle import vtkInteractorStyleSwitch  # noqa

COLORS = [
    (1, 0, 0),
    (0, 0.8, 0),
    (0, 0.4, 1),
    (1, 1, 0),
    (1, 0, 1),
    (0, 1, 1),
]


def make_actor(x, y, color):
    src = vtkSphereSource()
    src.SetCenter(x, y, 0)
    src.SetRadius(0.4)
    src.Update()
    mapper = vtkPolyDataMapper()
    mapper.SetInputConnection(src.GetOutputPort())
    actor = vtkActor()
    actor.SetMapper(mapper)
    actor.GetProperty().SetColor(*color)
    return actor


server = get_server(client_type="vue3")
renderer = vtkRenderer()
renderer.SetBackground(0.15, 0.15, 0.2)
render_window = vtkRenderWindow()
render_window.AddRenderer(renderer)
render_window.SetOffScreenRendering(1)
interactor = vtkRenderWindowInteractor()
interactor.SetRenderWindow(render_window)
interactor.GetInteractorStyle().SetCurrentStyleToTrackballCamera()

with DivLayout(server) as layout:
    html_view = VtkJsLocalView(render_window, sync_mode="push", style="position: fixed; inset: 0;")


async def loop():
    step = 0
    actor = None
    while True:
        # Remove old actor
        if actor:
            renderer.RemoveActor(actor)
            print(f"Step {step}: removed")
            html_view.update()
            await asyncio.sleep(1)

        # Add new actor
        color = COLORS[step % len(COLORS)]
        actor = make_actor(0, 0, color)
        renderer.AddActor(actor)
        renderer.ResetCamera()
        print(f"Step {step}: added {color}")
        html_view.update()
        html_view.reset_camera()
        step += 1
        await asyncio.sleep(1)


@server.controller.on_server_ready.add
def on_ready(**kwargs):
    asynchronous.create_task(loop())


if __name__ == "__main__":
    server.start()
