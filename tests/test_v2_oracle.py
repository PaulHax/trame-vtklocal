"""Push-sync v2 oracle: real VTK mutations broadcast to a mirrored client.

Drives real VTK scenes through :class:`ScenePublisher` with a fake wslink
server capturing ``scene.ops`` broadcasts, and maintains a Python client
mirror using the normative ``apply_ops`` from ``test_scene_store``. After
every tick:

- the mirror equals ``store.snapshot()["nodes"]``,
- blob content arrives exactly once per ref entering the live set,
- every live ref resolves in the client cache to the same bytes the server
  would serve, and
- ``scene.resync(known_refs)`` omits blobs the client already holds.
"""

from __future__ import annotations

import copy

import numpy as np
import pytest

from push_oracle.scenes import (
    OracleScene,
    add_actor,
    make_basic_scene,
    make_line_polydata,
    make_pipeline_cone_scene,
    make_polyline_scene,
    make_quad_scene,
    make_scalars_scene,
    make_map_drape_scene,
    make_two_stage_pipeline_scene,
    mutate_map_drape_frame,
    set_float_array_values,
)
from test_scene_store import apply_ops
from trame_vtklocal.module import interaction as pick
from trame_vtklocal.widgets.hot_arrays import JS_ARRAY_DTYPE_MAP
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


def _live_refs(nodes):
    return {
        entry["ref"]
        for node in nodes.values()
        for entry in (node.get("arrays") or {}).values()
    }


class MirrorClient:
    """Reference client: seq rule + normative apply_ops + blob refcounting."""

    def __init__(self):
        self.nodes = {}
        self.seq = None
        self.blobs = {}
        self.commands = []

    def resync(self, publisher, known_refs=()):
        known = set(known_refs)
        payload = publisher.resync(list(known))
        assert payload["v"] == 2
        # Snapshot blobs cover exactly the live refs the client didn't report.
        assert set(payload["blobs"]) == _live_refs(payload["nodes"]) - known

        self.nodes = copy.deepcopy(payload["nodes"])
        self.seq = payload["seq"]
        self.blobs = {ref: self.blobs[ref] for ref in known if ref in self.blobs}
        for ref, data in payload["blobs"].items():
            self.blobs[ref] = bytes(data)
        self._gc_blobs()
        return payload

    def apply(self, message):
        assert message["v"] == 2
        if message["seq"] <= self.seq:
            return "dropped"
        if message["baseSeq"] != self.seq:
            return "resync"

        for ref, data in message["blobs"].items():
            # A blob enters the live set exactly once per entry.
            assert ref not in self.blobs, f"blob {ref!r} arrived twice"
            self.blobs[ref] = bytes(data)

        for op in message["ops"]:
            if op["op"] != "patchArray":
                continue
            entry = self.nodes[op["id"]]["arrays"][op["key"]]
            itemsize = np.dtype(JS_ARRAY_DTYPE_MAP[op["dataType"]]).itemsize
            data = bytes(op["data"])
            patched = bytearray(self.blobs[entry["ref"]])
            start = op["offset"] * itemsize
            patched[start : start + len(data)] = data
            self.blobs[op["ref"]] = bytes(patched)

        apply_ops(self.nodes, message["ops"])
        self.seq = message["seq"]
        self.commands.extend(message.get("commands") or [])
        self._gc_blobs()
        return "applied"

    def _gc_blobs(self):
        live = _live_refs(self.nodes)
        self.blobs = {ref: data for ref, data in self.blobs.items() if ref in live}
        missing = live - set(self.blobs)
        assert not missing, f"live refs without cached content: {sorted(missing)}"


def make_publisher(scene: OracleScene):
    server = _FakeServer()
    publisher = ScenePublisher(
        server, scene.api, scene.render_window, scene.render_window_id
    )
    return publisher, server


def assert_client_matches_server(client, publisher):
    assert client.nodes == publisher.store.snapshot()["nodes"]
    assert client.seq == publisher.store.seq
    for ref, cached in client.blobs.items():
        assert cached == publisher._resolve_ref_payload(ref), ref


def run_v2_oracle(scene_factory, mutators):
    scene = scene_factory()
    publisher, server = make_publisher(scene)
    try:
        client = MirrorClient()
        client.resync(publisher)
        assert_client_matches_server(client, publisher)

        for name, mutate in mutators:
            mutate(scene)
            publisher.sync()
            for topic, message in server.protocol.drain():
                assert topic == OPS_TOPIC
                assert client.apply(message) == "applied", (name, message["seq"])
            assert_client_matches_server(client, publisher)
        return scene, publisher, server, client
    finally:
        publisher.cleanup()


# ----------------------------------------------------------------------
# Property / dataset mutations over every scene shape
# ----------------------------------------------------------------------


def _hide_actor(scene):
    scene.handles["actor"].SetVisibility(False)


def _set_opacity(scene):
    scene.handles["actor"].GetProperty().SetOpacity(0.25)


def _set_color(scene):
    scene.handles["actor"].GetProperty().SetColor(0.1, 0.2, 0.3)


def _set_user_matrix(scene):
    from vtkmodules.vtkCommonMath import vtkMatrix4x4

    matrix = vtkMatrix4x4()
    matrix.Identity()
    matrix.SetElement(0, 0, 1.5)
    matrix.SetElement(0, 3, 4.0)
    scene.handles["actor"].SetUserMatrix(matrix)


def _move_points(scene):
    scene.handles["points"].SetPoint(0, 2.0, 3.0, 4.0)
    scene.handles["points"].Modified()


def _mark_pickable(scene):
    pick.make_pickable(
        scene.handles["mapper"],
        tags={"owner_id": "landmarks", "rev": 1},
        ids=["lm-1"],
        grab_px=36.0,
        priority=2,
    )


def _retag_pickable(scene):
    pick.make_pickable(
        scene.handles["mapper"],
        tags={"owner_id": "landmarks", "rev": 2},
        ids=["lm-1", "lm-2"],
        grab_px=36.0,
        priority=2,
    )


def test_oracle_basic_scene_mutations():
    run_v2_oracle(
        make_basic_scene,
        [
            ("hide-actor", _hide_actor),
            ("set-opacity", _set_opacity),
            ("set-color", _set_color),
            ("set-user-matrix", _set_user_matrix),
            ("move-points", _move_points),
            ("mark-pickable", _mark_pickable),
            ("retag-pickable", _retag_pickable),
        ],
    )


def _mutate_tcoords(scene):
    set_float_array_values(
        scene.handles["tcoords"],
        [(0.5, 0.5), (1.5, 0.5), (1.5, 1.5), (0.5, 1.5)],
    )
    scene.handles["polydata"].Modified()


def _mutate_field_data(scene):
    set_float_array_values(
        scene.handles["homography"],
        [
            (
                2.0, 0.0, 0.5, 0.0,
                0.0, 2.0, 0.5, 0.0,
                0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 0.0, 1.0,
            )
        ],
    )
    scene.handles["polydata"].Modified()


def test_oracle_quad_array_mutations():
    run_v2_oracle(
        make_quad_scene,
        [
            ("move-tcoords", _mutate_tcoords),
            ("update-field-data", _mutate_field_data),
        ],
    )


def _mutate_point_scalars(scene):
    set_float_array_values(
        scene.handles["point_scalars"], [(0.1,), (0.2,), (0.3,), (0.4,)]
    )
    scene.handles["polydata"].Modified()


def _mutate_cell_scalars(scene):
    set_float_array_values(scene.handles["cell_scalars"], [(0.75,)])
    scene.handles["polydata"].Modified()


def test_oracle_scalars_mutations():
    run_v2_oracle(
        make_scalars_scene,
        [
            ("point-scalars", _mutate_point_scalars),
            ("cell-scalars", _mutate_cell_scalars),
        ],
    )


def _replace_lines_cell_array(scene):
    from vtkmodules.vtkCommonDataModel import vtkCellArray

    new_lines = vtkCellArray()
    new_lines.InsertNextCell(2)
    new_lines.InsertCellPoint(0)
    new_lines.InsertCellPoint(1)
    new_lines.InsertNextCell(2)
    new_lines.InsertCellPoint(1)
    new_lines.InsertCellPoint(2)
    scene.handles["polydata"].SetLines(new_lines)
    scene.handles["polydata"].Modified()


def test_oracle_cell_array_replacement():
    run_v2_oracle(
        make_polyline_scene,
        [("replace-lines", _replace_lines_cell_array)],
    )


def _bump_cone_resolution(scene):
    scene.handles["source"].SetResolution(12)


def test_oracle_pipeline_source_mutation():
    run_v2_oracle(
        make_pipeline_cone_scene,
        [("bump-cone-resolution", _bump_cone_resolution)],
    )


def _bump_sphere_resolution(scene):
    scene.handles["source"].SetThetaResolution(12)


def test_oracle_two_stage_pipeline_mutation():
    run_v2_oracle(
        make_two_stage_pipeline_scene,
        [("bump-sphere-resolution", _bump_sphere_resolution)],
    )


def test_oracle_map_drape_frame_loop():
    mutators = [
        (f"frame-{index}", lambda scene, index=index: mutate_map_drape_frame(scene, index))
        for index in range(1, 5)
    ]
    mutators.append(
        ("visibility-only", lambda scene: scene.handles["actors"][0].SetVisibility(False))
    )
    run_v2_oracle(make_map_drape_scene, mutators)


# ----------------------------------------------------------------------
# Structural add/remove: no full fallback exists — must ride ops
# ----------------------------------------------------------------------


def test_oracle_structural_add_and_remove_actor_ride_ops():
    scene = make_basic_scene()
    publisher, server = make_publisher(scene)
    try:
        object_manager = scene.api.vtk_object_manager
        client = MirrorClient()
        client.resync(publisher)

        polydata, _points = make_line_polydata()
        actor2, mapper2 = add_actor(scene.handles["renderer"], polydata)
        publisher.sync()

        ((_topic, message),) = server.protocol.drain()
        assert client.apply(message) == "applied"
        assert_client_matches_server(client, publisher)

        actor2_id = str(object_manager.GetId(actor2))
        mapper2_id = str(object_manager.GetId(mapper2))
        upserted = {op["id"] for op in message["ops"] if op["op"] == "upsert"}
        assert {actor2_id, mapper2_id} <= upserted
        assert not [op for op in message["ops"] if op["op"] == "remove"]
        assert actor2_id in client.nodes

        scene.handles["renderer"].RemoveActor(actor2)
        publisher.sync()

        ((_topic, message),) = server.protocol.drain()
        assert client.apply(message) == "applied"
        assert_client_matches_server(client, publisher)

        removed = {op["id"] for op in message["ops"] if op["op"] == "remove"}
        assert {actor2_id, mapper2_id} <= removed
        assert actor2_id not in client.nodes
    finally:
        publisher.cleanup()


# ----------------------------------------------------------------------
# Commands ordering + duplicate/reorder handling
# ----------------------------------------------------------------------


def test_oracle_commands_ride_ops_and_order_with_scene_changes():
    scene = make_basic_scene()
    publisher, server = make_publisher(scene)
    try:
        client = MirrorClient()
        client.resync(publisher)

        # Command with a scene change: one message carrying both.
        scene.handles["actor"].SetVisibility(False)
        publisher.send_command("mapCamera", {"frame": 1})
        publisher.sync()
        ((_topic, message),) = server.protocol.drain()
        assert message["ops"]
        assert message["commands"] == [{"name": "mapCamera", "payload": {"frame": 1}, "render": True}]
        assert client.apply(message) == "applied"

        # Command with no pending ops: empty-ops message with a fresh seq.
        publisher.send_command("mapCamera", {"frame": 2})
        publisher.sync()
        ((_topic, message),) = server.protocol.drain()
        assert message["ops"] == []
        assert message["baseSeq"] == message["seq"] - 1
        assert client.apply(message) == "applied"
        assert [c["payload"]["frame"] for c in client.commands] == [1, 2]

        # A duplicate delivery is dropped by the seq rule.
        assert client.apply(message) == "dropped"
        assert_client_matches_server(client, publisher)
    finally:
        publisher.cleanup()


def test_oracle_gap_forces_resync_and_resync_omits_known_blobs():
    scene = make_quad_scene()
    publisher, server = make_publisher(scene)
    try:
        client = MirrorClient()
        client.resync(publisher)

        scene.handles["actor"].GetProperty().SetOpacity(0.5)
        publisher.sync()
        server.protocol.drain()  # lose the message -> client has a gap

        _mutate_field_data(scene)
        publisher.sync()
        ((_topic, message),) = server.protocol.drain()
        assert client.apply(message) == "resync"

        known = set(client.blobs)
        payload = client.resync(publisher, known_refs=known)
        assert not (set(payload["blobs"]) & known)
        assert_client_matches_server(client, publisher)
    finally:
        publisher.cleanup()


def test_oracle_two_clients_share_one_broadcast():
    scene = make_basic_scene()
    publisher, server = make_publisher(scene)
    try:
        client_a = MirrorClient()
        client_b = MirrorClient()
        client_a.resync(publisher)
        # Client B reconnects with a surviving cache (same refs as A) and
        # reports them: the snapshot re-inlines nothing.
        client_b.blobs = dict(client_a.blobs)
        payload = client_b.resync(publisher, known_refs=set(client_b.blobs))
        assert payload["blobs"] == {}

        scene.handles["points"].SetPoint(0, 4.0, 4.0, 4.0)
        scene.handles["points"].Modified()
        publisher.sync()

        ((_topic, message),) = server.protocol.drain()
        assert client_a.apply(message) == "applied"
        assert client_b.apply(copy.deepcopy(message)) == "applied"
        assert_client_matches_server(client_a, publisher)
        assert client_a.nodes == client_b.nodes
    finally:
        publisher.cleanup()


# ----------------------------------------------------------------------
# Sweep heals observer false negatives
# ----------------------------------------------------------------------


def test_oracle_sync_sweep_heals_missed_dirty_marks():
    scene = make_basic_scene()
    publisher, server = make_publisher(scene)
    try:
        client = MirrorClient()
        client.resync(publisher)

        # Mutate under suppression: the observer mark is dropped, simulating
        # a false negative. The next sync()'s mtime sweep must heal it.
        with publisher._tracker.suppress():
            scene.handles["actor"].SetVisibility(False)
        assert not publisher._tracker.has_pending()

        publisher.sync()
        ((_topic, message),) = server.protocol.drain()
        assert client.apply(message) == "applied"
        assert_client_matches_server(client, publisher)
        actor_id = str(scene.api.vtk_object_manager.GetId(scene.handles["actor"]))
        assert client.nodes[actor_id]["props"]["visibility"] == 0
    finally:
        publisher.cleanup()


# ----------------------------------------------------------------------
# request_resync
# ----------------------------------------------------------------------


def test_oracle_request_resync_broadcast_never_applies():
    scene = make_basic_scene()
    publisher, server = make_publisher(scene)
    try:
        client = MirrorClient()
        client.resync(publisher)
        seq_before = publisher.store.seq

        publisher.request_resync()
        ((topic, message),) = server.protocol.drain()
        assert topic == OPS_TOPIC
        assert message["baseSeq"] == -1
        assert message["ops"] == []
        assert message["seq"] == seq_before + 1
        assert client.apply(message) == "resync"

        client.resync(publisher, known_refs=set(client.blobs))
        assert_client_matches_server(client, publisher)
    finally:
        publisher.cleanup()


if __name__ == "__main__":  # pragma: no cover
    pytest.main([__file__, "-q"])
