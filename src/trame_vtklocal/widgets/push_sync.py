import copy
import json
import os
import time
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
PUSH_PROTOCOL_VERSION = 1
MESSAGE_ENVELOPE_KEYS = {
    "version",
    "rwId",
    "kind",
    "epoch",
    "seq",
    "baseSeq",
    "extra",
}
IGNORED_DELTA_CLASS_NAMES = {
    "vtkActorCollection",
    "vtkCellArray",
    "vtkCellData",
    "vtkCullerCollection",
    "vtkDoubleArray",
    "vtkFieldData",
    "vtkFloatArray",
    "vtkIdTypeArray",
    "vtkInformation",
    "vtkLightCollection",
    "vtkMatrix4x4",
    "vtkPoints",
    "vtkPointData",
    "vtkPropCollection",
    "vtkRendererCollection",
    "vtkTypeInt16Array",
    "vtkTypeInt32Array",
    "vtkTypeInt64Array",
    "vtkTypeInt8Array",
    "vtkTypeUInt16Array",
    "vtkTypeUInt32Array",
    "vtkTypeUInt64Array",
    "vtkTypeUInt8Array",
    "vtkUnsignedCharArray",
    "vtkUnsignedIntArray",
    "vtkUnsignedShortArray",
}
DATASET_PATCH_TYPES = {"vtkPolyData", "vtkImageData"}
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


def _debug_push_enabled():
    return bool(os.environ.get("TRAME_VTKLOCAL_PUSH_DEBUG"))


def _debug_push_event(event, **fields):
    if not _debug_push_enabled():
        return
    details = " ".join(f"{key}={value}" for key, value in fields.items())
    print(f"TRAME_VTKLOCAL_PUSH_DEBUG event={event} {details}", flush=True)


def _debug_ms(start):
    return f"{(time.perf_counter() - start) * 1000:.3f}"


def _payload_nbytes(value):
    if value is None:
        return 0
    if isinstance(value, memoryview):
        return value.nbytes
    if isinstance(value, bytes):
        return len(value)
    try:
        return memoryview(value).nbytes
    except TypeError:
        return 0


def _inline_payload_bytes(state):
    return sum(
        _payload_nbytes(descriptor.get("content"))
        for descriptor in _walk_descriptors(state)
    )


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


def _replace_objects_in_state(state, replacements):
    """Return one ledger copy with all matching object nodes replaced."""
    if not replacements:
        return state

    if isinstance(state, list):
        return [_replace_objects_in_state(item, replacements) for item in state]
    if not isinstance(state, dict):
        return copy.deepcopy(state)

    object_id = state.get("id")
    if object_id is not None:
        replacement = replacements.get(str(object_id))
        if replacement is not None:
            return _state_for_ledger(replacement)

    result = {}
    for key, value in state.items():
        if key == "dependencies" and isinstance(value, list):
            result[key] = [
                _replace_objects_in_state(item, replacements)
                for item in value
            ]
        else:
            result[key] = _state_for_ledger(value)
    return result


def _dependency_signature(obj):
    deps = obj.get("dependencies") or []
    return [(str(dep.get("id")), dep.get("type")) for dep in deps]


def _object_patch_signature(obj):
    return {
        "type": obj.get("type"),
        "calls": obj.get("calls") or [],
        "arrays": obj.get("arrays") or {},
        "dependencies": _dependency_signature(obj),
    }


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


class PartialArrayLedger:
    """Owns synthetic hashes created by explicit partial-array updates.

    Normal object-manager updates are authoritative. Synthetic `v:` hashes are
    only transport aliases for the low-latency partial path, and they are
    retired before translating any changed dataset through the normal path.
    """

    def __init__(self, rw_id):
        self._rw_id = int(rw_id)
        self._versions = {}
        self._current_hashes = {}

    @property
    def version_registry(self):
        return self._versions

    def clear(self):
        self._versions.clear()
        self._current_hashes.clear()

    def retire_all(self):
        self.clear()

    def retire_object(self, object_id):
        try:
            iid = int(object_id)
        except (TypeError, ValueError):
            return

        for array_path in PARTIAL_ARRAY_PATHS:
            key = (self._rw_id, iid, array_path)
            self._versions.pop(key, None)
            self._current_hashes.pop(key, None)

    def reconcile_state(self, state):
        live = _collect_hashes(state)
        self._prune_to_live(live)
        self._capture_state_hashes(state)
        return live

    def reserve_partial_versions(self, pending_changes):
        bumped = {}
        for _vtk, iid, array_path, *_ in pending_changes:
            key = (self._rw_id, int(iid), array_path)
            if key in bumped:
                continue

            self._versions[key] = self._versions.get(key, 0) + 1
            old_hash = self._current_hashes.get(key)
            new_hash = self._synthetic_hash(iid, array_path, self._versions[key])
            self._current_hashes[key] = new_hash
            bumped[key] = (old_hash, new_hash)
        return bumped

    def resolve_payload(self, hash_val, descriptor, object_manager):
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

        obj = object_manager.GetObjectAtId(iid)
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

    def _synthetic_hash(self, iid, array_path, version):
        return f"{SYNTHETIC_VERSION_PREFIX}{self._rw_id}:{iid}:{array_path}:{version}"

    def _prune_to_live(self, live):
        dead_keys = []
        for key, version in self._versions.items():
            _rw_id, iid, array_path = key
            if self._synthetic_hash(iid, array_path, version) not in live:
                dead_keys.append(key)
        for key in dead_keys:
            self._versions.pop(key, None)
            self._current_hashes.pop(key, None)

    def _capture_state_hashes(self, state):
        for (iid, array_path), hash_val in _collect_partial_array_hashes(state).items():
            self._current_hashes[(self._rw_id, iid, array_path)] = hash_val


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
        self._partial_arrays = PartialArrayLedger(self._rw_id_int)

        # per-(client_id) set of hashes that client currently has cached
        self._known_hashes = {}
        # clients that have completed at least one resync for this view
        self._view_clients = set()
        # per-client collection trackers used by vtkjs_translator
        self._collection_trackers = {}
        # Authoritative render-window sequence and per-client stream cursors.
        self._sequence = 0
        self._client_epochs = {}
        self._client_sequences = {}
        self._client_states = {}
        self._client_statuses = {}
        self._object_class_names = {}

        if api is not None:
            api.register_push_view(self._rw_id_int, self)

    def cleanup(self):
        if self._api is not None:
            self._api.unregister_push_view(self._rw_id_int)
        self._api = None
        self._known_hashes.clear()
        self._view_clients.clear()
        self._collection_trackers.clear()
        self._partial_arrays.clear()
        self._client_epochs.clear()
        self._client_sequences.clear()
        self._client_states.clear()
        self._client_statuses.clear()
        self._object_class_names.clear()

    def drop_client(self, client_id):
        self._view_clients.discard(client_id)
        self._known_hashes.pop(client_id, None)
        self._collection_trackers.pop(client_id, None)
        self._client_epochs.pop(client_id, None)
        self._client_sequences.pop(client_id, None)
        self._client_states.pop(client_id, None)
        self._client_statuses.pop(client_id, None)

    # ------------------------------------------------------------------
    # Payload resolution
    # ------------------------------------------------------------------

    def _resolve_version_payload(self, hash_val, descriptor=None):
        """Resolve a synthetic `v:{rw_id}:{iid}:{path}:{version}` hash."""
        return self._partial_arrays.resolve_payload(
            hash_val, descriptor, self._api.vtk_object_manager
        )

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

    # ------------------------------------------------------------------
    # Publish helpers
    # ------------------------------------------------------------------

    def _next_sequence(self):
        self._sequence += 1
        return self._sequence

    def _get_client_epoch(self, client_id):
        return self._client_epochs.get(client_id, 0)

    def _annotate_full_state(self, state, client_id, seq):
        state["version"] = PUSH_PROTOCOL_VERSION
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
        return self._get_vtkjs_state(self._partial_arrays.version_registry, tracker)

    def _object_manager(self):
        if self._api is None:
            return None
        return getattr(self._api, "vtk_object_manager", None)

    def _can_build_object_delta(self):
        object_manager = self._object_manager()
        return (
            object_manager is not None
            and hasattr(object_manager, "UpdateStatesFromObjects")
            and hasattr(object_manager, "GetAllDependencies")
            and hasattr(object_manager, "GetBlobHashes")
            and hasattr(object_manager, "GetState")
            and hasattr(object_manager, "GetObjectAtId")
        )

    def _require_object_delta(self):
        if not self._can_build_object_delta():
            raise RuntimeError(
                "Push sync requires vtkObjectManager object-id delta support"
            )
        return self._object_manager()

    def _refresh_object_manager_state(self):
        object_manager = self._require_object_delta()

        render_window = object_manager.GetObjectAtId(self._rw_id_int)
        if render_window is not None and hasattr(render_window, "Render"):
            render_window.Render()

        try:
            object_manager.UpdateStatesFromObjects([self._rw_id_int])
        except TypeError as exc:
            raise RuntimeError(
                "Push sync requires vtkObjectManager.UpdateStatesFromObjects(ids)"
            ) from exc

    def _snapshot_status(self):
        object_manager = self._object_manager()
        if object_manager is None:
            return None

        ids = list(object_manager.GetAllDependencies(self._rw_id_int))
        live_ids = {str(vtk_id) for vtk_id in ids}
        self._object_class_names = {
            object_id: class_name
            for object_id, class_name in self._object_class_names.items()
            if object_id in live_ids
        }
        mtimes = {}
        classes = {}
        for vtk_id in ids:
            object_id = str(vtk_id)
            vtk_obj = object_manager.GetObjectAtId(vtk_id)
            if vtk_obj is not None and hasattr(vtk_obj, "GetMTime"):
                mtimes[object_id] = vtk_obj.GetMTime()
            class_name = self._object_class_names.get(object_id)
            if class_name is None:
                class_name = self._get_state_class_name(vtk_id)
                if class_name:
                    self._object_class_names[object_id] = class_name
            if class_name:
                classes[object_id] = class_name

        return {
            "ids": live_ids,
            "mtimes": mtimes,
            "classes": classes,
            "hashes": set(object_manager.GetBlobHashes(ids)),
        }

    def _get_state_class_name(self, object_id):
        object_manager = self._object_manager()
        if object_manager is None:
            return ""
        try:
            state_json = object_manager.GetState(int(object_id))
        except (TypeError, ValueError, RuntimeError):
            return ""
        if not state_json:
            return ""
        try:
            return json.loads(state_json).get("ClassName", "")
        except (TypeError, ValueError):
            return ""

    @staticmethod
    def _is_ignored_delta_class(class_name):
        return (
            class_name in IGNORED_DELTA_CLASS_NAMES
            or "Array" in class_name
            or class_name.endswith("Collection")
        )

    def _translate_object_state(self, object_id):
        from trame_vtklocal.module.vtkjs_translator import translate_object

        return translate_object(
            self._object_manager(),
            int(object_id),
            version_registry=self._partial_arrays.version_registry,
            rw_id=self._rw_id_int,
        )

    def _publish_client_state(
        self,
        client_id,
        state,
        seq=None,
        debug_source="update",
        translate_ms=None,
        status=None,
        fallback_reason=None,
    ):
        if not self._server.protocol:
            return
        debug = _debug_push_enabled()
        total_start = time.perf_counter() if debug else None

        if seq is None:
            seq = self._sequence

        live = self._partial_arrays.reconcile_state(state)
        known = self._known_hashes.get(client_id, set())
        missing = set(live)

        client_state = copy.deepcopy(state)
        self._annotate_full_state(client_state, client_id, seq)
        inline_start = time.perf_counter() if debug else None
        inlined = self._inline_payloads(client_state, missing)
        inline_ms = _debug_ms(inline_start) if debug else None
        inline_bytes = _inline_payload_bytes(client_state) if debug else 0
        convert_start = time.perf_counter() if debug else None
        self._convert_attachments(client_state)
        convert_ms = _debug_ms(convert_start) if debug else None

        publish_start = time.perf_counter() if debug else None
        self._server.protocol.publish(
            "trame.vtk.delta", client_state, client_id=client_id
        )
        publish_ms = _debug_ms(publish_start) if debug else None
        self._known_hashes[client_id] = set(inlined)
        self._client_sequences[client_id] = seq
        self._client_states[client_id] = _state_for_ledger(client_state)
        if status is not None:
            self._client_statuses[client_id] = copy.deepcopy(status)
        elif self._can_build_object_delta():
            snapshot = self._snapshot_status()
            if snapshot is not None:
                self._client_statuses[client_id] = snapshot
        if debug:
            _debug_push_event(
                "full_publish",
                source=debug_source,
                rw=self._render_window_id,
                client=client_id,
                epoch=self._get_client_epoch(client_id),
                seq=seq,
                live=len(live),
                known=len(known),
                missing=len(missing),
                inlined=len(inlined),
                inline_bytes=inline_bytes,
                self_contained=1,
                fallback_reason=fallback_reason or "",
                translate_ms=translate_ms if translate_ms is not None else "",
                inline_ms=inline_ms,
                convert_ms=convert_ms,
                publish_ms=publish_ms,
                total_ms=_debug_ms(total_start),
            )

    def _build_object_delta_patch(self, client_id, status, base_seq, seq, extra=None):
        previous_status = self._client_statuses.get(client_id)
        previous_state = self._client_states.get(client_id)
        if previous_status is None or previous_state is None:
            return None, None, "missing-client-ledger", None

        previous_ids = previous_status.get("ids") or set()
        current_ids = status.get("ids") or set()
        added_ids = current_ids - previous_ids
        removed_ids = previous_ids - current_ids
        structural_id_changes = []
        for object_id in added_ids:
            class_name = (status.get("classes") or {}).get(object_id, "")
            if not self._is_ignored_delta_class(class_name):
                structural_id_changes.append(f"+{object_id}:{class_name or 'unknown'}")
        for object_id in removed_ids:
            class_name = (previous_status.get("classes") or {}).get(object_id, "")
            if not self._is_ignored_delta_class(class_name):
                structural_id_changes.append(f"-{object_id}:{class_name or 'unknown'}")
        if structural_id_changes:
            return (
                None,
                None,
                f"dependency-id-set-changed:{','.join(structural_id_changes[:5])}",
                None,
            )

        previous_objects = _flatten_state_objects(previous_state)
        changed_ids = {
            object_id
            for object_id, mtime in (status.get("mtimes") or {}).items()
            if mtime != (previous_status.get("mtimes") or {}).get(object_id)
        }

        candidate_ids = {
            object_id for object_id in changed_ids if object_id in previous_objects
        }

        if (status.get("hashes") or set()) != (previous_status.get("hashes") or set()):
            candidate_ids.update(
                object_id
                for object_id, obj in previous_objects.items()
                if obj.get("type") in DATASET_PATCH_TYPES
            )

        unsupported_changed = []
        for object_id in changed_ids - set(previous_objects):
            class_name = (status.get("classes") or {}).get(object_id, "")
            if self._is_ignored_delta_class(class_name):
                continue
            unsupported_changed.append(f"{object_id}:{class_name or 'unknown'}")
        if unsupported_changed and not candidate_ids:
            return (
                None,
                None,
                f"unsupported-changed-ids:{','.join(unsupported_changed[:5])}",
                None,
            )

        ops = []
        replacements = {}
        translate_start = time.perf_counter()

        for object_id in sorted(candidate_ids, key=lambda value: int(value)):
            previous_obj = previous_objects.get(object_id)
            if previous_obj is None:
                continue

            if previous_obj.get("type") in DATASET_PATCH_TYPES:
                self._partial_arrays.retire_object(object_id)

            current_obj = self._translate_object_state(object_id)
            if current_obj is None:
                return None, None, f"unsupported-object:{object_id}", None

            current_obj = _state_for_ledger(current_obj)
            if current_obj == previous_obj:
                continue

            if _object_patch_signature(previous_obj) != _object_patch_signature(
                current_obj
            ):
                return None, None, f"structural-object-change:{object_id}", None

            previous_props = previous_obj.get("properties") or {}
            current_props = current_obj.get("properties") or {}
            if not isinstance(previous_props, Mapping) or not isinstance(
                current_props, Mapping
            ):
                return None, None, f"unsupported-properties:{object_id}", None

            removed_keys = set(previous_props) - set(current_props)
            if removed_keys:
                return None, None, f"removed-properties:{object_id}", None

            changed_props = {
                key: copy.deepcopy(value)
                for key, value in current_props.items()
                if previous_props.get(key) != value
            }

            if not changed_props:
                replacements[object_id] = current_obj
                continue

            if any(
                _contains_array_descriptor(previous_props.get(key))
                or _contains_array_descriptor(value)
                for key, value in changed_props.items()
            ):
                ops.append(
                    {
                        "op": "updateObject",
                        "id": object_id,
                        "state": copy.deepcopy(current_obj),
                    }
                )
            else:
                ops.append(
                    {
                        "op": "setProperties",
                        "id": object_id,
                        "properties": changed_props,
                    }
                )

            replacements[object_id] = current_obj

        translate_ms = f"{(time.perf_counter() - translate_start) * 1000:.3f}"
        ledger_state = _replace_objects_in_state(previous_state, replacements)

        if not ops and extra is None:
            return None, None, "no-op", translate_ms

        payload = {
            "version": PUSH_PROTOCOL_VERSION,
            "rwId": self._render_window_id,
            "kind": "patch",
            "epoch": self._get_client_epoch(client_id),
            "baseSeq": base_seq,
            "seq": seq,
            "ops": ops,
        }
        if extra is not None:
            payload["extra"] = extra
        return payload, ledger_state, None, translate_ms

    def _publish_patch(
        self,
        client_id,
        payload,
        ledger_state,
        translate_ms=None,
        status=None,
    ):
        debug = _debug_push_enabled()
        total_start = time.perf_counter() if debug else None
        live = _collect_hashes(ledger_state)
        patch_hashes = _collect_hashes(payload)
        known = self._known_hashes.get(client_id, set())
        missing = patch_hashes - known
        inline_start = time.perf_counter() if debug else None
        inlined = self._inline_payloads(payload, missing)
        inline_ms = _debug_ms(inline_start) if debug else None
        inline_bytes = _inline_payload_bytes(payload) if debug else 0
        convert_start = time.perf_counter() if debug else None
        self._convert_attachments(payload)
        convert_ms = _debug_ms(convert_start) if debug else None
        publish_start = time.perf_counter() if debug else None
        self._server.protocol.publish("trame.vtk.patch", payload, client_id=client_id)
        publish_ms = _debug_ms(publish_start) if debug else None
        self._known_hashes[client_id] = (known & live) | inlined
        self._client_sequences[client_id] = payload["seq"]
        self._client_states[client_id] = ledger_state
        self._partial_arrays.reconcile_state(ledger_state)
        if status is not None:
            self._client_statuses[client_id] = copy.deepcopy(status)
        if debug:
            _debug_push_event(
                "patch_publish",
                rw=self._render_window_id,
                client=client_id,
                epoch=payload.get("epoch"),
                base_seq=payload.get("baseSeq"),
                seq=payload.get("seq"),
                ops=len(payload.get("ops") or []),
                live=len(live),
                known=len(known),
                missing=len(missing),
                inlined=len(inlined),
                inline_bytes=inline_bytes,
                translate_ms=translate_ms if translate_ms is not None else "",
                inline_ms=inline_ms,
                convert_ms=convert_ms,
                publish_ms=publish_ms,
                total_ms=_debug_ms(total_start),
            )

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
        debug = _debug_push_enabled()
        total_start = time.perf_counter() if debug else None
        if client_id is not None:
            self._client_epochs[client_id] = self._client_epochs.get(client_id, 0) + 1

        translate_start = time.perf_counter() if debug else None
        self._partial_arrays.retire_all()
        state = self._get_client_state(client_id, reset_tracker=True)
        translate_ms = _debug_ms(translate_start) if debug else None
        live = self._partial_arrays.reconcile_state(state)
        self._annotate_full_state(state, client_id, self._sequence)

        inline_start = time.perf_counter() if debug else None
        inlined = self._inline_payloads(state, live)
        inline_ms = _debug_ms(inline_start) if debug else None
        inline_bytes = _inline_payload_bytes(state) if debug else 0
        convert_start = time.perf_counter() if debug else None
        self._convert_attachments(state)
        convert_ms = _debug_ms(convert_start) if debug else None

        if client_id is not None:
            self._known_hashes[client_id] = set(inlined)
            self._view_clients.add(client_id)
            self._client_sequences[client_id] = self._sequence
            self._client_states[client_id] = _state_for_ledger(state)
            if self._can_build_object_delta():
                snapshot = self._snapshot_status()
                if snapshot is not None:
                    self._client_statuses[client_id] = snapshot
        if debug:
            _debug_push_event(
                "client_resync",
                rw=self._render_window_id,
                client=client_id,
                epoch=self._get_client_epoch(client_id),
                seq=self._sequence,
                live=len(live),
                inlined=len(inlined),
                inline_bytes=inline_bytes,
                translate_ms=translate_ms,
                inline_ms=inline_ms,
                convert_ms=convert_ms,
                total_ms=_debug_ms(total_start),
            )
        return state

    def request_resync(self, extra=None):
        """Server-initiated full resync for every tracked client."""
        self._pending_changes.clear()

        if not self._server.protocol or not self._view_clients:
            return

        seq = self._next_sequence()

        self._partial_arrays.retire_all()
        # Translation is per-client because collection membership tracking is
        # per-client. Revisit if many subscribers make that cost material.
        for sid in list(self._view_clients):
            debug = _debug_push_enabled()
            translate_start = time.perf_counter() if debug else None
            state = self._get_client_state(sid, reset_tracker=True)
            translate_ms = _debug_ms(translate_start) if debug else None
            if extra:
                state.setdefault("extra", {}).update(extra)

            self._partial_arrays.reconcile_state(state)
            self._known_hashes[sid] = set()
            self._publish_client_state(
                sid,
                state,
                seq=seq,
                debug_source="server_request_resync",
                translate_ms=translate_ms,
            )

    def update(self, extra=None):
        if self._pending_changes:
            raise RuntimeError(
                "Pending partial array changes must be published with flush() "
                "before calling update()"
            )

        if not self._server.protocol or not self._view_clients:
            return

        self._require_object_delta()

        self._refresh_object_manager_state()
        status = self._snapshot_status()
        if status is None:
            raise RuntimeError("Push sync could not snapshot vtkObjectManager status")

        base_seq = self._sequence
        seq = base_seq + 1
        results = []
        any_publish = False

        for sid in list(self._view_clients):
            if self._client_sequences.get(sid, 0) != base_seq:
                results.append(("full", sid, "sequence-mismatch", None, None))
                any_publish = True
                continue

            patch, ledger_state, fallback_reason, translate_ms = (
                self._build_object_delta_patch(sid, status, base_seq, seq, extra=extra)
            )
            if fallback_reason == "no-op":
                results.append(("noop", sid, fallback_reason, None, translate_ms))
                continue
            if fallback_reason is not None:
                results.append(("full", sid, fallback_reason, None, translate_ms))
                any_publish = True
                continue
            results.append(("patch", sid, None, (patch, ledger_state), translate_ms))
            any_publish = True

        if not any_publish:
            return

        self._sequence = seq
        for result_type, sid, reason, payload_data, translate_ms in results:
            if result_type == "noop":
                continue
            if result_type == "patch":
                patch, ledger_state = payload_data
                self._publish_patch(
                    sid,
                    patch,
                    ledger_state,
                    translate_ms=translate_ms,
                    status=status,
                )
                continue

            debug = _debug_push_enabled()
            translate_start = time.perf_counter() if debug else None
            self._partial_arrays.retire_all()
            state = self._get_client_state(sid)
            full_translate_ms = _debug_ms(translate_start) if debug else None
            if extra:
                state.setdefault("extra", {}).update(extra)

            self._partial_arrays.reconcile_state(state)
            full_status = self._snapshot_status() or status
            self._publish_client_state(
                sid,
                state,
                seq=seq,
                debug_source="update_fallback",
                translate_ms=full_translate_ms or translate_ms,
                status=full_status,
                fallback_reason=reason,
            )

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

        for _vtk, _iid, array_path, *_ in self._pending_changes:
            if array_path not in PARTIAL_ARRAY_PATHS:
                raise ValueError(
                    f"Partial array path {array_path!r} is not supported; "
                    f"supported paths are {sorted(PARTIAL_ARRAY_PATHS)!r}"
                )

        base_seq = self._sequence
        seq = self._next_sequence()
        bumped = self._partial_arrays.reserve_partial_versions(self._pending_changes)

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

            # Points partials are flat xyz tuples.
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
                debug = _debug_push_enabled()
                translate_start = time.perf_counter() if debug else None
                self._partial_arrays.retire_all()
                state = self._get_client_state(sid, reset_tracker=True)
                translate_ms = _debug_ms(translate_start) if debug else None
                if extra:
                    state.setdefault("extra", {}).update(extra)
                self._partial_arrays.reconcile_state(state)
                self._known_hashes[sid] = set()
                self._publish_client_state(
                    sid,
                    state,
                    seq=seq,
                    debug_source="flush_sequence_fallback",
                    translate_ms=translate_ms,
                )
                continue

            debug = _debug_push_enabled()
            total_start = time.perf_counter() if debug else None
            data_bytes = sum(_payload_nbytes(update.get("data")) for update in updates)
            payload = {
                "version": PUSH_PROTOCOL_VERSION,
                "rwId": self._render_window_id,
                "kind": "arrayPartial",
                "epoch": self._get_client_epoch(sid),
                "baseSeq": base_seq,
                "seq": seq,
                "updates": copy.deepcopy(updates),
            }
            if extra is not None:
                payload["extra"] = extra

            convert_start = time.perf_counter() if debug else None
            self._convert_attachments(payload)
            convert_ms = _debug_ms(convert_start) if debug else None
            publish_start = time.perf_counter() if debug else None
            self._server.protocol.publish(
                "trame.vtk.array.partial", payload, client_id=sid
            )
            publish_ms = _debug_ms(publish_start) if debug else None

            client_known = self._known_hashes.setdefault(sid, set())
            for update in updates:
                old_hash = update.get("oldHash")
                if old_hash is not None:
                    client_known.discard(old_hash)
                client_known.add(update["newHash"])
            self._client_sequences[sid] = seq
            self._advance_client_ledger_for_partials(sid, updates)
            if debug:
                _debug_push_event(
                    "partial_publish",
                    rw=self._render_window_id,
                    client=sid,
                    epoch=self._get_client_epoch(sid),
                    base_seq=base_seq,
                    seq=seq,
                    updates=len(updates),
                    data_bytes=data_bytes,
                    convert_ms=convert_ms,
                    publish_ms=publish_ms,
                    total_ms=_debug_ms(total_start),
                )

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

        return None, None, None
