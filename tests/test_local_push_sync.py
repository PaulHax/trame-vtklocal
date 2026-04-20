"""Regression coverage for local push-sync array inlining."""

from copy import deepcopy

from trame_vtklocal.widgets.push_sync import PushSync
from trame_vtklocal.widgets.vtkjs_view import VtkJsLocalView


class _FakeProtocol:
    def __init__(self):
        self.messages = []

    def publish(self, topic, payload):
        self.messages.append((topic, payload))


class _FakeServer:
    def __init__(self):
        self.protocol = _FakeProtocol()


class _FakeObjectManager:
    def __init__(self, blobs):
        self._blobs = blobs

    def GetBlob(self, hash_str):
        return self._blobs[hash_str]


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


def test_push_sync_always_inlines_reused_hashes_on_full_updates():
    states = iter(
        [
            _state_with_points("62", "shared-points"),
            _state_with_points("31", "shared-points"),
        ]
    )
    server = _FakeServer()
    push_sync = PushSync(
        server,
        _FakeObjectManager({"shared-points": b"\x00\x00\x80?\x00\x00\x80?\x00\x00\x80?"}),
        lambda: deepcopy(next(states)),
        lambda vtk_object: str(vtk_object),
        render_window_id=1,
        always_inline_arrays=True,
    )

    push_sync.update()
    push_sync.update()

    assert len(server.protocol.messages) == 2

    _, first_state = server.protocol.messages[0]
    _, second_state = server.protocol.messages[1]

    assert "content" in _find_points_array(first_state, "62")
    assert "content" in _find_points_array(second_state, "31")


def test_local_view_defaults_to_always_inlining_arrays():
    assert VtkJsLocalView._always_inline_arrays is True
