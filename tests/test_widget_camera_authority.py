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
        assert local_view._attributes["view_key"] == (
            f'view-key="{local_view.ref_name}"'
        )
        assert "camera" in local_view._event_names
        assert "camera" in shared_view._event_names
    finally:
        local_view.cleanup()
        shared_view.cleanup()


def test_camera_methods_retain_commands_under_client_authority():
    server = get_server("widget-camera-commands", client_type="vue3")
    view = VtkJsLocalView(
        _render_window(), camera_authority="client", trame_server=server
    )
    try:
        view.set_camera({"parallelScale": 3})
        view.reset_camera()

        assert view._publisher._pending_commands == [
            {
                "name": "camera.set",
                "payload": {"parallelScale": 3},
                "render": True,
            },
            {"name": "camera.reset", "payload": {}, "render": True},
        ]
        assert set(view._publisher._retained_commands) == {"camera.reset"}
    finally:
        view.cleanup()


def test_camera_methods_do_not_retain_under_server_authority():
    # In server mode the camera is a synced node: the snapshot already carries
    # the current pose, so a retained command would replay a stale one on
    # every resync.
    server = get_server("widget-camera-commands-server", client_type="vue3")
    view = VtkJsLocalView(
        _render_window(), camera_authority="server", trame_server=server
    )
    try:
        view.set_camera({"parallelScale": 3})
        view.reset_camera()

        assert [cmd["name"] for cmd in view._publisher._pending_commands] == [
            "camera.set",
            "camera.reset",
        ]
        assert view._publisher._retained_commands == {}
    finally:
        view.cleanup()


def test_cleanup_unregisters_the_render_window_and_is_idempotent():
    server = get_server("widget-cleanup", client_type="vue3")
    first = VtkJsSharedView(_render_window(), trame_server=server)
    object_manager = first.object_manager
    first_id = int(first._window_id)

    assert object_manager.GetObjectAtId(first_id) is not None
    first.cleanup()
    first.cleanup()
    assert object_manager.GetObjectAtId(first_id) is None

    second = VtkJsSharedView(_render_window(), trame_server=server)
    try:
        assert object_manager.GetObjectAtId(int(second._window_id)) is not None
    finally:
        second.cleanup()
