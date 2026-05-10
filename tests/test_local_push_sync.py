"""Regression coverage for hash-first local push sync."""

from copy import deepcopy

import numpy as np
import pytest

from trame_vtklocal.module.protocol import ObjectManagerAPI
from trame_vtklocal.module.vtkjs_translator import translate_scene
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
    def __init__(self, points_data=None, blobs=None):
        self._points_data = points_data
        self._blobs = blobs or {}

    def GetObjectAtId(self, vtk_id):
        if vtk_id == 62:
            return _FakePolyData(self._points_data)
        return None

    def GetBlob(self, blob_hash):
        return self._blobs.get(blob_hash)


class _FakeApi:
    def __init__(self, points_data=None, blobs=None):
        self.vtk_object_manager = _FakeObjectManager(points_data, blobs)
        self.registered_push_views = {}

    def register_push_view(self, rw_id, push_sync):
        self.registered_push_views[int(rw_id)] = push_sync

    def unregister_push_view(self, rw_id):
        self.registered_push_views.pop(int(rw_id), None)

    def _convert_bytes_to_attachments(self, _state):
        pass


class _FakeAttachmentProtocol:
    def __init__(self):
        self.attachments = []

    def addAttachment(self, payload):
        self.attachments.append(bytes(payload))
        return f"attachment:{len(self.attachments)}"

    def _convert_bytes_to_attachments(self, node):
        ObjectManagerAPI._convert_bytes_to_attachments(self, node)


class _ObjectManagerApiNoAttachments:
    def __init__(self):
        self._api = ObjectManagerAPI()
        self.vtk_object_manager = self._api.vtk_object_manager

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
    if state.get("id") == str(instance_id):
        return state["properties"]["points"]
    for dep in state.get("dependencies", []):
        try:
            return _find_points_array(dep, instance_id)
        except AssertionError:
            pass
    raise AssertionError(f"points array for instance {instance_id} not found")


def _make_points_state_getter(instance_id="62", points_hash="shared-points"):
    def get_state(_version_registry=None, _collection_tracker=None):
        return deepcopy(_state_with_points(instance_id, points_hash))

    return get_state


def _make_nested_array_state_getter(array_hash="nested-array"):
    def get_state(_version_registry=None, _collection_tracker=None):
        return {
            "id": "rw",
            "properties": {
                "custom": {
                    "arbitrary": {
                        "payload": {
                            "hash": array_hash,
                            "dataType": "Float32Array",
                            "numberOfComponents": 1,
                            "size": 3,
                        }
                    }
                }
            },
        }

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


def _make_real_vtk_scene():
    from vtkmodules.vtkCommonCore import vtkPoints
    from vtkmodules.vtkCommonDataModel import vtkPolyData
    from vtkmodules.vtkRenderingCore import (
        vtkActor,
        vtkPolyDataMapper,
        vtkRenderer,
        vtkRenderWindow,
    )

    api = _ObjectManagerApiNoAttachments()
    rw = vtkRenderWindow()
    renderer = vtkRenderer()
    rw.AddRenderer(renderer)

    points = vtkPoints()
    points.InsertNextPoint(0.0, 0.0, 0.0)
    points.InsertNextPoint(1.0, 0.0, 0.0)
    polydata = vtkPolyData()
    polydata.SetPoints(points)

    mapper = vtkPolyDataMapper()
    mapper.SetInputData(polydata)
    actor = vtkActor()
    actor.SetMapper(mapper)
    renderer.AddActor(actor)

    render_window_id = api.vtk_object_manager.RegisterObject(rw)
    rw.Render()
    api.vtk_object_manager.UpdateStatesFromObjects()
    return api, rw, renderer, actor, polydata, points, render_window_id


def _make_real_push_sync(server, api, render_window, render_window_id):
    calls = {"full_translate": 0}

    def get_state(version_registry=None, collection_tracker=None):
        calls["full_translate"] += 1
        render_window.Render()
        api.vtk_object_manager.UpdateStatesFromObjects()
        return translate_scene(
            api.vtk_object_manager,
            render_window_id,
            collection_tracker,
            version_registry,
            render_window_id,
        )

    push_sync = PushSync(
        server,
        get_state,
        lambda vtk_object: str(api.vtk_object_manager.GetId(vtk_object)),
        render_window_id=render_window_id,
        api=api,
    )
    return push_sync, calls


def _set_float_array_values(vtk_array, values):
    vtk_array.SetNumberOfTuples(len(values))
    for index, tuple_values in enumerate(values):
        for component, value in enumerate(tuple_values):
            vtk_array.SetComponent(index, component, value)
    vtk_array.Modified()


def _make_float_array(name, components, values):
    from vtkmodules.vtkCommonCore import vtkFloatArray

    array = vtkFloatArray()
    array.SetName(name)
    array.SetNumberOfComponents(components)
    _set_float_array_values(array, values)
    return array


def _make_quad_polydata():
    from vtkmodules.vtkCommonCore import vtkPoints
    from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData

    points = vtkPoints()
    for point in [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (1.0, 1.0, 0.0), (0.0, 1.0, 0.0)]:
        points.InsertNextPoint(*point)

    polys = vtkCellArray()
    polys.InsertNextCell(4)
    for point_id in range(4):
        polys.InsertCellPoint(point_id)

    tcoords = _make_float_array(
        "TextureCoordinates",
        2,
        [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)],
    )
    homography = _make_float_array(
        "HomographyInverse",
        16,
        [(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)],
    )

    polydata = vtkPolyData()
    polydata.SetPoints(points)
    polydata.SetPolys(polys)
    polydata.GetPointData().SetTCoords(tcoords)
    polydata.GetFieldData().AddArray(homography)
    return polydata, points, tcoords, homography


def _make_line_polydata():
    from vtkmodules.vtkCommonCore import vtkPoints
    from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData

    points = vtkPoints()
    for point in [(0.0, 0.0, 0.0), (1.0, 1.0, 0.0), (2.0, 0.5, 0.0)]:
        points.InsertNextPoint(*point)

    lines = vtkCellArray()
    lines.InsertNextCell(3)
    for point_id in range(3):
        lines.InsertCellPoint(point_id)

    polydata = vtkPolyData()
    polydata.SetPoints(points)
    polydata.SetLines(lines)
    return polydata, points


def _add_actor(renderer, polydata, visible=True):
    from vtkmodules.vtkRenderingCore import vtkActor, vtkPolyDataMapper

    mapper = vtkPolyDataMapper()
    mapper.SetInputData(polydata)
    actor = vtkActor()
    actor.SetMapper(mapper)
    actor.SetVisibility(visible)
    renderer.AddActor(actor)
    return actor


def _make_tsw_like_vtk_scene():
    from vtkmodules.vtkRenderingCore import vtkRenderer, vtkRenderWindow

    api = _ObjectManagerApiNoAttachments()
    rw = vtkRenderWindow()
    renderer = vtkRenderer()
    rw.AddRenderer(renderer)

    footprint, footprint_points, footprint_tcoords, homography = _make_quad_polydata()
    frustum, frustum_points = _make_line_polydata()
    connection, connection_points = _make_line_polydata()
    trail, trail_points = _make_line_polydata()

    footprint_actor = _add_actor(renderer, footprint, visible=True)
    frustum_actor = _add_actor(renderer, frustum, visible=False)
    connection_actor = _add_actor(renderer, connection, visible=True)
    trail_actor = _add_actor(renderer, trail, visible=True)

    render_window_id = api.vtk_object_manager.RegisterObject(rw)
    rw.Render()
    api.vtk_object_manager.UpdateStatesFromObjects()
    return {
        "api": api,
        "render_window": rw,
        "render_window_id": render_window_id,
        "actors": [footprint_actor, frustum_actor, connection_actor, trail_actor],
        "footprint": footprint,
        "footprint_points": footprint_points,
        "footprint_tcoords": footprint_tcoords,
        "homography": homography,
        "frustum": frustum,
        "frustum_points": frustum_points,
        "connection": connection,
        "connection_points": connection_points,
        "trail": trail,
        "trail_points": trail_points,
    }


def _mutate_tsw_like_frame(scene, frame_index):
    offset = frame_index * 0.1
    for index in range(4):
        x = float(index % 2) + offset
        y = float(index // 2) + offset * 0.5
        scene["footprint_points"].SetPoint(index, x, y, 0.0)
    scene["footprint_points"].Modified()

    _set_float_array_values(
        scene["footprint_tcoords"],
        [
            (0.0 + offset, 0.0),
            (1.0 + offset, 0.0),
            (1.0 + offset, 1.0),
            (0.0 + offset, 1.0),
        ],
    )
    _set_float_array_values(
        scene["homography"],
        [
            (
                1.0,
                0.0,
                offset,
                0.0,
                0.0,
                1.0,
                offset * 0.5,
                0.0,
                0.0,
                0.0,
                1.0,
                0.0,
                offset,
                offset * 0.5,
                0.0,
                1.0,
            )
        ],
    )

    for index in range(3):
        scene["frustum_points"].SetPoint(index, offset + index, offset, index * 0.25)
        scene["connection_points"].SetPoint(index, offset, index + offset, 0.0)
        scene["trail_points"].SetPoint(index, index * 0.5, offset + index * 0.1, 0.0)
    for key in ["frustum_points", "connection_points", "trail_points"]:
        scene[key].Modified()

    scene["actors"][0].SetVisibility(True)
    scene["actors"][1].SetVisibility(frame_index % 2 == 0)
    scene["actors"][2].SetVisibility(True)
    scene["actors"][3].SetVisibility(frame_index % 3 != 0)
    for key in ["footprint", "frustum", "connection", "trail"]:
        scene[key].Modified()


def _inline_descriptor_hashes(value):
    hashes = []
    if isinstance(value, list):
        for item in value:
            hashes.extend(_inline_descriptor_hashes(item))
        return hashes
    if not isinstance(value, dict):
        return hashes
    if "hash" in value and "dataType" in value and "content" in value:
        hashes.append(value["hash"])
        return hashes
    for child in value.values():
        hashes.extend(_inline_descriptor_hashes(child))
    return hashes


def test_push_sync_update_requires_object_manager_delta_support():
    server = _FakeServer()
    push_sync = PushSync(
        server,
        _make_points_state_getter(),
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
    )

    push_sync.client_resync("client-a")
    with pytest.raises(RuntimeError, match="object-id delta support"):
        push_sync.update()


def test_push_sync_update_rejects_pending_partial_changes():
    server = _FakeServer()
    push_sync = PushSync(
        server,
        _make_points_state_getter(),
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
    )

    push_sync.client_resync("client-a")
    push_sync.mark_modified("62", "points", start=0, data=b"", data_type="Float32Array")

    with pytest.raises(RuntimeError, match="flush\\(\\).*before calling update"):
        push_sync.update()

    assert len(push_sync._pending_changes) == 1
    assert server.protocol.messages == []


def test_push_sync_update_uses_object_manager_delta_for_actor_property():
    server = _FakeServer()
    api, rw, _renderer, actor, _polydata, _points, rw_id = _make_real_vtk_scene()
    push_sync, calls = _make_real_push_sync(server, api, rw, rw_id)

    actor_id = str(api.vtk_object_manager.GetId(actor))
    push_sync.client_resync("client-a")
    assert calls["full_translate"] == 1

    actor.SetVisibility(False)
    push_sync.update(extra={"mapCamera": {"zoom": 10}})

    assert calls["full_translate"] == 1
    assert len(server.protocol.messages) == 1
    topic, patch, client_id = server.protocol.messages[0]
    assert topic == "trame.vtk.patch"
    assert client_id == "client-a"
    assert patch["version"] == 1
    assert patch["kind"] == "patch"
    assert patch["extra"] == {"mapCamera": {"zoom": 10}}
    assert patch["ops"] == [
        {
            "op": "setProperties",
            "id": actor_id,
            "properties": {"visibility": 0},
        }
    ]


def test_push_sync_dirty_update_skips_render_window_refresh(monkeypatch):
    server = _FakeServer()
    api, rw, _renderer, actor, _polydata, _points, rw_id = _make_real_vtk_scene()
    push_sync, calls = _make_real_push_sync(server, api, rw, rw_id)

    push_sync.client_resync("client-a")
    server.protocol.messages.clear()
    refresh_calls = {"full": 0, "dirty": 0}

    def fail_full_refresh():
        refresh_calls["full"] += 1
        raise AssertionError("dirty patch update should not render/refresh the full root")

    original_dirty_refresh = push_sync._refresh_dirty_object_states

    def spy_dirty_refresh(object_ids):
        refresh_calls["dirty"] += 1
        return original_dirty_refresh(object_ids)

    monkeypatch.setattr(push_sync, "_refresh_object_manager_state", fail_full_refresh)
    monkeypatch.setattr(push_sync, "_refresh_dirty_object_states", spy_dirty_refresh)

    actor.SetVisibility(False)
    push_sync.update()

    assert calls["full_translate"] == 1
    assert refresh_calls == {"full": 0, "dirty": 1}
    assert len(server.protocol.messages) == 1
    assert server.protocol.messages[0][0] == "trame.vtk.patch"


def test_push_sync_client_resync_preserves_pending_dirty_for_other_clients():
    server = _FakeServer()
    api, _rw, _renderer, actor, _polydata, _points, rw_id = _make_real_vtk_scene()
    push_sync, calls = _make_real_push_sync(server, api, _rw, rw_id)

    actor_id = str(api.vtk_object_manager.GetId(actor))
    push_sync.client_resync("client-a")
    assert calls["full_translate"] == 1

    actor.SetVisibility(False)
    assert actor_id in push_sync._dirty_object_ids
    push_sync.client_resync("client-b")
    assert calls["full_translate"] == 2
    assert actor_id in push_sync._dirty_object_ids

    server.protocol.messages.clear()
    push_sync.update()

    assert calls["full_translate"] == 2
    assert len(server.protocol.messages) == 2
    messages_by_client = {
        client_id: (topic, payload)
        for topic, payload, client_id in server.protocol.messages
    }
    topic_a, patch_a = messages_by_client["client-a"]
    topic_b, patch_b = messages_by_client["client-b"]
    assert topic_a == "trame.vtk.patch"
    assert patch_a["ops"] == [
        {
            "op": "setProperties",
            "id": actor_id,
            "properties": {"visibility": 0},
        }
    ]
    assert topic_b == "trame.vtk.patch"
    assert patch_b["ops"] == []
    assert patch_b["baseSeq"] == 0
    assert patch_b["seq"] == 1

    server.protocol.messages.clear()
    actor.SetVisibility(True)
    push_sync.update()

    assert calls["full_translate"] == 2
    assert len(server.protocol.messages) == 2
    assert {topic for topic, _payload, _client in server.protocol.messages} == {
        "trame.vtk.patch"
    }
    assert {
        client_id: payload["ops"][0]["properties"]["visibility"]
        for _topic, payload, client_id in server.protocol.messages
    } == {"client-a": 1, "client-b": 1}


def test_push_sync_renderer_and_render_window_dirty_do_not_force_full_fallback():
    server = _FakeServer()
    api, rw, renderer, _actor, _polydata, _points, rw_id = _make_real_vtk_scene()
    push_sync, calls = _make_real_push_sync(server, api, rw, rw_id)

    push_sync.client_resync("client-a")
    server.protocol.messages.clear()

    renderer.Modified()
    rw.Modified()
    push_sync.update(extra={"camera": {"reason": "routine-render-dirty"}})

    assert calls["full_translate"] == 1
    assert len(server.protocol.messages) == 1
    topic, patch, client_id = server.protocol.messages[0]
    assert topic == "trame.vtk.patch"
    assert client_id == "client-a"
    assert patch["kind"] == "patch"
    assert patch["extra"] == {"camera": {"reason": "routine-render-dirty"}}


def test_push_sync_extra_only_update_skips_vtk_refresh(monkeypatch):
    server = _FakeServer()
    api, rw, _renderer, _actor, _polydata, _points, rw_id = _make_real_vtk_scene()
    push_sync, calls = _make_real_push_sync(server, api, rw, rw_id)

    push_sync.client_resync("client-a")
    server.protocol.messages.clear()

    def fail_refresh(*_args, **_kwargs):
        raise AssertionError("extra-only patch should not refresh VTK state")

    monkeypatch.setattr(push_sync, "_refresh_object_manager_state", fail_refresh)
    monkeypatch.setattr(push_sync, "_refresh_dirty_object_states", fail_refresh)

    push_sync.update(extra={"mapCamera": {"zoom": 12}})

    assert calls["full_translate"] == 1
    assert len(server.protocol.messages) == 1
    topic, patch, _client_id = server.protocol.messages[0]
    assert topic == "trame.vtk.patch"
    assert patch["ops"] == []
    assert patch["extra"] == {"mapCamera": {"zoom": 12}}


def test_push_sync_update_uses_object_manager_delta_for_polydata_array():
    server = _FakeServer()
    api, rw, _renderer, _actor, polydata, points, rw_id = _make_real_vtk_scene()
    push_sync, calls = _make_real_push_sync(server, api, rw, rw_id)

    polydata_id = str(api.vtk_object_manager.GetId(polydata))
    initial_state = push_sync.client_resync("client-a")
    initial_hash = _find_points_array(initial_state, polydata_id)["hash"]
    server.protocol.messages.clear()

    points.SetPoint(0, 2.0, 3.0, 4.0)
    points.Modified()
    polydata.Modified()
    push_sync.update()

    assert calls["full_translate"] == 1
    assert len(server.protocol.messages) == 1
    topic, patch, client_id = server.protocol.messages[0]
    assert topic == "trame.vtk.patch"
    assert client_id == "client-a"
    assert patch["version"] == 1
    assert patch["ops"][0]["op"] == "updateObject"
    assert patch["ops"][0]["id"] == polydata_id
    points_descriptor = patch["ops"][0]["state"]["properties"]["points"]
    assert points_descriptor["hash"] != initial_hash
    assert points_descriptor["dataType"] == "Float32Array"
    assert len(points_descriptor["content"]) == 6 * 4


def test_push_sync_normal_update_after_partial_inlines_current_polydata_array():
    server = _FakeServer()
    api, rw, _renderer, _actor, polydata, points, rw_id = _make_real_vtk_scene()
    push_sync, calls = _make_real_push_sync(server, api, rw, rw_id)

    polydata_id = str(api.vtk_object_manager.GetId(polydata))
    push_sync.client_resync("client-a")
    assert calls["full_translate"] == 1
    server.protocol.messages.clear()

    points.SetPoint(0, 2.0, 3.0, 4.0)
    points.GetData().Modified()
    points.Modified()
    polydata.Modified()
    push_sync.mark_modified(polydata, "points", 0, points.GetNumberOfPoints())
    assert push_sync.flush()

    assert len(server.protocol.messages) == 1
    topic, partial, client_id = server.protocol.messages[0]
    assert topic == "trame.vtk.array.partial"
    assert client_id == "client-a"
    assert partial["version"] == 1
    synthetic_hash = partial["updates"][0]["newHash"]
    assert synthetic_hash.startswith("v:")
    server.protocol.messages.clear()

    points.SetPoint(0, 8.0, 9.0, 10.0)
    points.GetData().Modified()
    points.Modified()
    polydata.Modified()
    push_sync.update()

    assert calls["full_translate"] == 1
    assert len(server.protocol.messages) == 1
    topic, patch, client_id = server.protocol.messages[0]
    assert topic == "trame.vtk.patch"
    assert client_id == "client-a"
    assert patch["version"] == 1
    op = next(op for op in patch["ops"] if op["id"] == polydata_id)
    points_descriptor = op["state"]["properties"]["points"]
    assert points_descriptor["hash"] != synthetic_hash
    assert not points_descriptor["hash"].startswith("v:")
    assert points_descriptor["dataType"] == "Float32Array"
    assert len(points_descriptor["content"]) == points.GetNumberOfPoints() * 3 * 4


def test_push_sync_partial_flush_consumes_matching_dirty_observer_state():
    server = _FakeServer()
    api, rw, _renderer, _actor, polydata, points, rw_id = _make_real_vtk_scene()
    push_sync, _calls = _make_real_push_sync(server, api, rw, rw_id)

    push_sync.client_resync("client-a")
    server.protocol.messages.clear()

    points.SetPoint(0, 2.0, 3.0, 4.0)
    points.GetData().Modified()
    points.Modified()
    polydata.Modified()
    push_sync.mark_modified(polydata, "points", 0, points.GetNumberOfPoints())
    assert push_sync.flush()
    assert len(server.protocol.messages) == 1

    server.protocol.messages.clear()
    push_sync.update()

    assert server.protocol.messages == []


def test_push_sync_pipeline_update_does_not_re_dirty_consumed_ids(monkeypatch):
    """producer.Update() can fire ModifiedEvent on observed objects; that
    must not re-add ids to _dirty_object_ids during the same update().
    """
    from vtkmodules.vtkRenderingCore import vtkPolyDataMapper

    server = _FakeServer()
    api, rw, _renderer, _actor, polydata, points, rw_id = _make_real_vtk_scene()
    push_sync, _calls = _make_real_push_sync(server, api, rw, rw_id)

    push_sync.client_resync("client-a")
    server.protocol.messages.clear()

    polydata_id = str(api.vtk_object_manager.GetId(polydata))
    push_sync._dirty_pipeline_updates.setdefault(polydata_id, {})["mapper"] = polydata

    push_sync._dirty_object_ids.add(polydata_id)

    points.SetPoint(0, 7.0, 8.0, 9.0)
    points.Modified()
    polydata.Modified()
    push_sync.update()
    server.protocol.messages.clear()

    # A second update with no real changes must not republish anything;
    # the first update's pipeline refresh would re-dirty without the guard.
    push_sync.update()
    assert server.protocol.messages == []


def _prime_all_dirty_fields(push_sync):
    push_sync._dirty_object_ids.add("a")
    push_sync._dirty_owner_ids["a"] = {"b"}
    push_sync._dirty_pipeline_updates["a"] = {"mapper": object()}
    push_sync._dirty_structural_ids.add("a")
    push_sync._dirty_structure_pending = True


def _assert_dirty_fields_empty(push_sync):
    assert push_sync._dirty_object_ids == set()
    assert push_sync._dirty_owner_ids == {}
    assert push_sync._dirty_pipeline_updates == {}
    assert push_sync._dirty_structural_ids == set()
    assert push_sync._dirty_structure_pending is False


def test_push_sync_reset_dirty_state_clears_all_fields():
    """Both cleanup() and the _sync_dirty_observers early-return path must
    clear every dirty-tracking field together."""
    server = _FakeServer()
    push_sync = PushSync(
        server,
        _make_points_state_getter(),
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
    )

    _prime_all_dirty_fields(push_sync)

    # Early-return path: object_manager None -> _reset_dirty_state.
    push_sync._sync_dirty_observers({"ids": []})

    _assert_dirty_fields_empty(push_sync)


def test_push_sync_cleanup_clears_all_dirty_state_fields():
    """cleanup() must use the same _reset_dirty_state shape as the
    _sync_dirty_observers early-return path. Drift between the two would
    leave fields populated after one of the two paths."""
    server = _FakeServer()
    push_sync = PushSync(
        server,
        _make_points_state_getter(),
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
    )

    _prime_all_dirty_fields(push_sync)

    push_sync.cleanup()

    _assert_dirty_fields_empty(push_sync)


def test_push_sync_consuming_dirty_suppresses_observer_re_fire():
    """While dirty consumption is in progress, observer callbacks must be
    no-ops. Without the flag, UpdateStateFromObject / producer.Update()
    would re-add ids that were just consumed in the same update() pass."""
    server = _FakeServer()
    push_sync = PushSync(
        server,
        _make_points_state_getter(),
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
    )

    push_sync._consuming_dirty = True
    push_sync._mark_dirty("123")
    assert push_sync._dirty_object_ids == set()

    push_sync._consuming_dirty = False
    push_sync._mark_dirty("123")
    assert push_sync._dirty_object_ids == {"123"}


def test_push_sync_object_delta_falls_back_for_real_structural_change():
    from vtkmodules.vtkRenderingCore import vtkActor, vtkPolyDataMapper

    server = _FakeServer()
    api, rw, renderer, _actor, polydata, _points, rw_id = _make_real_vtk_scene()
    push_sync, calls = _make_real_push_sync(server, api, rw, rw_id)

    push_sync.client_resync("client-a")
    server.protocol.messages.clear()

    mapper = vtkPolyDataMapper()
    mapper.SetInputData(polydata)
    actor = vtkActor()
    actor.SetMapper(mapper)
    renderer.AddActor(actor)
    push_sync.update()

    assert calls["full_translate"] == 2
    assert len(server.protocol.messages) == 1
    topic, state, client_id = server.protocol.messages[0]
    assert topic == "trame.vtk.delta"
    assert client_id == "client-a"
    assert state["version"] == 1
    assert state["kind"] == "full"
    assert state["seq"] == 1
    assert _inline_descriptor_hashes(state)


def test_push_sync_pipeline_source_change_updates_mapper_input_dataset(monkeypatch):
    from vtkmodules.vtkFiltersSources import vtkConeSource
    from vtkmodules.vtkRenderingCore import vtkActor, vtkPolyDataMapper, vtkRenderer
    from vtkmodules.vtkRenderingCore import vtkRenderWindow

    server = _FakeServer()
    api = _ObjectManagerApiNoAttachments()
    rw = vtkRenderWindow()
    renderer = vtkRenderer()
    rw.AddRenderer(renderer)

    source = vtkConeSource()
    source.SetResolution(6)
    mapper = vtkPolyDataMapper()
    mapper.SetInputConnection(source.GetOutputPort())
    actor = vtkActor()
    actor.SetMapper(mapper)
    renderer.AddActor(actor)

    rw_id = api.vtk_object_manager.RegisterObject(rw)
    rw.Render()
    api.vtk_object_manager.UpdateStatesFromObjects()
    push_sync, calls = _make_real_push_sync(server, api, rw, rw_id)

    push_sync.client_resync("client-a")
    assert calls["full_translate"] == 1
    assert any(key.startswith("pipeline:") for key in push_sync._observed_objects)
    server.protocol.messages.clear()

    def fail_full_refresh():
        raise AssertionError("pipeline source delta should not refresh the full root")

    monkeypatch.setattr(push_sync, "_refresh_object_manager_state", fail_full_refresh)

    source.SetResolution(12)
    push_sync.update()

    assert calls["full_translate"] == 1
    assert len(server.protocol.messages) == 1
    topic, patch, client_id = server.protocol.messages[0]
    assert topic == "trame.vtk.patch"
    assert client_id == "client-a"
    assert patch["version"] == 1
    assert len(patch["ops"]) == 1
    assert patch["ops"][0]["op"] == "updateObject"
    assert patch["ops"][0]["state"]["type"] == "vtkPolyData"
    assert _inline_descriptor_hashes(patch)


def test_push_sync_tsw_like_frame_updates_stay_on_patch_path():
    server = _FakeServer()
    scene = _make_tsw_like_vtk_scene()
    api = scene["api"]
    push_sync, calls = _make_real_push_sync(
        server,
        api,
        scene["render_window"],
        scene["render_window_id"],
    )

    push_sync.client_resync("client-a")
    assert calls["full_translate"] == 1
    server.protocol.messages.clear()

    for frame_index in range(1, 5):
        _mutate_tsw_like_frame(scene, frame_index)
        push_sync.update(extra={"mapCamera": {"frame": frame_index}})

    assert calls["full_translate"] == 1
    assert len(server.protocol.messages) == 4

    seen_inlined_hashes = set()
    for index, (topic, patch, client_id) in enumerate(server.protocol.messages, start=1):
        assert topic == "trame.vtk.patch"
        assert client_id == "client-a"
        assert patch["version"] == 1
        assert patch["kind"] == "patch"
        assert patch["extra"] == {"mapCamera": {"frame": index}}
        assert patch["baseSeq"] == index - 1
        assert patch["seq"] == index
        assert patch["ops"]
        assert {op["op"] for op in patch["ops"]} <= {"setProperties", "updateObject"}
        assert any(op["op"] == "updateObject" for op in patch["ops"])

        inlined_hashes = set(_inline_descriptor_hashes(patch))
        assert inlined_hashes
        assert not (inlined_hashes & seen_inlined_hashes)
        seen_inlined_hashes.update(inlined_hashes)

    server.protocol.messages.clear()
    scene["actors"][0].SetVisibility(False)
    push_sync.update(extra={"mapCamera": {"frame": "visibility-only"}})

    assert calls["full_translate"] == 1
    assert len(server.protocol.messages) == 1
    topic, patch, _client_id = server.protocol.messages[0]
    assert topic == "trame.vtk.patch"
    assert patch["version"] == 1
    assert len(patch["ops"]) == 1
    assert patch["ops"][0]["op"] == "setProperties"
    assert patch["ops"][0]["id"] == str(api.vtk_object_manager.GetId(scene["actors"][0]))
    assert patch["ops"][0]["properties"]["visibility"] == 0
    assert _inline_descriptor_hashes(patch) == []


def test_push_sync_resync_is_self_contained():
    server = _FakeServer()
    payload = np.asarray([1, 2, 3], dtype=np.float32).tobytes()
    push_sync = PushSync(
        server,
        _make_points_state_getter(),
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
        api=_FakeApi(blobs={"shared-points": payload}),
    )

    push_sync.client_resync("client-a")
    push_sync.request_resync()

    assert len(server.protocol.messages) == 1
    _, full_state, client_id = server.protocol.messages[0]
    assert client_id == "client-a"
    assert full_state["version"] == 1
    assert full_state["rwId"] == "1"
    assert full_state["kind"] == "full"
    assert full_state["epoch"] == 1
    assert full_state["seq"] == 1
    assert _find_points_array(full_state, "62")["content"] == payload


def test_push_sync_inlines_nested_array_descriptors_in_full_state():
    payload = np.asarray([1, 2, 3], dtype=np.float32).tobytes()
    push_sync = PushSync(
        _FakeServer(),
        _make_nested_array_state_getter("nested-array"),
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
        api=_FakeApi(blobs={"nested-array": payload}),
    )

    state = push_sync.client_resync("client-a")
    descriptor = state["properties"]["custom"]["arbitrary"]["payload"]

    assert descriptor["content"] == payload
    assert push_sync._known_hashes["client-a"] == {"nested-array"}


def test_protocol_converts_nested_inline_bytes_to_attachments():
    protocol = _FakeAttachmentProtocol()
    state = {
        "id": "rw",
        "arrays": {
            "nested": {
                "hash": "nested-array",
                "dataType": "Float32Array",
                "content": b"abc",
            }
        },
        "properties": {
            "custom": {
                "payload": {
                    "hash": "custom-array",
                    "dataType": "Uint8Array",
                    "content": memoryview(b"def"),
                }
            }
        },
    }

    ObjectManagerAPI._convert_bytes_to_attachments(protocol, state)

    assert protocol.attachments == [b"abc", b"def"]
    assert state["arrays"]["nested"]["content"] == "attachment:1"
    assert state["properties"]["custom"]["payload"]["content"] == "attachment:2"


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

    second_client_state = push_sync.client_resync("client-b")
    assert second_client_state["calls"] == [["addViewProp", ["instance:${actor-a}"]]]


def test_push_sync_full_fallback_resets_collection_tracker():
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

    push_sync.client_resync("client-a")
    server.protocol.messages.clear()
    push_sync._publish_full_fallback("client-a", seq=1, reason="test")

    assert len(server.protocol.messages) == 1
    _topic, state, _client_id = server.protocol.messages[0]
    assert state["kind"] == "full"
    assert state["calls"] == [["addViewProp", ["instance:${actor-a}"]]]


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
    assert payload["version"] == 1
    assert payload["kind"] == "arrayPartial"
    assert payload["epoch"] == 1
    assert payload["baseSeq"] == 0
    assert payload["seq"] == 1
    assert payload["extra"] == {"orbitCamera": {"center": [-90, 40], "zoom": 8}}
    assert payload["updates"][0]["oldHash"] == "shared-points"


def test_push_sync_flush_rejects_unsupported_partial_paths_without_publishing():
    server = _FakeServer()
    push_sync = PushSync(
        server,
        _make_points_state_getter(),
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
    )

    push_sync.client_resync("client-a")
    push_sync.mark_modified("62", "lines", start=0, data=b"", data_type="BigInt64Array")

    with pytest.raises(ValueError, match="Partial array path 'lines' is not supported"):
        push_sync.flush()

    assert server.protocol.messages == []
    assert len(push_sync._pending_changes) == 1


def test_push_sync_flush_promotes_all_clients_to_full_when_one_mismatches():
    """Mixing partial publish + full fallback in one flush would call
    retire_all() and wipe synthetic versions still referenced by clients
    that received the partial. All clients must take the same fallback path.
    """
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
    push_sync.client_resync("client-b")
    server.protocol.messages.clear()

    # Push client-a's sequence forward so it matches the next flush's base_seq,
    # but leave client-b at the original sequence.
    push_sync._client_sequences["client-b"] = -1

    # Spy on the partial-version reservation entry point. The mismatch fix
    # must skip the partial path entirely, so no synthetic version may be
    # reserved during this flush.
    reserve_calls = {"count": 0}
    real_reserve = push_sync._partial_arrays.reserve_partial_versions

    def spy_reserve(pending_changes):
        reserve_calls["count"] += 1
        return real_reserve(pending_changes)

    push_sync._partial_arrays.reserve_partial_versions = spy_reserve

    push_sync.mark_modified(
        "62", "points", start=0, data=b"", data_type="Float32Array"
    )
    push_sync.flush()

    by_client = {client_id: payload for _topic, payload, client_id in server.protocol.messages}
    assert set(by_client) == {"client-a", "client-b"}
    # Both clients see full-state (delta) publishes — no arrayPartial emitted.
    topics = {topic for topic, _payload, _cid in server.protocol.messages}
    assert topics == {"trame.vtk.delta"}
    assert reserve_calls["count"] == 0

    # Synthetic ledger must remain consistent with what each client received.
    # Each client's stored state holds the points hash they were published.
    state_a = push_sync._client_states["client-a"]
    state_b = push_sync._client_states["client-b"]
    hash_a = _find_points_array(state_a, "62")["hash"]
    hash_b = _find_points_array(state_b, "62")["hash"]
    # Both got non-synthetic hashes after retire_all + reconcile.
    assert hash_a == "initial-points"
    assert hash_b == "initial-points"
    # The version_registry holds no leaked v:* entries from the aborted partial
    # — it must be empty so a fresh partial in the next flush starts at v:...:1.
    assert push_sync._partial_arrays.version_registry == {}

    assert push_sync._pending_changes == []


def test_push_sync_update_promotes_all_clients_to_full_when_one_mismatches():
    """Mixing _publish_full_fallback (retire_all() wipes _versions globally)
    with _publish_patch (reconcile_state() re-captures stale v:* hashes into
    _current_hashes) in one update round leaves the synthetic ledger desynced,
    so the next flush() mints a v:* hash that collides with the stale entry.
    """
    server = _FakeServer()
    api, rw, _renderer, actor, polydata, points, rw_id = _make_real_vtk_scene()
    push_sync, _calls = _make_real_push_sync(server, api, rw, rw_id)

    push_sync.client_resync("client-a")
    push_sync.client_resync("client-b")
    server.protocol.messages.clear()

    # First partial flush establishes synthetic v:* hashes for both clients.
    points.SetPoint(0, 2.0, 3.0, 4.0)
    points.GetData().Modified()
    points.Modified()
    polydata.Modified()
    push_sync.mark_modified(polydata, "points", 0, points.GetNumberOfPoints())
    assert push_sync.flush()
    server.protocol.messages.clear()

    # Force a sequence mismatch on client-b. Without the dispatch promotion,
    # the next update() would full-fallback client-b while sequence-bumping
    # client-a, leaking client-a's v:1 hash into _current_hashes after
    # _versions was wiped.
    push_sync._client_sequences["client-b"] = -1

    actor.SetVisibility(False)
    push_sync.update()

    topics = {topic for topic, _payload, _cid in server.protocol.messages}
    assert topics == {"trame.vtk.delta"}, (
        f"expected all-full dispatch, got topics={topics}"
    )
    by_client = {client_id for _topic, _payload, client_id in server.protocol.messages}
    assert by_client == {"client-a", "client-b"}

    # Next partial flush must mint a fresh, non-aliased synthetic hash. With
    # the bug, oldHash and newHash both equal 'v:...:points:1'.
    server.protocol.messages.clear()
    points.SetPoint(0, 5.0, 6.0, 7.0)
    points.GetData().Modified()
    points.Modified()
    polydata.Modified()
    push_sync.mark_modified(polydata, "points", 0, points.GetNumberOfPoints())
    assert push_sync.flush()

    partials = [
        payload
        for topic, payload, _cid in server.protocol.messages
        if topic == "trame.vtk.array.partial"
    ]
    assert partials, "expected arrayPartial messages on the next flush"
    for partial in partials:
        for update in partial["updates"]:
            old_hash = update.get("oldHash")
            new_hash = update["newHash"]
            assert old_hash != new_hash, (
                f"synthetic-hash collision: oldHash={old_hash!r} newHash={new_hash!r}"
            )


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

    points = _find_points_array(push_sync._client_states["client-a"], "62")
    assert points["hash"] == partial_update["newHash"]

    full_state = push_sync.client_resync("client-b")
    points = _find_points_array(full_state, "62")
    assert points["hash"] == "initial-points"


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


def test_push_sync_extract_array_region_only_supports_points_partials():
    assert PushSync.extract_array_region(_FakePolyData(), "lines", 0, 1) == (
        None,
        None,
        None,
    )


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
    assert first["version"] == 1
    assert first["kind"] == "full"
    assert first["epoch"] == 1
    assert first["seq"] == 0
    assert "baseSeq" not in first
    assert second["epoch"] == 2
    assert second["seq"] == 0


def test_push_sync_cleanup_unregisters_view_and_clears_ledgers():
    api = _FakeApi()
    push_sync = PushSync(
        _FakeServer(),
        _make_points_state_getter(),
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
        api=api,
    )

    assert api.registered_push_views[1] is push_sync
    push_sync.client_resync("client-a")
    push_sync.cleanup()

    assert api.registered_push_views == {}
    assert push_sync._view_clients == set()
    assert push_sync._known_hashes == {}
    assert push_sync._client_states == {}
    assert push_sync._client_statuses == {}


def test_push_sync_drop_client_preserves_other_client_state():
    push_sync = PushSync(
        _FakeServer(),
        _make_points_state_getter(),
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
    )

    push_sync.client_resync("client-a")
    push_sync.client_resync("client-b")
    push_sync.drop_client("client-a")

    assert "client-a" not in push_sync._view_clients
    assert "client-a" not in push_sync._client_states
    assert "client-b" in push_sync._view_clients
    assert "client-b" in push_sync._client_states


def test_protocol_push_dispose_drops_active_client_state():
    class _PushView:
        def __init__(self):
            self.dropped = []

        def drop_client(self, client_id):
            self.dropped.append(client_id)

    protocol = ObjectManagerAPI()
    push_view = _PushView()
    protocol._push_views[1] = push_view
    protocol.get_active_client_id = lambda: "client-a"

    assert protocol.push_dispose(1) is True
    assert push_view.dropped == ["client-a"]


def test_protocol_push_resync_requires_registered_push_view():
    protocol = ObjectManagerAPI()

    with pytest.raises(RuntimeError, match="No registered push view"):
        protocol.push_resync(1)


def test_vtkjs_views_do_not_expose_inline_array_policy():
    assert not hasattr(VtkJsBaseView, "_always_inline_arrays")
    assert not hasattr(VtkJsLocalView, "_always_inline_arrays")
    assert not hasattr(VtkJsSharedView, "_always_inline_arrays")
