"""Reference clients and test doubles shared by the publisher tests."""

from __future__ import annotations

import contextlib
import copy

import numpy as np

from push_oracle.reference import apply_ops
from trame_vtklocal.widgets import publisher as publisher_module
from trame_vtklocal.widgets.hot_arrays import JS_ARRAY_DTYPE_MAP
from trame_vtklocal.widgets.publisher import ScenePublisher


class FakeProtocol:
    def __init__(self):
        self.messages = []

    def publish(self, topic, payload, client_id=None):
        self.messages.append((topic, copy.deepcopy(payload)))

    def drain(self):
        messages = self.messages
        self.messages = []
        return messages


class FakeServer:
    def __init__(self):
        self.protocol = FakeProtocol()


class CountingObjectManager:
    """Object manager wrapper that records which ids were serialized."""

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


def blob_size(object_manager, hash_value):
    """Registered blob length, 0 when the hash is gone.

    VTK 9.6 answers an unknown hash with an empty array rather than None, so
    the length is the liveness test.
    """
    blob = object_manager.GetBlob(hash_value)
    return 0 if blob is None else memoryview(blob).nbytes


def live_refs(nodes):
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
        assert set(payload["blobs"]) == live_refs(payload["nodes"]) - known

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
        live = live_refs(self.nodes)
        self.blobs = {ref: data for ref, data in self.blobs.items() if ref in live}
        missing = live - set(self.blobs)
        assert not missing, f"live refs without cached content: {sorted(missing)}"


def make_publisher(scene):
    server = FakeServer()
    publisher = ScenePublisher(
        server, scene.api, scene.render_window, scene.render_window_id
    )
    return publisher, server


@contextlib.contextmanager
def hot_array_fast_path(enabled):
    """Run the block with the publisher's sparse-patch bypass on or off.

    Disabled, every tick goes through the full serialization path: object
    manager serialization and translation.
    """
    if enabled:
        yield
        return
    original = publisher_module.commit_hot_array_batch
    publisher_module.commit_hot_array_batch = lambda *args, **kwargs: None
    try:
        yield
    finally:
        publisher_module.commit_hot_array_batch = original


def cloud_dataset_id(scene):
    return str(scene.api.vtk_object_manager.GetId(scene.handles["polydata"]))


def touch_point(scene, index, value):
    scene.handles["points"].SetPoint(index, *value)
    scene.handles["points"].Modified()


def start_retention(scene, publisher, server):
    """First mutation pays a full send and starts retained-copy tracking."""
    touch_point(scene, 0, (9.0, 9.0, 9.0))
    publisher.sync()
    ((_topic, message),) = server.protocol.drain()
    (op,) = message["ops"]
    assert op["op"] == "upsert"
    assert set(message["blobs"]) == {op["node"]["arrays"]["points"]["ref"]}
    return message
