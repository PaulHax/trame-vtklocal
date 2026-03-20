"""
Simple example demonstrating VtkJsLocalView with vtk.js rendering.

This uses vtk.js (JavaScript implementation) for client-side rendering
instead of the WASM-based LocalView.
"""

from trame.app import get_server
from trame.ui.html import DivLayout
from trame.widgets import html
from trame_vtklocal.widgets import VtkJsLocalView
from trame.decorators import TrameApp, change

from vtkmodules.vtkFiltersSources import vtkConeSource
from vtkmodules.vtkRenderingCore import (
    vtkActor,
    vtkPolyDataMapper,
    vtkRenderer,
    vtkRenderWindow,
    vtkRenderWindowInteractor,
)

import vtkmodules.vtkRenderingOpenGL2  # noqa
from vtkmodules.vtkInteractionStyle import vtkInteractorStyleSwitch  # noqa

CLIENT_TYPE = "vue3"


def create_vtk_pipeline():
    renderer = vtkRenderer()
    render_window = vtkRenderWindow()
    render_window.AddRenderer(renderer)

    interactor = vtkRenderWindowInteractor()
    interactor.SetRenderWindow(render_window)
    interactor.GetInteractorStyle().SetCurrentStyleToTrackballCamera()

    cone = vtkConeSource()

    mapper = vtkPolyDataMapper()
    mapper.SetInputConnection(cone.GetOutputPort())

    actor = vtkActor()
    actor.SetMapper(mapper)

    renderer.AddActor(actor)
    renderer.SetBackground(0.1, 0.2, 0.4)
    renderer.ResetCamera()

    return render_window, cone, actor


@TrameApp()
class VtkJsDemo:
    def __init__(self, server=None):
        self.server = get_server(server, client_type=CLIENT_TYPE)

        self.render_window, self.cone, self.actor = create_vtk_pipeline()
        self.html_view = None
        self.ui = self._ui()

    @change("resolution")
    def on_resolution_change(self, resolution, **kwargs):
        self.cone.SetResolution(int(resolution))
        if self.html_view:
            self.html_view.update()

    @change("color")
    def on_color_change(self, color, **kwargs):
        colors = {
            "red": (1, 0, 0),
            "green": (0, 1, 0),
            "blue": (0, 0, 1),
            "white": (1, 1, 1),
        }
        self.actor.GetProperty().SetColor(*colors.get(color, (1, 1, 1)))
        if self.html_view:
            self.html_view.update()

    def reset_camera(self):
        if self.html_view:
            self.html_view.reset_camera()

    def _ui(self):
        with DivLayout(self.server) as layout:
            with html.Div(
                style="position: fixed; inset: 0;"
            ):
                self.html_view = VtkJsLocalView(self.render_window)

            with html.Div(
                style="position: absolute; top: 1rem; left: 1rem; z-index: 10; background: white; padding: 1rem; border-radius: 0.5rem;"
            ):
                html.Div("vtk.js Rendering Demo", style="font-weight: bold; margin-bottom: 0.5rem;")
                html.Label("Resolution: ")
                html.Input(
                    type="range",
                    v_model=("resolution", 6),
                    min=3,
                    max=60,
                    step=1,
                )
                html.Br()
                html.Label("Color: ")
                html.Select(
                    v_model=("color", "white"),
                    children=[
                        html.Option("White", value="white"),
                        html.Option("Red", value="red"),
                        html.Option("Green", value="green"),
                        html.Option("Blue", value="blue"),
                    ],
                )
                html.Br()
                html.Button("Reset Camera", click=self.reset_camera)

        return layout


if __name__ == "__main__":
    app = VtkJsDemo()
    app.server.start()
