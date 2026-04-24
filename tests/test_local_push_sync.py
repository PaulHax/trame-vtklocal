"""Regression coverage for hash-first local push sync."""

from copy import deepcopy

from trame_vtklocal.widgets.push_sync import PushSync
from trame_vtklocal.widgets.vtkjs_base import VtkJsBaseView
from trame_vtklocal.widgets.vtkjs_shared_view import VtkJsSharedView
from trame_vtklocal.widgets.vtkjs_view import VtkJsLocalView


class _FakeProtocol:
    def __init__(self):
        self.messages = []

    def publish(self, topic, payload):
        self.messages.append((topic, payload))


class _FakeServer:
    def __init__(self):
        self.protocol = _FakeProtocol()


def _state_with_points(instance_id, points_hash):
    return {
        "id": "rw",
        "dependencies": [
            {
                "id": str(instance_id),
                "properties": {
                    "points": {
                        "hash": points_hash,
                        "dataType": "Float32Array",
                    }
                },
            }
        ],
    }


def _find_points_array(state, instance_id):
    for dep in state.get("dependencies", []):
        if dep.get("id") == str(instance_id):
            return dep["properties"]["points"]
    raise AssertionError(f"points array for instance {instance_id} not found")


def test_push_sync_incremental_updates_are_hash_first():
    server = _FakeServer()
    push_sync = PushSync(
        server,
        lambda: deepcopy(_state_with_points("62", "shared-points")),
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
    )

    push_sync.update()

    assert len(server.protocol.messages) == 1
    _, delta_state = server.protocol.messages[0]
    assert "content" not in _find_points_array(delta_state, "62")


def test_push_sync_resync_is_hash_first():
    server = _FakeServer()
    push_sync = PushSync(
        server,
        lambda: deepcopy(_state_with_points("62", "shared-points")),
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
    )

    push_sync.request_resync()

    assert len(server.protocol.messages) == 1
    _, full_state = server.protocol.messages[0]
    assert "content" not in _find_points_array(full_state, "62")


def test_push_sync_flush_preserves_extra_metadata():
    server = _FakeServer()
    push_sync = PushSync(
        server,
        lambda: deepcopy(_state_with_points("62", "shared-points")),
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
    )

    push_sync.mark_modified("62", "points", start=0, data=b"", data_type="Float32Array")
    push_sync.flush(extra={"orbitCamera": {"center": [-90, 40], "zoom": 8}})

    assert len(server.protocol.messages) == 1
    topic, payload = server.protocol.messages[0]
    assert topic == "trame.vtk.array.partial"
    assert payload["extra"] == {"orbitCamera": {"center": [-90, 40], "zoom": 8}}


def test_vtkjs_views_do_not_expose_inline_array_policy():
    assert not hasattr(VtkJsBaseView, "_always_inline_arrays")
    assert not hasattr(VtkJsLocalView, "_always_inline_arrays")
    assert not hasattr(VtkJsSharedView, "_always_inline_arrays")
