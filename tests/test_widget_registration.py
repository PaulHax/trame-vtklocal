"""Status reporting for ids that are not render windows."""

from trame.app import get_server
from vtkmodules.vtkRenderingCore import vtkRenderer, vtkRenderWindow

from trame_vtklocal.widgets import LocalView


def _render_window():
    render_window = vtkRenderWindow()
    render_window.SetOffScreenRendering(1)
    render_window.AddRenderer(vtkRenderer())
    return render_window


def test_get_status_answers_for_an_id_that_is_not_a_render_window():
    server = get_server("widget-registration", client_type="vue3")
    view = LocalView(_render_window(), trame_server=server)
    api = view.api
    # An id nothing is registered under: the manager answers None for it.
    stale_id = 99999
    assert api.vtk_object_manager.GetObjectAtId(stale_id) is None

    status = api.get_status(stale_id)

    assert status["interactor"] is None
    assert status["cameras"] == []
