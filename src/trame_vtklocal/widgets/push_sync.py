import copy
from collections.abc import Mapping

import numpy as np

try:
    from vtkmodules.util.numpy_support import vtk_to_numpy
except ImportError:  # pragma: no cover - VTK is an optional dependency
    vtk_to_numpy = None


SYNTHETIC_VERSION_PREFIX = "v:"
SYNTHETIC_CELL_PREFIX = "cell:"
RESERVED_HASH_PREFIXES = (SYNTHETIC_VERSION_PREFIX, SYNTHETIC_CELL_PREFIX)
PARTIAL_ARRAY_PATHS = {"points"}
MESSAGE_ENVELOPE_KEYS = {"rwId", "kind", "epoch", "seq", "baseSeq", "extra"}
JS_ARRAY_DTYPE_MAP = {
    "Int8Array": np.int8,
    "Uint8Array": np.uint8,
    "Int16Array": np.int16,
    "Uint16Array": np.uint16,
    "Int32Array": np.int32,
    "Uint32Array": np.uint32,
    "Float32Array": np.float32,
    "Float64Array": np.float64,
    "BigInt64Array": np.int64,
    "BigUint64Array": np.uint64,
}
NP_DTYPE_JS_ARRAY_MAP = {
    np.dtype(np_type): js_type for js_type, np_type in JS_ARRAY_DTYPE_MAP.items()
}


def _walk_descriptors(state):
    """Yield each array descriptor dict in a translated state tree."""
    if isinstance(state, list):
        for item in state:
            yield from _walk_descriptors(item)
        return
    if not isinstance(state, dict):
        return

    if "hash" in state and "dataType" in state:
        yield state
        return

    for value in state.values():
        yield from _walk_descriptors(value)


def _collect_hashes(state):
    return {descriptor["hash"] for descriptor in _walk_descriptors(state)}


def _contains_array_descriptor(value):
    if isinstance(value, list):
        return any(_contains_array_descriptor(item) for item in value)
    if not isinstance(value, dict):
        return False
    if "hash" in value and "dataType" in value:
        return True
    return any(_contains_array_descriptor(item) for item in value.values())


def _collect_partial_array_hashes(state):
    """Return {(instance_id, array_path): hash} for patchable array descriptors."""
    result = {}

    def visit_object(value):
        if not isinstance(value, dict):
            return

        instance_id = value.get("id")
        properties = value.get("properties")
        if instance_id is not None and isinstance(properties, dict):
            for array_path in PARTIAL_ARRAY_PATHS:
                descriptor = properties.get(array_path)
                if not isinstance(descriptor, dict):
                    continue
                if "hash" not in descriptor or "dataType" not in descriptor:
                    continue
                try:
                    iid = int(instance_id)
                except (TypeError, ValueError):
                    continue
                result[(iid, array_path)] = descriptor["hash"]

        deps = value.get("dependencies")
        if isinstance(deps, list):
            for dep in deps:
                visit_object(dep)

    visit_object(state)
    return result


def _state_for_ledger(value):
    """Deep-copy state with transport-only fields and inline bytes removed."""
    if isinstance(value, list):
        return [_state_for_ledger(item) for item in value]
    if not isinstance(value, dict):
        return copy.deepcopy(value)

    result = {}
    for key, child in value.items():
        if key in MESSAGE_ENVELOPE_KEYS or key == "content":
            continue
        result[key] = _state_for_ledger(child)
    return result


def _flatten_state_objects(state):
    objects = {}

    def visit(value):
        if not isinstance(value, dict):
            return

        object_id = value.get("id")
        if object_id is not None:
            objects[str(object_id)] = value

        for dep in value.get("dependencies") or []:
            visit(dep)

    visit(state)
    return objects


def _dependency_signature(obj):
    deps = obj.get("dependencies") or []
    return [(str(dep.get("id")), dep.get("type")) for dep in deps]


def _numpy_array_from_vtk_data(data):
    if vtk_to_numpy is not None and hasattr(data, "GetDataType"):
        try:
            return vtk_to_numpy(data)
        except Exception:
            pass
    return np.asarray(data)


def _js_type_for_numpy_array(array):
    dtype = np.asarray(array).dtype
    js_type = NP_DTYPE_JS_ARRAY_MAP.get(dtype)
    if js_type is not None:
        return js_type

    if dtype.kind == "f":
        return "Float64Array" if dtype.itemsize == 8 else "Float32Array"
    if dtype.kind == "u":
        if dtype.itemsize == 1:
            return "Uint8Array"
        if dtype.itemsize == 2:
            return "Uint16Array"
        if dtype.itemsize == 4:
            return "Uint32Array"
        return "BigUint64Array"
    if dtype.kind in {"i", "b"}:
        if dtype.itemsize == 1:
            return "Int8Array"
        if dtype.itemsize == 2:
            return "Int16Array"
        if dtype.itemsize == 4:
            return "Int32Array"
        return "BigInt64Array"
    return "Float32Array"


def _array_payload_for_js_type(array, js_type=None):
    flat = np.asarray(array).reshape(-1)
    resolved_js_type = js_type or _js_type_for_numpy_array(flat)
    np_type = JS_ARRAY_DTYPE_MAP.get(resolved_js_type, np.float32)
    return flat.astype(np_type, copy=False).tobytes(), resolved_js_type


def _pack_cell_array_payload(vtk_object_manager, cell_hash):
    """Recreate the packed vtk.js Uint32 cell-array bytes for a `cell:conn:off` hash."""
    parts = cell_hash.split(":")
    conn_hash = parts[1]
    off_hash = parts[2]

    conn_blob = vtk_object_manager.GetBlob(conn_hash)
    off_blob = vtk_object_manager.GetBlob(off_hash)

    connectivity = np.frombuffer(memoryview(conn_blob), dtype=np.int64)
    offsets = np.frombuffer(memoryview(off_blob), dtype=np.int64)

    sizes = np.diff(offsets).astype(np.uint32)
    conn_uint32 = connectivity.astype(np.uint32)
    result = np.empty(len(sizes) + len(conn_uint32), dtype=np.uint32)
    cell_starts = np.arange(len(sizes), dtype=np.int64) + offsets[:-1]
    result[cell_starts] = sizes
    mask = np.ones(len(result), dtype=bool)
    mask[cell_starts] = False
    result[mask] = conn_uint32
    return result.tobytes()


class PushSync:
    """Server-authoritative push sync for one render window.

    Tracks per-client `known_hashes` so full pushes only inline payloads the
    client doesn't already have, and tags partially-mutated points arrays with
    synthetic version hashes (`v:{rw_id}:{iid}:points:{n}`) so animated
    arrays don't churn the object-manager hash on every flush.
    """

    def __init__(
        self,
        server,
        get_vtkjs_state,
        get_instance_id,
        render_window_id,
        api=None,
    ):
        self._server = server
        self._get_vtkjs_state = get_vtkjs_state
        self._get_instance_id = get_instance_id
        self._render_window_id = str(render_window_id)
        self._rw_id_int = int(render_window_id)
        self._api = api
        self._pending_changes = []

        # per-(client_id) set of hashes that client currently has cached
        self._known_hashes = {}
        # clients that have completed at least one resync for this view
        self._view_clients = set()
        # per-client collection trackers used by vtkjs_translator
        self._collection_trackers = {}
        # (rw_id, instance_id, array_path) -> int counter
        self._array_versions = {}
        # (rw_id, instance_id, array_path) -> current synthetic hash
        self._current_array_hashes = {}
        # Authoritative render-window sequence and per-client stream cursors.
        self._sequence = 0
        self._client_epochs = {}
        self._client_sequences = {}
        self._client_states = {}

        if api is not None:
            api.register_push_view(self._rw_id_int, self)

    def cleanup(self):
        if self._api is not None:
            self._api.unregister_push_view(self._rw_id_int)
        self._api = None
        self._known_hashes.clear()
        self._view_clients.clear()
        self._collection_trackers.clear()
        self._array_versions.clear()
        self._current_array_hashes.clear()
        self._client_epochs.clear()
        self._client_sequences.clear()
        self._client_states.clear()

    def drop_client(self, client_id):
        self._view_clients.discard(client_id)
        self._known_hashes.pop(client_id, None)
        self._collection_trackers.pop(client_id, None)
        self._client_epochs.pop(client_id, None)
        self._client_sequences.pop(client_id, None)
        self._client_states.pop(client_id, None)

    # ------------------------------------------------------------------
    # Payload resolution
    # ------------------------------------------------------------------

    def _resolve_version_payload(self, hash_val, descriptor=None):
        """Resolve a synthetic `v:{rw_id}:{iid}:{path}:{version}` hash."""
        parts = hash_val.split(":")
        if len(parts) < 5:
            return None
        try:
            iid = int(parts[2])
        except ValueError:
            return None
        array_path = parts[3]

        if array_path != "points":
            return None

        obj = self._api.vtk_object_manager.GetObjectAtId(iid)
        if obj is None or not hasattr(obj, "GetPoints"):
            return None
        pts = obj.GetPoints()
        if pts is None:
            return None
        data = pts.GetData()
        if data is None:
            return None
        arr = _numpy_array_from_vtk_data(data)
        payload, _js_type = _array_payload_for_js_type(
            arr, (descriptor or {}).get("dataType")
        )
        return payload

    def _resolve_payload(self, descriptor):
        if self._api is None:
            return None

        hash_val = descriptor["hash"]

        # `v:` and `cell:` are synthetic hash namespaces owned by PushSync.
        # Real object-manager blobs should not use these prefixes.
        if hash_val.startswith(SYNTHETIC_VERSION_PREFIX):
            return self._resolve_version_payload(hash_val, descriptor)
        if hash_val.startswith(SYNTHETIC_CELL_PREFIX):
            return _pack_cell_array_payload(self._api.vtk_object_manager, hash_val)
        assert not hash_val.startswith(RESERVED_HASH_PREFIXES)

        blob = self._api.vtk_object_manager.GetBlob(hash_val)
        if blob is None:
            return None
        return bytes(memoryview(blob))

    def _inline_payloads(self, state, _missing):
        inlined = set()
        for descriptor in _walk_descriptors(state):
            hash_val = descriptor["hash"]
            if descriptor.get("content") is not None:
                inlined.add(hash_val)
                continue
            payload = self._resolve_payload(descriptor)
            if payload is None:
                continue
            descriptor["content"] = payload
            inlined.add(hash_val)
        return inlined

    def _convert_attachments(self, state):
        if self._api is not None:
            self._api._convert_bytes_to_attachments(state)

    def _prune_dead_array_versions(self, live):
        dead_keys = []
        for key, version in self._array_versions.items():
            rw_id, iid, path = key
            synthetic = f"v:{rw_id}:{iid}:{path}:{version}"
            if synthetic not in live:
                dead_keys.append(key)
        for key in dead_keys:
            self._array_versions.pop(key, None)
            self._current_array_hashes.pop(key, None)

    def _refresh_partial_array_hashes(self, state):
        for (iid, array_path), hash_val in _collect_partial_array_hashes(state).items():
            self._current_array_hashes[(self._rw_id_int, iid, array_path)] = hash_val

    # ------------------------------------------------------------------
    # Publish helpers
    # ------------------------------------------------------------------

    def _next_sequence(self):
        self._sequence += 1
        return self._sequence

    def _get_client_epoch(self, client_id):
        return self._client_epochs.get(client_id, 0)

    def _annotate_full_state(self, state, client_id, seq):
        state["rwId"] = self._render_window_id
        state["kind"] = "full"
        state["epoch"] = self._get_client_epoch(client_id)
        state["seq"] = seq
        return state

    def _get_client_tracker(self, client_id, reset=False):
        if client_id is None:
            return {}
        if reset or client_id not in self._collection_trackers:
            self._collection_trackers[client_id] = {}
        return self._collection_trackers[client_id]

    def _get_client_state(self, client_id, reset_tracker=False):
        tracker = self._get_client_tracker(client_id, reset=reset_tracker)
        return self._get_vtkjs_state(self._array_versions, tracker)

    def _publish_client_state(
        self, client_id, state, force_full_inline=False, seq=None
    ):
        if not self._server.protocol:
            return

        if seq is None:
            seq = self._sequence

        live = _collect_hashes(state)
        known = self._known_hashes.get(client_id, set())
        if force_full_inline:
            missing = set(live)
        else:
            missing = live - known

        client_state = copy.deepcopy(state)
        self._annotate_full_state(client_state, client_id, seq)
        inlined = self._inline_payloads(client_state, missing)
        self._convert_attachments(client_state)

        self._server.protocol.publish(
            "trame.vtk.delta", client_state, client_id=client_id
        )
        self._known_hashes[client_id] = (known & live) | inlined
        self._client_sequences[client_id] = seq
        self._client_states[client_id] = _state_for_ledger(client_state)

    def _build_property_patch(self, client_id, state, base_seq, seq):
        previous_state = self._client_states.get(client_id)
        if previous_state is None:
            return None

        current_state = _state_for_ledger(state)
        previous_objects = _flatten_state_objects(previous_state)
        current_objects = _flatten_state_objects(current_state)

        if previous_objects.keys() != current_objects.keys():
            return None

        ops = []
        for object_id, current_obj in current_objects.items():
            previous_obj = previous_objects[object_id]

            if previous_obj.get("type") != current_obj.get("type"):
                return None
            if previous_obj.get("calls") != current_obj.get("calls"):
                return None
            if previous_obj.get("arrays") != current_obj.get("arrays"):
                return None
            if _dependency_signature(previous_obj) != _dependency_signature(
                current_obj
            ):
                return None

            previous_props = previous_obj.get("properties") or {}
            current_props = current_obj.get("properties") or {}
            if not isinstance(previous_props, Mapping) or not isinstance(
                current_props, Mapping
            ):
                return None

            removed_keys = set(previous_props) - set(current_props)
            if removed_keys:
                return None

            changed_props = {}
            for key, value in current_props.items():
                previous_value = previous_props.get(key)
                if previous_value == value:
                    continue
                if _contains_array_descriptor(
                    previous_value
                ) or _contains_array_descriptor(value):
                    return None
                changed_props[key] = copy.deepcopy(value)

            if changed_props:
                ops.append(
                    {
                        "op": "setProperties",
                        "id": object_id,
                        "properties": changed_props,
                    }
                )

        if not ops and state.get("extra") is None:
            return None

        payload = {
            "rwId": self._render_window_id,
            "kind": "patch",
            "epoch": self._get_client_epoch(client_id),
            "baseSeq": base_seq,
            "seq": seq,
            "ops": ops,
        }
        if state.get("extra") is not None:
            payload["extra"] = state["extra"]
        return payload, current_state

    def _publish_patch(self, client_id, payload, ledger_state):
        self._convert_attachments(payload)
        self._server.protocol.publish("trame.vtk.patch", payload, client_id=client_id)
        self._client_sequences[client_id] = payload["seq"]
        self._client_states[client_id] = ledger_state

    def _advance_client_ledger_for_partials(self, client_id, updates):
        state = self._client_states.get(client_id)
        if not state:
            return

        objects = _flatten_state_objects(state)
        for update in updates:
            instance_id = str(update.get("instanceId"))
            array_path = update.get("arrayPath")
            new_hash = update.get("newHash")
            if not instance_id or not array_path or not new_hash:
                continue

            properties = objects.get(instance_id, {}).get("properties")
            descriptor = (
                properties.get(array_path) if isinstance(properties, dict) else None
            )
            if isinstance(descriptor, dict):
                descriptor["hash"] = new_hash
                descriptor.pop("content", None)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def client_resync(self, client_id):
        """Return a fully-inlined state for one client; refresh tracking."""
        if client_id is not None:
            self._client_epochs[client_id] = self._client_epochs.get(client_id, 0) + 1

        state = self._get_client_state(client_id, reset_tracker=True)
        live = _collect_hashes(state)
        self._prune_dead_array_versions(live)
        self._refresh_partial_array_hashes(state)
        self._annotate_full_state(state, client_id, self._sequence)

        inlined = self._inline_payloads(state, live)
        self._convert_attachments(state)

        if client_id is not None:
            self._known_hashes[client_id] = set(inlined)
            self._view_clients.add(client_id)
            self._client_sequences[client_id] = self._sequence
            self._client_states[client_id] = _state_for_ledger(state)
        return state

    def request_resync(self, extra=None):
        """Server-initiated full resync for every tracked client."""
        self._pending_changes.clear()

        if not self._server.protocol or not self._view_clients:
            return

        seq = self._next_sequence()

        # Translation is per-client because collection membership tracking is
        # per-client. Revisit if many subscribers make that cost material.
        for sid in list(self._view_clients):
            state = self._get_client_state(sid, reset_tracker=True)
            if extra:
                state.setdefault("extra", {}).update(extra)

            live = _collect_hashes(state)
            self._prune_dead_array_versions(live)
            self._refresh_partial_array_hashes(state)
            self._known_hashes[sid] = set()
            self._publish_client_state(sid, state, force_full_inline=True, seq=seq)

    def update(self, extra=None):
        if not self._server.protocol or not self._view_clients:
            return

        self._pending_changes.clear()
        base_seq = self._sequence
        seq = self._next_sequence()
        # Translation is per-client because collection membership tracking is
        # per-client. Revisit if many subscribers make that cost material.
        for sid in list(self._view_clients):
            state = self._get_client_state(sid)
            if extra:
                state.setdefault("extra", {}).update(extra)

            live = _collect_hashes(state)
            self._prune_dead_array_versions(live)
            self._refresh_partial_array_hashes(state)
            if self._client_sequences.get(sid, 0) == base_seq:
                patch_result = self._build_property_patch(sid, state, base_seq, seq)
                if patch_result is not None:
                    patch, ledger_state = patch_result
                    self._known_hashes[sid] = self._known_hashes.get(sid, set()) & live
                    self._publish_patch(sid, patch, ledger_state)
                    continue
            self._publish_client_state(sid, state, seq=seq)

    def mark_modified(
        self,
        vtk_object,
        array_path,
        start=0,
        count=None,
        data=None,
        data_type=None,
    ):
        instance_id = self._get_instance_id(vtk_object)
        self._pending_changes.append(
            (vtk_object, instance_id, array_path, start, count, data, data_type)
        )

    def flush(self, extra=None):
        if not self._pending_changes or not self._server.protocol:
            return False

        if not self._view_clients:
            self._pending_changes.clear()
            return False

        # Bump version once per (rw_id, iid, path); only "points" is supported
        # as a partial path. Anything else falls back to a full update.
        for _vtk, _iid, array_path, *_ in self._pending_changes:
            if array_path != "points":
                self._pending_changes.clear()
                self.update(extra=extra)
                return True

        base_seq = self._sequence
        seq = self._next_sequence()
        bumped = {}
        for _vtk, iid, array_path, *_ in self._pending_changes:
            key = (self._rw_id_int, int(iid), array_path)
            if key not in bumped:
                self._array_versions[key] = self._array_versions.get(key, 0) + 1
                old_hash = self._current_array_hashes.get(key)
                new_hash = (
                    f"{SYNTHETIC_VERSION_PREFIX}{self._rw_id_int}:"
                    f"{iid}:{array_path}:{self._array_versions[key]}"
                )
                self._current_array_hashes[key] = new_hash
                bumped[key] = (old_hash, new_hash)

        updates = []
        for (
            vtk_obj,
            iid,
            array_path,
            start,
            count,
            raw_data,
            raw_type,
        ) in self._pending_changes:
            if raw_data is not None:
                data = raw_data
                data_type = raw_type
            else:
                data, data_type, _bytes_per_elem = self.extract_array_region(
                    vtk_obj, array_path, start, count
                )
                if data is None:
                    continue

            # Non-points paths fall back to update() above; points are flat xyz.
            element_offset = start * 3

            old_hash, new_hash = bumped[(self._rw_id_int, int(iid), array_path)]
            update = {
                "instanceId": iid,
                "arrayPath": array_path,
                "offset": element_offset,
                "data": data,
                "dataType": data_type,
                "newHash": new_hash,
            }
            if old_hash is not None:
                update["oldHash"] = old_hash
            updates.append(update)

        if not updates:
            self._pending_changes.clear()
            return False

        for sid in list(self._view_clients):
            if self._client_sequences.get(sid, 0) != base_seq:
                state = self._get_client_state(sid, reset_tracker=True)
                if extra:
                    state.setdefault("extra", {}).update(extra)
                live = _collect_hashes(state)
                self._prune_dead_array_versions(live)
                self._refresh_partial_array_hashes(state)
                self._known_hashes[sid] = set()
                self._publish_client_state(sid, state, force_full_inline=True, seq=seq)
                continue

            payload = {
                "rwId": self._render_window_id,
                "kind": "arrayPartial",
                "epoch": self._get_client_epoch(sid),
                "baseSeq": base_seq,
                "seq": seq,
                "updates": copy.deepcopy(updates),
            }
            if extra is not None:
                payload["extra"] = extra

            self._convert_attachments(payload)
            self._server.protocol.publish(
                "trame.vtk.array.partial", payload, client_id=sid
            )

            client_known = self._known_hashes.setdefault(sid, set())
            for update in updates:
                old_hash = update.get("oldHash")
                if old_hash is not None:
                    client_known.discard(old_hash)
                client_known.add(update["newHash"])
            self._client_sequences[sid] = seq
            self._advance_client_ledger_for_partials(sid, updates)

        self._pending_changes.clear()
        return True

    @staticmethod
    def extract_array_region(vtk_object, array_path, start, count):
        if array_path == "points" and hasattr(vtk_object, "GetPoints"):
            pts = vtk_object.GetPoints()
            if pts is not None:
                data = pts.GetData()
                if data is not None:
                    arr = _numpy_array_from_vtk_data(data)
                    n_components = (
                        data.GetNumberOfComponents()
                        if hasattr(data, "GetNumberOfComponents")
                        else 3
                    )
                    flat = np.asarray(arr).reshape(-1)
                    if count is None:
                        count = (len(flat) // n_components) - start
                    element_start = start * n_components
                    element_end = (start + count) * n_components
                    region = flat[element_start:element_end]
                    payload, data_type = _array_payload_for_js_type(region)
                    bytes_per_tuple = (
                        np.dtype(JS_ARRAY_DTYPE_MAP[data_type]).itemsize
                        * n_components
                    )
                    return payload, data_type, bytes_per_tuple

        elif array_path == "lines" and hasattr(vtk_object, "GetLines"):
            lines = vtk_object.GetLines()
            if lines:
                data = lines.GetData()
                if data:
                    arr = np.array(data)
                    if count is None:
                        count = len(arr) - start
                    end = start + count
                    region = arr[start:end]
                    return region.astype(np.int64).tobytes(), "BigInt64Array", 8

        elif array_path == "polys" and hasattr(vtk_object, "GetPolys"):
            polys = vtk_object.GetPolys()
            if polys:
                data = polys.GetData()
                if data:
                    arr = np.array(data)
                    if count is None:
                        count = len(arr) - start
                    end = start + count
                    region = arr[start:end]
                    return region.astype(np.int64).tobytes(), "BigInt64Array", 8

        return None, None, None
