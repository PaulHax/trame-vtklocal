"""ScenePublisher behavior: hot arrays, batching, commands, resync, blob GC."""

from __future__ import annotations

import asyncio
import copy

import numpy as np
import pytest
from vtkmodules.util.numpy_support import numpy_to_vtk

from push_oracle.scenes import (
    OracleScene,
    _ObjectManagerApiNoAttachments,
    add_actor,
    make_basic_scene,
    make_line_polydata,
)
from trame_vtklocal.store import ref_manager_hashes
from trame_vtklocal.widgets.publisher import OPS_TOPIC, ScenePublisher


class _FakeProtocol:
    def __init__(self):
        self.messages = []

    def publish(self, topic, payload, client_id=None):
        self.messages.append((topic, copy.deepcopy(payload)))

    def drain(self):
        messages = self.messages
        self.messages = []
        return messages


class _FakeServer:
    def __init__(self):
        self.protocol = _FakeProtocol()


POINT_COUNT = 10_000


def make_points_cloud_scene(point_count=POINT_COUNT, name="points_cloud"):
    """One actor over a large float32 point cloud (hot-array workloads)."""
    from vtkmodules.vtkCommonCore import vtkPoints
    from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData
    from vtkmodules.vtkRenderingCore import vtkRenderer, vtkRenderWindow

    api = _ObjectManagerApiNoAttachments()
    render_window = vtkRenderWindow()
    render_window.SetOffScreenRendering(1)
    renderer = vtkRenderer()
    render_window.AddRenderer(renderer)

    coords = np.linspace(
        0.0, 1.0, point_count * 3, dtype=np.float32
    ).reshape(-1, 3)
    points = vtkPoints()
    points.SetData(numpy_to_vtk(coords, deep=True))

    verts = vtkCellArray()
    verts.InsertNextCell(1)
    verts.InsertCellPoint(0)

    polydata = vtkPolyData()
    polydata.SetPoints(points)
    polydata.SetVerts(verts)
    actor, mapper = add_actor(renderer, polydata)

    render_window_id = api.vtk_object_manager.RegisterObject(render_window)
    render_window.Render()
    api.vtk_object_manager.UpdateStatesFromObjects()
    return OracleScene(
        name=name,
        api=api,
        render_window=render_window,
        render_window_id=render_window_id,
        handles={
            "renderer": renderer,
            "actor": actor,
            "mapper": mapper,
            "polydata": polydata,
            "points": points,
        },
    )


@pytest.fixture
def publisher_env():
    """(scene, publisher, server) over the big point cloud; auto-cleanup."""
    scene = make_points_cloud_scene()
    server = _FakeServer()
    publisher = ScenePublisher(
        server, scene.api, scene.render_window, scene.render_window_id
    )
    try:
        yield scene, publisher, server
    finally:
        publisher.cleanup()


def _dataset_id(scene):
    return str(scene.api.vtk_object_manager.GetId(scene.handles["polydata"]))


def _touch_point(scene, index, value):
    scene.handles["points"].SetPoint(index, *value)
    scene.handles["points"].Modified()


def _start_retention(scene, publisher, server):
    """First mutation pays a full send and starts retained-copy tracking."""
    _touch_point(scene, 0, (9.0, 9.0, 9.0))
    publisher.sync()
    ((_topic, message),) = server.protocol.drain()
    (op,) = message["ops"]
    assert op["op"] == "upsert"
    assert set(message["blobs"]) == {op["node"]["arrays"]["points"]["ref"]}
    return message


# ----------------------------------------------------------------------
# Hot-array auto region diff
# ----------------------------------------------------------------------


def test_one_point_move_in_10k_points_emits_one_small_patch(
    publisher_env,
):
    scene, publisher, server = publisher_env
    _start_retention(scene, publisher, server)

    moved_index = 1234
    _touch_point(scene, moved_index, (5.0, 6.0, 7.0))
    publisher.sync()

    ((_topic, message),) = server.protocol.drain()
    (op,) = message["ops"]
    assert op["op"] == "patchArray"
    assert op["id"] == _dataset_id(scene)
    assert op["key"] == "points"
    assert op["offset"] == moved_index * 3
    assert np.frombuffer(bytes(op["data"]), dtype=np.float32).tolist() == [
        5.0,
        6.0,
        7.0,
    ]
    assert op["ref"] == f"v:{_dataset_id(scene)}:points:1"
    assert message["blobs"] == {}


def test_majority_change_resends_full_content_ref(publisher_env):
    scene, publisher, server = publisher_env
    _start_retention(scene, publisher, server)

    points = scene.handles["points"]
    for index in range(POINT_COUNT):
        points.SetPoint(index, float(index), 0.5, -0.5)
    points.Modified()
    publisher.sync()

    ((_topic, message),) = server.protocol.drain()
    (op,) = message["ops"]
    assert op["op"] == "upsert"
    ref = op["node"]["arrays"]["points"]["ref"]
    assert ref.startswith("c:")
    assert set(message["blobs"]) == {ref}


def test_length_change_resends_full_content_ref(publisher_env):
    scene, publisher, server = publisher_env
    _start_retention(scene, publisher, server)

    coords = np.zeros((POINT_COUNT + 7, 3), dtype=np.float32)
    scene.handles["points"].SetData(numpy_to_vtk(coords, deep=True))
    scene.handles["polydata"].Modified()
    publisher.sync()

    ((_topic, message),) = server.protocol.drain()
    upserts = [op for op in message["ops"] if op["op"] == "upsert"]
    (op,) = [op for op in upserts if op["id"] == _dataset_id(scene)]
    entry = op["node"]["arrays"]["points"]
    assert entry["ref"].startswith("c:")
    assert entry["size"] == (POINT_COUNT + 7) * 3
    assert entry["ref"] in message["blobs"]
    assert not [op for op in message["ops"] if op["op"] == "patchArray"]


def test_identical_content_publishes_nothing(publisher_env):
    scene, publisher, server = publisher_env
    _start_retention(scene, publisher, server)

    # Same value re-written: Modified() fires, bytes are unchanged.
    _touch_point(scene, 0, (9.0, 9.0, 9.0))
    publisher.sync()

    assert server.protocol.drain() == []


def test_patch_then_other_prop_change_still_upserts(publisher_env):
    scene, publisher, server = publisher_env
    _start_retention(scene, publisher, server)

    # Point move + actor visibility in one tick: patch + actor upsert, and
    # the dataset upsert stays suppressed (its only change was the array).
    _touch_point(scene, 10, (1.0, 2.0, 3.0))
    scene.handles["actor"].SetVisibility(False)
    publisher.sync()

    ((_topic, message),) = server.protocol.drain()
    ops_by_kind = {}
    for op in message["ops"]:
        ops_by_kind.setdefault(op["op"], []).append(op)
    assert len(ops_by_kind["patchArray"]) == 1
    assert [op["id"] for op in ops_by_kind["upsert"]] != [_dataset_id(scene)]


def test_hot_array_orphaned_blobs_are_released(publisher_env):
    scene, publisher, server = publisher_env
    object_manager = scene.api.vtk_object_manager
    _start_retention(scene, publisher, server)

    _touch_point(scene, 42, (1.0, 1.0, 1.0))
    publisher.sync()
    orphan_ref = publisher._hot_arrays._orphaned_refs[_dataset_id(scene)]
    (orphan_hash,) = ref_manager_hashes([orphan_ref])
    assert object_manager.GetBlob(orphan_hash) is not None

    # The next patch mints a new fresh hash; the previous orphan's blob is
    # no longer referenced by any state and gets unregistered.
    _touch_point(scene, 43, (2.0, 2.0, 2.0))
    publisher.sync()
    assert object_manager.GetBlob(orphan_hash) is None


# ----------------------------------------------------------------------
# Batching: transaction(), settled(), auto-publish coalescing
# ----------------------------------------------------------------------


def test_transaction_batches_mutations_into_one_broadcast():
    scene = make_basic_scene()
    server = _FakeServer()
    publisher = ScenePublisher(
        server, scene.api, scene.render_window, scene.render_window_id
    )
    try:
        with publisher.transaction():
            scene.handles["actor"].SetVisibility(False)
            scene.handles["actor"].GetProperty().SetOpacity(0.5)
            publisher.send_command("mapCamera", {"frame": 3})
            assert server.protocol.messages == []

        ((topic, message),) = server.protocol.drain()
        assert topic == OPS_TOPIC
        upserted = {op["id"] for op in message["ops"]}
        object_manager = scene.api.vtk_object_manager
        assert str(object_manager.GetId(scene.handles["actor"])) in upserted
        assert (
            str(object_manager.GetId(scene.handles["actor"].GetProperty()))
            in upserted
        )
        assert message["commands"] == [
            {"name": "mapCamera", "payload": {"frame": 3}}
        ]
    finally:
        publisher.cleanup()


def test_dirty_marks_auto_publish_on_next_loop_tick():
    scene = make_basic_scene()
    server = _FakeServer()

    async def scenario():
        publisher = ScenePublisher(
            server, scene.api, scene.render_window, scene.render_window_id
        )
        try:
            scene.handles["actor"].SetVisibility(False)
            scene.handles["actor"].GetProperty().SetOpacity(0.5)
            assert server.protocol.messages == []
            await publisher.settled()
            assert not publisher._tracker.has_pending()
        finally:
            publisher.cleanup()

    asyncio.run(scenario())
    messages = server.protocol.drain()
    assert len(messages) == 1  # coalesced into one tick
    assert messages[0][0] == OPS_TOPIC


def test_settled_flushes_queued_commands():
    scene = make_basic_scene()
    server = _FakeServer()

    async def scenario():
        publisher = ScenePublisher(
            server, scene.api, scene.render_window, scene.render_window_id
        )
        try:
            publisher.send_command("ping", None)
            await publisher.settled()
        finally:
            publisher.cleanup()

    asyncio.run(scenario())
    ((_topic, message),) = server.protocol.drain()
    assert message["commands"] == [{"name": "ping", "payload": None}]
    assert message["ops"] == []


# ----------------------------------------------------------------------
# Resync + protocol routing
# ----------------------------------------------------------------------


def test_resync_fires_on_client_resync_callbacks():
    scene = make_basic_scene()
    server = _FakeServer()
    publisher = ScenePublisher(
        server, scene.api, scene.render_window, scene.render_window_id
    )
    try:
        seen = []
        publisher.on_client_resync(seen.append)
        publisher.resync([], client_id="client-7")
        assert seen == ["client-7"]
    finally:
        publisher.cleanup()


def test_resync_flushes_pending_changes_before_snapshot():
    scene = make_basic_scene()
    server = _FakeServer()
    publisher = ScenePublisher(
        server, scene.api, scene.render_window, scene.render_window_id
    )
    try:
        scene.handles["actor"].SetVisibility(False)
        payload = publisher.resync([])
        actor_id = str(scene.api.vtk_object_manager.GetId(scene.handles["actor"]))
        assert payload["nodes"][actor_id]["props"]["visibility"] == 0
        # The flush broadcast and the snapshot share one seq.
        ((_topic, message),) = server.protocol.drain()
        assert message["seq"] == payload["seq"]
    finally:
        publisher.cleanup()


def test_scene_resync_rpc_routes_to_registered_publisher():
    scene = make_basic_scene()
    server = _FakeServer()
    publisher = ScenePublisher(
        server, scene.api, scene.render_window, scene.render_window_id
    )
    try:
        api = scene.api._api  # the real ObjectManagerAPI
        api.register_push_view(scene.render_window_id, publisher)
        payload = api.scene_resync(scene.render_window_id, known_refs=[])
        assert payload["v"] == 2
        assert payload["root"] == str(scene.render_window_id)
        assert payload["nodes"] == publisher.store.snapshot()["nodes"]

        with pytest.raises(RuntimeError, match="No registered publisher"):
            api.scene_resync(99999)
    finally:
        publisher.cleanup()


# ----------------------------------------------------------------------
# Blob GC through the ObjectManagerAPI registry
# ----------------------------------------------------------------------


def test_removed_dataset_blobs_are_unregistered():
    scene = make_basic_scene()
    server = _FakeServer()
    publisher = ScenePublisher(
        server, scene.api, scene.render_window, scene.render_window_id
    )
    try:
        object_manager = scene.api.vtk_object_manager
        polydata, _points = make_line_polydata()
        actor2, _mapper2 = add_actor(scene.handles["renderer"], polydata)
        publisher.sync()

        dataset_id = str(object_manager.GetId(polydata))
        refs = publisher.store.get(dataset_id)["arrays"]
        hashes = ref_manager_hashes(entry["ref"] for entry in refs.values())
        assert hashes
        for hash_value in hashes:
            assert object_manager.GetBlob(hash_value) is not None

        scene.handles["renderer"].RemoveActor(actor2)
        publisher.sync()

        for hash_value in hashes:
            assert object_manager.GetBlob(hash_value) is None
    finally:
        publisher.cleanup()


def test_ref_manager_hashes_strips_namespaces():
    assert ref_manager_hashes(
        ["c:abc", "c2:conn:off", "v:5:points:3", "c:abc"]
    ) == {"abc", "conn", "off"}
    assert ref_manager_hashes(None) == set()


if __name__ == "__main__":  # pragma: no cover
    pytest.main([__file__, "-q"])
