"""ScenePublisher behavior: hot arrays, batching, commands, resync, blob GC,
camera authority, and seq-stamped event staleness."""

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
from trame_vtklocal.widgets.publisher import (
    OPS_TOPIC,
    ScenePublisher,
    event_is_current,
)


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


def run_coroutine(coro):
    """``asyncio.run`` that tolerates playwright's parked sync-API loop.

    Playwright's sync API (used by the e2e oracle earlier in the same pytest
    session) drives its event loop with greenlets: while control sits in the
    test greenlet, that loop stays registered as the main thread's running
    loop, so a plain ``asyncio.run`` raises "cannot be called from a running
    event loop". The loop is parked (not executing) here, so clearing the
    marker for the duration of the scenario is safe; VTK stays on the main
    thread.
    """
    previous = asyncio.events._get_running_loop()
    asyncio.events._set_running_loop(None)
    try:
        return asyncio.run(coro)
    finally:
        asyncio.events._set_running_loop(previous)


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

    run_coroutine(scenario())
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

    run_coroutine(scenario())
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
# Camera authority
# ----------------------------------------------------------------------


def make_publisher(scene, **kwargs):
    server = _FakeServer()
    publisher = ScenePublisher(
        server, scene.api, scene.render_window, scene.render_window_id, **kwargs
    )
    return publisher, server


def _camera_id(scene):
    camera = scene.handles["renderer"].GetActiveCamera()
    return str(scene.api.vtk_object_manager.GetId(camera))


@pytest.mark.parametrize(
    ("camera_authority", "camera_synced"),
    [("server", True), ("client", False)],
)
def test_camera_authority_gates_camera_upserts(camera_authority, camera_synced):
    scene = make_basic_scene()
    publisher, server = make_publisher(scene, camera_authority=camera_authority)
    try:
        camera_id = _camera_id(scene)
        assert publisher.camera_authority == camera_authority
        assert (camera_id in publisher.store.node_ids()) == camera_synced

        scene.handles["renderer"].GetActiveCamera().SetPosition(1.0, 2.0, 9.0)
        publisher.sync()

        messages = server.protocol.drain()
        camera_upserts = [
            op
            for _topic, message in messages
            for op in message["ops"]
            if op["op"] == "upsert" and op["id"] == camera_id
        ]
        assert bool(camera_upserts) == camera_synced
        if camera_synced:
            assert camera_upserts[0]["node"]["props"]["position"] == [1.0, 2.0, 9.0]
        else:
            # The camera mutation produced nothing to broadcast at all, and a
            # non-camera mutation still publishes normally afterwards.
            assert messages == []
            scene.handles["actor"].SetVisibility(False)
            publisher.sync()
            ((_topic, message),) = server.protocol.drain()
            assert {op["id"] for op in message["ops"]} == {
                str(scene.api.vtk_object_manager.GetId(scene.handles["actor"]))
            }
    finally:
        publisher.cleanup()


def test_client_camera_authority_resync_snapshot_has_no_camera():
    scene = make_basic_scene()
    publisher, _server = make_publisher(scene, camera_authority="client")
    try:
        payload = publisher.resync([])
        assert _camera_id(scene) not in payload["nodes"]
        assert all(
            "activeCamera" not in node.get("refs", {})
            for node in payload["nodes"].values()
        )
    finally:
        publisher.cleanup()


def test_commands_and_request_resync_ignore_camera_authority():
    scene = make_basic_scene()
    publisher, server = make_publisher(scene, camera_authority="client")
    try:
        publisher.send_command("mapCamera", {"frame": 3})
        publisher.sync()
        ((_topic, message),) = server.protocol.drain()
        assert message["commands"] == [{"name": "mapCamera", "payload": {"frame": 3}}]
        assert message["ops"] == []

        seq_before = publisher.store.seq
        publisher.request_resync()
        ((_topic, message),) = server.protocol.drain()
        assert message["baseSeq"] == -1
        assert message["ops"] == []
        assert message["seq"] == seq_before + 1
    finally:
        publisher.cleanup()


def test_unknown_camera_authority_is_rejected_at_construction():
    scene = make_basic_scene()
    with pytest.raises(ValueError, match="camera_authority"):
        ScenePublisher(
            _FakeServer(),
            scene.api,
            scene.render_window,
            scene.render_window_id,
            camera_authority="nobody",
        )


# ----------------------------------------------------------------------
# Seq-stamped event staleness
# ----------------------------------------------------------------------


def test_event_is_current_truth_table():
    scene = make_basic_scene()
    publisher, _server = make_publisher(scene)
    try:
        mapper_id = str(scene.api.vtk_object_manager.GetId(scene.handles["mapper"]))
        seq = publisher.store.last_seq_touching(mapper_id)
        assert isinstance(seq, int)

        cases = [
            # (event, node_id, expected)
            ({"seq": seq, "pick": {"nodeId": mapper_id}}, None, True),
            ({"seq": seq + 5, "pick": {"nodeId": mapper_id}}, None, True),
            ({"seq": seq}, mapper_id, True),  # explicit node id, no pick
            ({"seq": seq - 1, "pick": {"nodeId": mapper_id}}, None, False),
            ({"pick": {"nodeId": mapper_id}}, None, False),  # missing seq
            ({"seq": None, "pick": {"nodeId": mapper_id}}, None, False),
            ({"seq": float(seq), "pick": {"nodeId": mapper_id}}, None, False),
            ({"seq": True, "pick": {"nodeId": mapper_id}}, None, False),
            ({"seq": seq}, None, False),  # no node id anywhere
            ({"seq": seq, "pick": None}, None, False),
            ({"seq": seq, "pick": {"nodeId": "999999"}}, None, False),  # unknown
            ({"seq": seq, "pick": {"nodeId": mapper_id}}, "999999", False),
            (None, mapper_id, False),  # not an event mapping
        ]
        for event, node_id, expected in cases:
            assert publisher.event_is_current(event, node_id) is expected, (
                event,
                node_id,
            )
            assert event_is_current(publisher.store, event, node_id) is expected
    finally:
        publisher.cleanup()


def test_event_is_current_goes_stale_when_the_node_is_touched_or_removed():
    scene = make_basic_scene()
    publisher, _server = make_publisher(scene)
    try:
        object_manager = scene.api.vtk_object_manager
        actor_id = str(object_manager.GetId(scene.handles["actor"]))
        event = {"seq": publisher.store.seq, "pick": {"nodeId": actor_id}}
        assert publisher.event_is_current(event)

        # Any op touching the node bumps its last-touched seq past the event.
        scene.handles["actor"].SetVisibility(False)
        publisher.sync()
        assert not publisher.event_is_current(event)
        assert publisher.event_is_current(
            {**event, "seq": publisher.store.seq}
        )

        # A removed node is unknown -> stale, however fresh the seq claims.
        polydata, _points = make_line_polydata()
        actor2, _mapper2 = add_actor(scene.handles["renderer"], polydata)
        publisher.sync()
        actor2_id = str(object_manager.GetId(actor2))
        assert publisher.event_is_current(
            {"seq": publisher.store.seq, "pick": {"nodeId": actor2_id}}
        )
        scene.handles["renderer"].RemoveActor(actor2)
        publisher.sync()
        assert not publisher.event_is_current(
            {"seq": publisher.store.seq + 100, "pick": {"nodeId": actor2_id}}
        )
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


def test_reentering_dataset_reregisters_its_dropped_blob():
    """A dataset removed from the scene, then re-added through a fresh actor
    over the same VTK object (unchanged MTime), must re-broadcast its content
    blob with real bytes.

    Regression: a landmark clear on a second video load tore down the shared
    crosshair glyph source; removing it UnRegisterBlob'd its points blob, and
    the object manager then served a cached, blob-less state on re-entry, so the
    payload broadcast empty and the client cached an empty array — the glyph
    stamped nothing and every landmark rendered invisible.
    """
    scene = make_basic_scene()
    server = _FakeServer()
    publisher = ScenePublisher(
        server, scene.api, scene.render_window, scene.render_window_id
    )
    try:
        object_manager = scene.api.vtk_object_manager
        polydata, _points = make_line_polydata()
        actor, _mapper = add_actor(scene.handles["renderer"], polydata)
        publisher.sync()
        server.protocol.drain()

        dataset_id = str(object_manager.GetId(polydata))
        points_entry = publisher.store.get(dataset_id)["arrays"]["points"]
        assert points_entry["ref"].startswith("c:")
        expected_bytes = points_entry["size"] * 4  # float32 xyz
        (hash_value,) = ref_manager_hashes([points_entry["ref"]])

        # Removing the actor drops the dataset; its blob is UnRegisterBlob'd.
        scene.handles["renderer"].RemoveActor(actor)
        publisher.sync()
        server.protocol.drain()
        assert object_manager.GetBlob(hash_value) is None

        # Re-add through a NEW actor over the SAME polydata (unchanged MTime).
        add_actor(scene.handles["renderer"], polydata)
        publisher.sync()
        ((_topic, message),) = server.protocol.drain()

        dataset_id = str(object_manager.GetId(polydata))
        (upsert,) = [
            op
            for op in message["ops"]
            if op["op"] == "upsert" and op["id"] == dataset_id
        ]
        entry = upsert["node"]["arrays"]["points"]
        assert entry["ref"] in message["blobs"], (
            "the re-entering dataset's points blob must be inlined"
        )
        payload = bytes(message["blobs"][entry["ref"]])
        assert len(payload) == expected_bytes, (
            f"re-entering dataset broadcast {len(payload)} bytes, expected "
            f"{expected_bytes}; an empty payload leaves the client glyph invisible"
        )
    finally:
        publisher.cleanup()


def test_ref_manager_hashes_strips_namespaces():
    assert ref_manager_hashes(
        ["c:abc", "c2:conn:off", "v:5:points:3", "c:abc"]
    ) == {"abc", "conn", "off"}
    assert ref_manager_hashes(None) == set()


if __name__ == "__main__":  # pragma: no cover
    pytest.main([__file__, "-q"])
