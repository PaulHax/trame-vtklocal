"""Layered vtk.js renderers with independent color/depth preservation.

The red annotation sphere is geometrically behind the opaque blue plane.
Layer 1 normally preserves layer 0's color but starts with fresh depth, so the
annotation remains visible. Enable "Preserve underlay depth" to demonstrate
the opposite composition: the blue plane then occludes the sphere.
"""

from trame.app import get_server
from trame.decorators import TrameApp, change
from trame.ui.html import DivLayout
from trame.widgets import html
from trame_vtklocal.widgets import VtkJsLocalView

from vtkmodules.vtkFiltersSources import vtkPlaneSource, vtkSphereSource
from vtkmodules.vtkRenderingCore import (
    vtkActor,
    vtkPolyDataMapper,
    vtkRenderer,
    vtkRenderWindow,
)

import vtkmodules.vtkRenderingOpenGL2  # noqa: F401

CLIENT_TYPE = "vue3"


def _actor(source, color):
    mapper = vtkPolyDataMapper()
    mapper.SetInputConnection(source.GetOutputPort())
    actor = vtkActor()
    actor.SetMapper(mapper)
    actor.GetProperty().SetColor(*color)
    actor.GetProperty().LightingOff()
    return actor


def create_vtk_pipeline():
    # Add the scene renderer first so it remains the primary renderer used by
    # camera controls. VTK still paints by layer number, not insertion order.
    scene_renderer = vtkRenderer()
    scene_renderer.SetLayer(1)
    scene_renderer.SetBackgroundAlpha(0)
    scene_renderer.PreserveColorBufferOn()
    scene_renderer.PreserveDepthBufferOff()

    underlay_renderer = vtkRenderer()
    underlay_renderer.SetLayer(0)
    underlay_renderer.SetBackground(0.03, 0.04, 0.07)
    underlay_renderer.PreserveColorBufferOff()
    underlay_renderer.PreserveDepthBufferOff()

    render_window = vtkRenderWindow()
    render_window.SetNumberOfLayers(2)
    render_window.AddRenderer(scene_renderer)
    render_window.AddRenderer(underlay_renderer)
    render_window.OffScreenRenderingOn()

    plane = vtkPlaneSource()
    plane.SetOrigin(-2.4, -1.6, 0.0)
    plane.SetPoint1(2.4, -1.6, 0.0)
    plane.SetPoint2(-2.4, 1.6, 0.0)
    plane.SetXResolution(1)
    plane.SetYResolution(1)
    underlay_renderer.AddActor(_actor(plane, (0.08, 0.28, 0.72)))

    sphere = vtkSphereSource()
    sphere.SetCenter(0.0, 0.0, -0.75)
    sphere.SetRadius(0.55)
    sphere.SetThetaResolution(48)
    sphere.SetPhiResolution(48)
    annotation = _actor(sphere, (1.0, 0.12, 0.08))
    scene_renderer.AddActor(annotation)

    camera = scene_renderer.GetActiveCamera()
    camera.SetPosition(0.0, 0.0, 5.0)
    camera.SetFocalPoint(0.0, 0.0, 0.0)
    camera.SetViewUp(0.0, 1.0, 0.0)
    camera.ParallelProjectionOn()
    camera.SetParallelScale(1.8)
    camera.SetClippingRange(0.1, 10.0)
    underlay_renderer.SetActiveCamera(camera)

    return render_window, scene_renderer


@TrameApp()
class LayeredRendererDemo:
    def __init__(self, server=None):
        self.server = get_server(server, client_type=CLIENT_TYPE)
        self.render_window, self.scene_renderer = create_vtk_pipeline()
        self.html_view = None
        self.ui = self._ui()

    @change("preserve_depth")
    def on_preserve_depth_change(self, preserve_depth, **_kwargs):
        self.scene_renderer.SetPreserveDepthBuffer(bool(preserve_depth))
        if self.html_view:
            self.html_view.sync()

    def reset_camera(self):
        if self.html_view:
            # Re-send the deliberately framed server camera. A generic client
            # reset would fit only the primary renderer's annotation bounds.
            self.html_view.set_camera()

    def _ui(self):
        with DivLayout(self.server) as layout:
            with html.Div(style="position: fixed; inset: 0;"):
                self.html_view = VtkJsLocalView(self.render_window)

            with html.Div(
                style=(
                    "position: absolute; top: 1rem; left: 1rem; z-index: 10; "
                    "max-width: 25rem; padding: 1rem; border-radius: 0.5rem; "
                    "background: rgba(255, 255, 255, 0.94); font-family: sans-serif;"
                )
            ):
                html.Div(
                    "Layered renderer depth composition",
                    style="font-weight: 700; margin-bottom: 0.5rem;",
                )
                html.Div(
                    "The red annotation is behind the blue plane in world space. "
                    "Layer 1 preserves color and normally clears depth, keeping the "
                    "annotation visible."
                )
                with html.Label(style="display: block; margin-top: 0.75rem;"):
                    html.Input(
                        type="checkbox",
                        v_model=("preserve_depth", False),
                    )
                    html.Span(" Preserve underlay depth")
                html.Button(
                    "Reset Camera",
                    click=self.reset_camera,
                    style="margin-top: 0.75rem;",
                )

        return layout


if __name__ == "__main__":
    app = LayeredRendererDemo()
    app.server.start()
