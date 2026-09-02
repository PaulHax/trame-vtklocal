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


class _CountingObjectManager:
    def __init__(self, wrapped):
        self.wrapped = wrapped
        self.get_state_calls = []
        self.update_state_calls = []

    def GetState(self, object_id):
        self.get_state_calls.append(int(object_id))
        return self.wrapped.GetState(object_id)

    def UpdateStateFromObject(self, object_id):
        self.update_state_calls.append(int(object_id))
        return self.wrapped.UpdateStateFromObject(object_id)

    def __getattr__(self, name):
        return getattr(self.wrapped, name)


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

    coords = np.linspace(0.0, 1.0, point_count * 3, dtype=np.float32).reshape(-1, 3)
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


def blob_size(object_manager, hash_value):
    """Registered blob length (0 when the hash is gone)."""
    blob = object_manager.GetBlob(hash_value)
    return 0 if blob is None else memoryview(blob).nbytes


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


def test_two_distant_point_moves_emit_two_small_patches(publisher_env):
    scene, publisher, server = publisher_env
    _start_retention(scene, publisher, server)

    _touch_point(scene, 20, (2.0, 3.0, 4.0))
    _touch_point(scene, 8_000, (5.0, 6.0, 7.0))
    publisher.sync()

    ((_topic, message),) = server.protocol.drain()
    patches = [op for op in message["ops"] if op["op"] == "patchArray"]
    assert [op["offset"] for op in patches] == [60, 24_000]
    assert sum(len(bytes(op["data"])) for op in patches) == 6 * 4


def test_retained_point_patch_skips_full_object_manager_serialization():
    scene = make_points_cloud_scene()
    counting = _CountingObjectManager(scene.api.vtk_object_manager)
    scene.api.vtk_object_manager = counting
    server = _FakeServer()
    publisher = ScenePublisher(
        server, scene.api, scene.render_window, scene.render_window_id
    )
    try:
        _start_retention(scene, publisher, server)
        counting.update_state_calls.clear()

        _touch_point(scene, 1234, (5.0, 6.0, 7.0))
        publisher.sync()

        ((_topic, message),) = server.protocol.drain()
        assert [op["op"] for op in message["ops"]] == ["patchArray"]
        assert counting.update_state_calls == []
    finally:
        publisher.cleanup()


def test_registered_named_point_data_array_uses_region_patches():
    scene = make_points_cloud_scene(point_count=1_000)
    values = np.arange(1_000, dtype=np.float32)
    vtk_array = numpy_to_vtk(values, deep=True)
    vtk_array.SetName("Heat")
    scene.handles["polydata"].GetPointData().AddArray(vtk_array)
    key = "field:pointData:Heat"
    server = _FakeServer()
    publisher = ScenePublisher(
        server,
        scene.api,
        scene.render_window,
        scene.render_window_id,
        hot_array_keys={key},
    )
    try:
        vtk_array.SetValue(1, -1.0)
        vtk_array.Modified()
        publisher.sync()
        server.protocol.drain()  # first candidate starts retention

        vtk_array.SetValue(10, -10.0)
        vtk_array.SetValue(900, -900.0)
        vtk_array.Modified()
        publisher.sync()

        ((_topic, message),) = server.protocol.drain()
        patches = [op for op in message["ops"] if op["op"] == "patchArray"]
        assert [op["key"] for op in patches] == [key, key]
        assert [op["offset"] for op in patches] == [10, 900]
    finally:
        publisher.cleanup()


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


def test_over_cap_array_is_never_retained(publisher_env):
    """The retention cap outranks "there is no retained copy yet".

    Retention exists only to make patching possible, and an array past the
    cap can never be patched. Copying one would hold exactly the memory the
    cap refuses, for a diff that will never be taken.
    """
    scene, publisher, server = publisher_env
    publisher._hot_arrays._cap_bytes = 8

    _touch_point(scene, 0, (9.0, 9.0, 9.0))
    publisher.sync()

    ((_topic, message),) = server.protocol.drain()
    (op,) = message["ops"]
    assert op["op"] == "upsert"
    assert publisher._hot_arrays._retained == {}

    # Still refused on a later tick, when a stored entry does exist.
    _touch_point(scene, 1, (8.0, 8.0, 8.0))
    publisher.sync()
    server.protocol.drain()
    assert publisher._hot_arrays._retained == {}


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
    # A simultaneous non-array change deliberately takes the full translation
    # fallback, which creates the unused fresh blob this test exercises.
    scene.handles["actor"].SetVisibility(False)
    publisher.sync()
    orphan_ref = publisher._hot_arrays._orphaned_refs[_dataset_id(scene)]
    (orphan_hash,) = ref_manager_hashes([orphan_ref])
    assert blob_size(object_manager, orphan_hash)

    # The next patch mints a new fresh hash; the previous orphan's blob is
    # no longer referenced by any state and is queued for the debounced GC.
    _touch_point(scene, 43, (2.0, 2.0, 2.0))
    scene.handles["actor"].SetVisibility(True)
    publisher.sync()
    assert blob_size(object_manager, orphan_hash)  # retire is deferred
    scene.api.flush_stale_blobs()
    assert not blob_size(object_manager, orphan_hash)


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
            str(object_manager.GetId(scene.handles["actor"].GetProperty())) in upserted
        )
        assert message["commands"] == [
            {"name": "mapCamera", "payload": {"frame": 3}, "render": True}
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
    assert message["commands"] == [{"name": "ping", "payload": None, "render": True}]
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


def test_retained_commands_are_replaced_cleared_and_replayed_on_resync():
    scene = make_basic_scene()
    publisher, _server = make_publisher(scene)
    try:
        publisher.send_command(
            "camera.set", {"parallelScale": 2}, retain=True, render=True
        )
        assert publisher.resync([])["commands"] == [
            {
                "name": "camera.set",
                "payload": {"parallelScale": 2},
                "render": True,
            }
        ]

        publisher.send_command(
            "camera.set", {"parallelScale": 4}, retain=True, render=True
        )
        assert publisher.resync([])["commands"][0]["payload"] == {"parallelScale": 4}

        publisher.send_command("camera.set", None, retain=True)
        assert "commands" not in publisher.resync([])
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
        assert message["commands"] == [
            {"name": "mapCamera", "payload": {"frame": 3}, "render": True}
        ]
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
            ({"seq": seq}, mapper_id, True),
            ({"seq": seq + 5}, mapper_id, True),
            ({"seq": seq - 1}, mapper_id, False),
            ({}, mapper_id, False),  # missing seq
            ({"seq": None}, mapper_id, False),
            ({"seq": float(seq)}, mapper_id, False),
            ({"seq": True}, mapper_id, False),
            # The node is always the caller's to name; there is no fallback to
            # anything inside the event.
            ({"seq": seq, "pick": {"nodeId": mapper_id}}, None, False),
            ({"seq": seq}, "999999", False),  # unknown node
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
        event = {"seq": publisher.store.seq}
        assert publisher.event_is_current(event, actor_id)

        # Any op touching the node bumps its last-touched seq past the event.
        scene.handles["actor"].SetVisibility(False)
        publisher.sync()
        assert not publisher.event_is_current(event, actor_id)
        assert publisher.event_is_current({"seq": publisher.store.seq}, actor_id)

        # A removed node is unknown -> stale, however fresh the seq claims.
        polydata, _points = make_line_polydata()
        actor2, _mapper2 = add_actor(scene.handles["renderer"], polydata)
        publisher.sync()
        actor2_id = str(object_manager.GetId(actor2))
        assert publisher.event_is_current({"seq": publisher.store.seq}, actor2_id)
        scene.handles["renderer"].RemoveActor(actor2)
        publisher.sync()
        assert not publisher.event_is_current(
            {"seq": publisher.store.seq + 100}, actor2_id
        )
    finally:
        publisher.cleanup()


def test_patch_array_staleness_counts_by_default_and_relaxes_mid_gesture(
    publisher_env,
):
    scene, publisher, server = publisher_env
    _start_retention(scene, publisher, server)
    dataset_id = _dataset_id(scene)
    event = {"seq": publisher.store.seq}

    _touch_point(scene, 12, (8.0, 7.0, 6.0))
    publisher.sync()
    server.protocol.drain()

    # The patch moved the very points the pick was measured against.
    assert not publisher.event_is_current(event, dataset_id)
    # Mid-gesture callers opt out so their own confirmations don't stale them.
    assert publisher.event_is_current(event, dataset_id, strict=False)


def test_parsed_state_cache_skips_unchanged_referenced_states():
    scene = make_basic_scene()
    counting = _CountingObjectManager(scene.api.vtk_object_manager)
    scene.api.vtk_object_manager = counting
    publisher = ScenePublisher(
        _FakeServer(), scene.api, scene.render_window, scene.render_window_id
    )
    try:
        mapper_id = counting.GetId(scene.handles["mapper"])
        property_id = counting.GetId(scene.handles["actor"].GetProperty())
        counting.get_state_calls.clear()

        scene.handles["actor"].SetVisibility(False)
        publisher.sync()
        scene.handles["actor"].SetVisibility(True)
        publisher.sync()

        assert mapper_id not in counting.get_state_calls
        assert property_id not in counting.get_state_calls
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
            assert blob_size(object_manager, hash_value)

        scene.handles["renderer"].RemoveActor(actor2)
        publisher.sync()
        scene.api.flush_stale_blobs()

        for hash_value in hashes:
            assert not blob_size(object_manager, hash_value)
    finally:
        publisher.cleanup()


def test_reentering_dataset_reregisters_its_dropped_blob():
    """A dataset removed from the scene, then re-added through a fresh actor
    over the same VTK object (unchanged MTime), must re-broadcast its content
    blob with real bytes.

    Removal UnRegisterBlob's the points blob, and the object manager serves a
    cached, blob-less state on re-entry; an empty payload leaves the client
    caching an empty array, so the mapper stamps nothing.
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

        # Removing the actor drops the dataset; the flushed GC UnRegisterBlob's
        # its blob.
        scene.handles["renderer"].RemoveActor(actor)
        publisher.sync()
        server.protocol.drain()
        scene.api.flush_stale_blobs()
        assert not blob_size(object_manager, hash_value)

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
        assert (
            entry["ref"] in message["blobs"]
        ), "the re-entering dataset's points blob must be inlined"
        payload = bytes(message["blobs"][entry["ref"]])
        assert len(payload) == expected_bytes, (
            f"re-entering dataset broadcast {len(payload)} bytes, expected "
            f"{expected_bytes}; an empty payload leaves the client glyph invisible"
        )
    finally:
        publisher.cleanup()


def test_deferred_blob_gc_keeps_hashes_that_return_alive():
    """Protection is computed at flush time: a hash queued as stale that a
    later commit brings back into the live set must survive the flush."""
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

        dataset_id = str(object_manager.GetId(polydata))
        points_entry = publisher.store.get(dataset_id)["arrays"]["points"]
        (hash_value,) = ref_manager_hashes([points_entry["ref"]])

        scene.handles["renderer"].RemoveActor(actor)
        publisher.sync()  # hash queued for the deferred GC

        add_actor(scene.handles["renderer"], polydata)
        publisher.sync()  # hash re-enters the live set before the flush

        scene.api.flush_stale_blobs()
        assert blob_size(object_manager, hash_value)
    finally:
        publisher.cleanup()


def test_ref_manager_hashes_strips_namespaces():
    assert ref_manager_hashes(["c:abc", "c2:conn:off", "v:5:points:3", "c:abc"]) == {
        "abc",
        "conn",
        "off",
    }
    assert ref_manager_hashes(None) == set()


if __name__ == "__main__":  # pragma: no cover
    pytest.main([__file__, "-q"])
