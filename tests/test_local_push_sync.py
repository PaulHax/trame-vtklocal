"""Regression coverage for hash-first local push sync."""

from copy import deepcopy

from trame_vtklocal.widgets.push_sync import PushSync
from trame_vtklocal.widgets.vtkjs_base import VtkJsBaseView
from trame_vtklocal.widgets.vtkjs_shared_view import VtkJsSharedView
from trame_vtklocal.widgets.vtkjs_view import VtkJsLocalView


class _FakeProtocol:
    def __init__(self):
        self.messages = []

    def publish(self, topic, payload, client_id=None):
        self.messages.append((topic, payload, client_id))


class _FakeServer:
    def __init__(self):
        self.protocol = _FakeProtocol()


class _FakePoints:
    def GetData(self):
        return [(1.0, 2.0, 3.0)]


class _FakePolyData:
    def GetPoints(self):
        return _FakePoints()


class _FakeObjectManager:
    def GetObjectAtId(self, vtk_id):
        if vtk_id == 62:
            return _FakePolyData()
        return None

    def GetBlob(self, _hash):
        return None


class _FakeApi:
    def __init__(self):
        self.vtk_object_manager = _FakeObjectManager()

    def register_push_view(self, *_args):
        pass

    def unregister_push_view(self, *_args):
        pass

    def _convert_bytes_to_attachments(self, _state):
        pass


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


def _make_points_state_getter(instance_id="62", points_hash="shared-points"):
    def get_state(_version_registry=None, _collection_tracker=None):
        return deepcopy(_state_with_points(instance_id, points_hash))

    return get_state


def test_push_sync_incremental_updates_are_hash_first():
    server = _FakeServer()
    push_sync = PushSync(
        server,
        _make_points_state_getter(),
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
    )

    push_sync.client_resync("client-a")
    push_sync.update()

    assert len(server.protocol.messages) == 1
    _, delta_state, client_id = server.protocol.messages[0]
    assert client_id == "client-a"
    assert "content" not in _find_points_array(delta_state, "62")


def test_push_sync_resync_is_hash_first():
    server = _FakeServer()
    push_sync = PushSync(
        server,
        _make_points_state_getter(),
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
    )

    push_sync.client_resync("client-a")
    push_sync.request_resync()

    assert len(server.protocol.messages) == 1
    _, full_state, client_id = server.protocol.messages[0]
    assert client_id == "client-a"
    assert "content" not in _find_points_array(full_state, "62")


def test_push_sync_uses_independent_collection_trackers_per_client():
    def get_state(_version_registry=None, collection_tracker=None):
        prev_ids = collection_tracker.get("items", set())
        collection_tracker["items"] = {"actor-a"}
        calls = []
        if "actor-a" not in prev_ids:
            calls.append(["addViewProp", ["instance:${actor-a}"]])
        return {"id": "rw", "calls": calls}

    server = _FakeServer()
    push_sync = PushSync(
        server,
        get_state,
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
    )

    first_client_state = push_sync.client_resync("client-a")
    assert first_client_state["calls"] == [["addViewProp", ["instance:${actor-a}"]]]

    push_sync.update()
    assert server.protocol.messages[-1][1]["calls"] == []

    second_client_state = push_sync.client_resync("client-b")
    assert second_client_state["calls"] == [["addViewProp", ["instance:${actor-a}"]]]


def test_push_sync_flush_preserves_extra_metadata():
    server = _FakeServer()
    push_sync = PushSync(
        server,
        _make_points_state_getter(),
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
    )

    push_sync.client_resync("client-a")
    push_sync.mark_modified("62", "points", start=0, data=b"", data_type="Float32Array")
    push_sync.flush(extra={"orbitCamera": {"center": [-90, 40], "zoom": 8}})

    assert len(server.protocol.messages) == 1
    topic, payload, client_id = server.protocol.messages[0]
    assert topic == "trame.vtk.array.partial"
    assert client_id == "client-a"
    assert payload["extra"] == {"orbitCamera": {"center": [-90, 40], "zoom": 8}}


def test_push_sync_partial_flush_does_not_ack_synthetic_hash_until_full_state():
    server = _FakeServer()

    def get_state(version_registry=None, _collection_tracker=None):
        version = (version_registry or {}).get((1, 62, "points"))
        points_hash = (
            f"v:1:62:points:{version}"
            if version is not None
            else "initial-points"
        )
        return deepcopy(_state_with_points("62", points_hash))

    push_sync = PushSync(
        server,
        get_state,
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
        api=_FakeApi(),
    )

    push_sync.client_resync("client-a")
    push_sync.mark_modified("62", "points", start=0, data=b"", data_type="Float32Array")
    push_sync.flush()

    _, payload, _ = server.protocol.messages[0]
    server.protocol.messages.clear()

    push_sync.update()

    assert len(server.protocol.messages) == 1
    _, delta_state, client_id = server.protocol.messages[0]
    assert client_id == "client-a"
    points = _find_points_array(delta_state, "62")
    assert points["hash"] == payload["newHash"]
    assert "content" in points


def test_vtkjs_views_do_not_expose_inline_array_policy():
    assert not hasattr(VtkJsBaseView, "_always_inline_arrays")
    assert not hasattr(VtkJsLocalView, "_always_inline_arrays")
    assert not hasattr(VtkJsSharedView, "_always_inline_arrays")
