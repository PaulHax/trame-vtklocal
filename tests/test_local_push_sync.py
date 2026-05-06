"""Regression coverage for hash-first local push sync."""

from copy import deepcopy

import numpy as np

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
    def __init__(self, data=None):
        self._data = (
            data
            if data is not None
            else np.asarray([(1.0, 2.0, 3.0)], dtype=np.float32)
        )

    def GetData(self):
        return self._data


class _FakePolyData:
    def __init__(self, points_data=None):
        self._points = _FakePoints(points_data)

    def GetPoints(self):
        return self._points


class _FakeObjectManager:
    def __init__(self, points_data=None):
        self._points_data = points_data

    def GetObjectAtId(self, vtk_id):
        if vtk_id == 62:
            return _FakePolyData(self._points_data)
        return None

    def GetBlob(self, _hash):
        return None


class _FakeApi:
    def __init__(self, points_data=None):
        self.vtk_object_manager = _FakeObjectManager(points_data)

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


def _state_with_actor_visibility(visible):
    return {
        "id": "rw",
        "type": "vtkRenderWindow",
        "dependencies": [
            {
                "id": "ren",
                "type": "vtkRenderer",
                "dependencies": [
                    {
                        "id": "actor",
                        "type": "vtkActor",
                        "properties": {"visibility": visible},
                    }
                ],
            }
        ],
    }


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
    assert delta_state["rwId"] == "1"
    assert delta_state["kind"] == "full"
    assert delta_state["epoch"] == 1
    assert delta_state["seq"] == 1
    assert "baseSeq" not in delta_state
    assert "content" not in _find_points_array(delta_state, "62")


def test_push_sync_update_uses_property_patch_for_stable_object_graph():
    server = _FakeServer()
    visible = False

    def get_state(_version_registry=None, _collection_tracker=None):
        return deepcopy(_state_with_actor_visibility(visible))

    push_sync = PushSync(
        server,
        get_state,
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
    )

    push_sync.client_resync("client-a")
    visible = True
    push_sync.update(extra={"mapCamera": {"zoom": 10}})

    assert len(server.protocol.messages) == 1
    topic, patch, client_id = server.protocol.messages[0]
    assert topic == "trame.vtk.patch"
    assert client_id == "client-a"
    assert patch["rwId"] == "1"
    assert patch["kind"] == "patch"
    assert patch["epoch"] == 1
    assert patch["baseSeq"] == 0
    assert patch["seq"] == 1
    assert patch["extra"] == {"mapCamera": {"zoom": 10}}
    assert patch["ops"] == [
        {
            "op": "setProperties",
            "id": "actor",
            "properties": {"visibility": True},
        }
    ]


def test_push_sync_update_falls_back_to_full_state_for_structural_change():
    server = _FakeServer()
    actor_ids = ["actor-a"]

    def get_state(_version_registry=None, _collection_tracker=None):
        return {
            "id": "rw",
            "type": "vtkRenderWindow",
            "dependencies": [
                {"id": actor_id, "type": "vtkActor"} for actor_id in actor_ids
            ],
        }

    push_sync = PushSync(
        server,
        get_state,
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
    )

    push_sync.client_resync("client-a")
    actor_ids.append("actor-b")
    push_sync.update()

    assert len(server.protocol.messages) == 1
    topic, state, client_id = server.protocol.messages[0]
    assert topic == "trame.vtk.delta"
    assert client_id == "client-a"
    assert state["kind"] == "full"
    assert state["seq"] == 1
    assert [dep["id"] for dep in state["dependencies"]] == ["actor-a", "actor-b"]


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
    assert full_state["rwId"] == "1"
    assert full_state["kind"] == "full"
    assert full_state["epoch"] == 1
    assert full_state["seq"] == 1
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
    assert payload["rwId"] == "1"
    assert payload["kind"] == "arrayPartial"
    assert payload["epoch"] == 1
    assert payload["baseSeq"] == 0
    assert payload["seq"] == 1
    assert payload["extra"] == {"orbitCamera": {"center": [-90, 40], "zoom": 8}}
    assert payload["updates"][0]["oldHash"] == "shared-points"


def test_push_sync_partial_flush_advances_synthetic_hash_ledger():
    server = _FakeServer()

    def get_state(version_registry=None, _collection_tracker=None):
        version = (version_registry or {}).get((1, 62, "points"))
        points_hash = (
            f"v:1:62:points:{version}" if version is not None else "initial-points"
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
    partial_update = payload["updates"][0]
    server.protocol.messages.clear()

    push_sync.update()

    assert len(server.protocol.messages) == 1
    _, delta_state, client_id = server.protocol.messages[0]
    assert client_id == "client-a"
    points = _find_points_array(delta_state, "62")
    assert points["hash"] == partial_update["newHash"]
    assert "content" not in points


def test_push_sync_extract_points_region_preserves_float64_dtype():
    polydata = _FakePolyData(
        np.asarray([(1.0, 2.0, 3.0), (4.0, 5.0, 6.0)], dtype=np.float64)
    )

    payload, data_type, bytes_per_tuple = PushSync.extract_array_region(
        polydata, "points", start=1, count=1
    )

    assert data_type == "Float64Array"
    assert bytes_per_tuple == 24
    assert np.frombuffer(payload, dtype=np.float64).tolist() == [4.0, 5.0, 6.0]


def test_push_sync_synthetic_points_payload_matches_descriptor_type():
    push_sync = PushSync(
        _FakeServer(),
        _make_points_state_getter(),
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
        api=_FakeApi(
            np.asarray([(1.0, 2.0, 3.0), (4.0, 5.0, 6.0)], dtype=np.float64)
        ),
    )

    payload = push_sync._resolve_payload(
        {"hash": "v:1:62:points:1", "dataType": "Float64Array"}
    )

    assert len(payload) == 6 * 8
    assert np.frombuffer(payload, dtype=np.float64).tolist() == [
        1.0,
        2.0,
        3.0,
        4.0,
        5.0,
        6.0,
    ]


def test_push_sync_client_resync_returns_ordered_full_state_with_fresh_epoch():
    server = _FakeServer()
    push_sync = PushSync(
        server,
        _make_points_state_getter(),
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
    )

    first = push_sync.client_resync("client-a")
    second = push_sync.client_resync("client-a")

    assert first["rwId"] == "1"
    assert first["kind"] == "full"
    assert first["epoch"] == 1
    assert first["seq"] == 0
    assert "baseSeq" not in first
    assert second["epoch"] == 2
    assert second["seq"] == 0


def test_vtkjs_views_do_not_expose_inline_array_policy():
    assert not hasattr(VtkJsBaseView, "_always_inline_arrays")
    assert not hasattr(VtkJsLocalView, "_always_inline_arrays")
    assert not hasattr(VtkJsSharedView, "_always_inline_arrays")
