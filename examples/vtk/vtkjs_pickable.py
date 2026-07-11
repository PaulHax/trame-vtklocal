"""Pickable glyph demo for the fork interaction seam.

Three crosshair glyphs are tagged pickable with opaque app metadata via
``make_pickable``. A click calls the view's ``emitTargetClick`` and a drag calls
``startTargetDrag``; both flow through the fork gesture seam, which emits
semantic ``pointer_event``s the server prints. The "Re-tag" button re-marks the
glyphs with a bumped revision — reaching the client as a patch op (the tag rides
the mapper's serialized state).
"""

from urllib.parse import quote as url_quote

from trame.app import get_server
from trame.ui.html import DivLayout
from trame.widgets import client, html
from trame_vtklocal.module import interaction as pick
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

import vtkmodules.vtkRenderingOpenGL2  # noqa: F401
from vtkmodules.vtkInteractionStyle import vtkInteractorStyleSwitch  # noqa: F401

CLIENT_TYPE = "vue3"
GLYPH_SCALE = 0.12

# Landmark centers in world space and the opaque ids the app maps them to.
CENTERS = [(-0.8, -0.3, 0.0), (0.0, 0.55, 0.0), (0.75, -0.15, 0.0)]
TARGET_IDS = ["landmark-0", "landmark-1", "landmark-2"]

# Installed on the served page: pointerdown starts a target drag through the
# fork gesture seam (which captures the pointer and runs the lifecycle), and a
# plain click emits a target/background click. Both surface as pointer_events on
# the view widget, printed server-side.
JS_CODE = r"""
(function () {
  function resolveView() {
    const ref = window.trame?.refs?.pickableView;
    return ref?.startTargetDrag ? ref : ref?.$?.exposed || ref;
  }

  window.initPickableDemo = function () {
    const view = resolveView();
    const container = view?.container || document.querySelector(".pickableView");
    if (!view?.startTargetDrag || !container) {
      setTimeout(window.initPickableDemo, 100);
      return;
    }
    if (container.__pickableBound) return;
    container.__pickableBound = true;
    container.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0) return;
        // A hit takes over the pointer for a drag; a miss falls through.
        if (view.startTargetDrag(event)) event.__pickableDrag = true;
      },
      true,
    );
    container.addEventListener("click", (event) => {
      view.emitTargetClick(event);
    });
    window.trame.trigger("pickable_ready");
  };

  if (document.readyState === "complete") {
    setTimeout(window.initPickableDemo, 100);
  } else {
    window.addEventListener("load", () => setTimeout(window.initPickableDemo, 100));
  }
})();
"""


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
    points = vtkPoints()
    for center in CENTERS:
        points.InsertNextPoint(*center)
    centers.SetPoints(points)

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

    return render_window, mapper


server = get_server(client_type=CLIENT_TYPE)
state = server.state
state.trame__title = "vtk.js Pickable Glyphs"

render_window, glyph_mapper = create_vtk_pipeline()
_revision = [0]


def tag_pickable():
    pick.make_pickable(
        glyph_mapper,
        tags={"owner_id": "landmarks", "target_revision": _revision[0]},
        ids=TARGET_IDS,
        grab_px=36.0,
        priority=1,
    )


tag_pickable()


def on_pointer_event(event):
    if not isinstance(event, dict):
        return
    kind = event.get("type")
    pick = event.get("pick")
    pointer = event.get("pointer") or {}
    if pick:
        print(
            f"[pickable] {kind} {pick['pointId']} "
            f"(index {pick['pointIndex']}, {pick['distancePx']:.1f}px) "
            f"tags={pick['tags']} context={event.get('context')}"
        )
    else:
        print(
            f"[pickable] {kind} at ({pointer.get('x')}, {pointer.get('y')}) "
            f"context={event.get('context')}"
        )


@server.trigger("pickable_ready")
def on_ready():
    # Opaque context echoed verbatim on every emitted pointer_event. Pushed once
    # the client view exists (js_call before that has no client to reach).
    view.set_pointer_context({"demo": "pickable", "revision": _revision[0]})


@server.trigger("pickable_retag")
def on_retag():
    _revision[0] += 1
    tag_pickable()
    view.sync()
    view.set_pointer_context({"demo": "pickable", "revision": _revision[0]})
    print(f"[pickable] re-tagged at revision {_revision[0]} (patch op)")


with DivLayout(server) as layout:
    layout.root.style = "width: 100vw; height: 100vh;"
    client.Style("body { margin: 0; font-family: sans-serif; }")
    server.enable_module(
        {"scripts": [f"data:text/javascript,{url_quote(JS_CODE)}"]}
    )

    with html.Div(style="position: absolute; inset: 0;"):
        view = VtkJsLocalView(
            render_window,
            ref="pickableView",
            classes="pickableView",
            sync_mode="push",
            on_ready="window.initPickableDemo?.()",
            pointer_event=(on_pointer_event, "[$event]"),
        )

    with html.Div(
        style=(
            "position: absolute; top: 1rem; left: 1rem; z-index: 10; "
            "background: rgba(255, 255, 255, 0.92); padding: 0.8rem 0.95rem; "
            "border-radius: 0.75rem; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);"
        ),
    ):
        html.Div(
            "vtk.js Pickable Glyphs",
            style="font-weight: 700; margin-bottom: 0.35rem;",
        )
        html.Div("Click or drag a crosshair — pointer events print server-side.")
        html.Button(
            "Re-tag (bump revision)",
            click="window.trame.trigger('pickable_retag')",
            style="margin-top: 0.5rem;",
        )


if __name__ == "__main__":
    server.start()
