import copy

import numpy as np


SYNTHETIC_VERSION_PREFIX = "v:"
SYNTHETIC_CELL_PREFIX = "cell:"
RESERVED_HASH_PREFIXES = (SYNTHETIC_VERSION_PREFIX, SYNTHETIC_CELL_PREFIX)


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

    properties = state.get("properties")
    if isinstance(properties, dict):
        for value in properties.values():
            yield from _walk_descriptors(value)

    arrays = state.get("arrays")
    if isinstance(arrays, dict):
        for value in arrays.values():
            yield from _walk_descriptors(value)

    deps = state.get("dependencies")
    if isinstance(deps, list):
        for dep in deps:
            yield from _walk_descriptors(dep)


def _collect_hashes(state):
    return {descriptor["hash"] for descriptor in _walk_descriptors(state)}


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

    def drop_client(self, client_id):
        self._view_clients.discard(client_id)
        self._known_hashes.pop(client_id, None)
        self._collection_trackers.pop(client_id, None)

    # ------------------------------------------------------------------
    # Payload resolution
    # ------------------------------------------------------------------

    def _resolve_version_payload(self, hash_val):
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
        if not pts:
            return None
        data = pts.GetData()
        if not data:
            return None
        arr = np.array(data).flatten().astype(np.float32)
        return arr.tobytes()

    def _resolve_payload(self, descriptor):
        if self._api is None:
            return None

        hash_val = descriptor["hash"]

        # `v:` and `cell:` are synthetic hash namespaces owned by PushSync.
        # Real object-manager blobs should not use these prefixes.
        if hash_val.startswith(SYNTHETIC_VERSION_PREFIX):
            return self._resolve_version_payload(hash_val)
        if hash_val.startswith(SYNTHETIC_CELL_PREFIX):
            return _pack_cell_array_payload(self._api.vtk_object_manager, hash_val)
        assert not hash_val.startswith(RESERVED_HASH_PREFIXES)

        blob = self._api.vtk_object_manager.GetBlob(hash_val)
        if blob is None:
            return None
        return bytes(memoryview(blob))

    def _inline_payloads(self, state, missing):
        inlined = set()
        if not missing:
            return inlined
        for descriptor in _walk_descriptors(state):
            hash_val = descriptor["hash"]
            if hash_val not in missing:
                continue
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

    # ------------------------------------------------------------------
    # Publish helpers
    # ------------------------------------------------------------------

    def _get_client_tracker(self, client_id, reset=False):
        if client_id is None:
            return {}
        if reset or client_id not in self._collection_trackers:
            self._collection_trackers[client_id] = {}
        return self._collection_trackers[client_id]

    def _get_client_state(self, client_id, reset_tracker=False):
        tracker = self._get_client_tracker(client_id, reset=reset_tracker)
        return self._get_vtkjs_state(self._array_versions, tracker)

    def _publish_client_state(self, client_id, state, force_full_inline=False):
        if not self._server.protocol:
            return

        live = _collect_hashes(state)
        known = self._known_hashes.get(client_id, set())
        if force_full_inline:
            missing = set(live)
        else:
            missing = live - known

        client_state = copy.deepcopy(state)
        inlined = self._inline_payloads(client_state, missing)
        self._convert_attachments(client_state)

        self._server.protocol.publish(
            "trame.vtk.delta", client_state, client_id=client_id
        )
        self._known_hashes[client_id] = (known & live) | inlined

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def client_resync(self, client_id):
        """Return a fully-inlined state for one client; refresh tracking."""
        state = self._get_client_state(client_id, reset_tracker=True)
        live = _collect_hashes(state)
        self._prune_dead_array_versions(live)

        inlined = self._inline_payloads(state, live)
        self._convert_attachments(state)

        if client_id is not None:
            self._known_hashes[client_id] = set(inlined)
            self._view_clients.add(client_id)
        return state

    def request_resync(self, extra=None):
        """Server-initiated full resync for every tracked client."""
        self._pending_changes.clear()

        if not self._server.protocol or not self._view_clients:
            return

        # Translation is per-client because collection membership tracking is
        # per-client. Revisit if many subscribers make that cost material.
        for sid in list(self._view_clients):
            state = self._get_client_state(sid, reset_tracker=True)
            if extra:
                state.setdefault("extra", {}).update(extra)

            live = _collect_hashes(state)
            self._prune_dead_array_versions(live)
            self._known_hashes[sid] = set()
            self._publish_client_state(sid, state, force_full_inline=True)

    def update(self, extra=None):
        if not self._server.protocol or not self._view_clients:
            return

        self._pending_changes.clear()
        # Translation is per-client because collection membership tracking is
        # per-client. Revisit if many subscribers make that cost material.
        for sid in list(self._view_clients):
            state = self._get_client_state(sid)
            if extra:
                state.setdefault("extra", {}).update(extra)

            live = _collect_hashes(state)
            self._prune_dead_array_versions(live)
            self._publish_client_state(sid, state)

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

        for vtk_obj, iid, array_path, start, count, raw_data, raw_type in self._pending_changes:
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
            payload = {
                "rwId": self._render_window_id,
                "instanceId": iid,
                "arrayPath": array_path,
                "offset": element_offset,
                "data": data,
                "dataType": data_type,
                "extra": extra,
                "newHash": new_hash,
            }
            if old_hash is not None:
                payload["oldHash"] = old_hash

            for sid in list(self._view_clients):
                self._server.protocol.publish(
                    "trame.vtk.array.partial", payload, client_id=sid
                )
                client_known = self._known_hashes.setdefault(sid, set())
                if old_hash is not None:
                    client_known.discard(old_hash)

        self._pending_changes.clear()
        return True

    @staticmethod
    def extract_array_region(vtk_object, array_path, start, count):
        if array_path == "points" and hasattr(vtk_object, "GetPoints"):
            pts = vtk_object.GetPoints()
            if pts:
                data = pts.GetData()
                if data:
                    arr = np.array(data)
                    n_components = 3
                    if count is None:
                        count = len(arr) - start
                    end = start + count
                    region = arr[start:end].flatten().astype(np.float32)
                    return region.tobytes(), "Float32Array", 4 * n_components

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
