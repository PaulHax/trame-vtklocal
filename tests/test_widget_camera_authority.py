from trame.app import get_server
from vtkmodules.vtkRenderingCore import vtkRenderer, vtkRenderWindow

from trame_vtklocal.widgets import VtkJsLocalView, VtkJsSharedView


def _render_window():
    render_window = vtkRenderWindow()
    render_window.SetOffScreenRendering(1)
    render_window.AddRenderer(vtkRenderer())
    return render_window


def test_vtkjs_views_forward_camera_authority_to_the_client():
    server = get_server("widget-camera-authority", client_type="vue3")
    local_view = VtkJsLocalView(
        _render_window(),
        camera_authority="client",
        trame_server=server,
    )
    shared_view = VtkJsSharedView(
        _render_window(),
        camera_authority="server",
        trame_server=server,
    )

    try:
        assert local_view._attributes["camera_authority"] == (
            'camera-authority="client"'
        )
        assert shared_view._attributes["camera_authority"] == (
            'camera-authority="server"'
        )
    finally:
        local_view.cleanup()
        shared_view.cleanup()
