"""Pure stateless helpers used by ``push_sync.py``.

Split out of ``push_sync.py`` so the module that owns the push-sync state
machine doesn't also have to hold the tree walkers, dtype maps, debug
plumbing, and payload packers. Nothing here touches PushSync state; every
function is data-in / data-out.
"""

from __future__ import annotations

import copy
import os
import time

import numpy as np

try:
    from vtkmodules.util.numpy_support import vtk_to_numpy
except ImportError:  # pragma: no cover - VTK is an optional dependency
    vtk_to_numpy = None


# ---------------------------------------------------------------------------
# Constants used only by the helpers below
# ---------------------------------------------------------------------------

MESSAGE_ENVELOPE_KEYS = {
    "version",
    "rwId",
    "kind",
    "epoch",
    "seq",
    "baseSeq",
    "extra",
}

# Array paths inside a translated object that participate in partial-array
# (mark_modified / flush) push sync. Used by both the helper that scans a
# state tree and by PushSync's mark_modified API.
PARTIAL_ARRAY_PATHS = {"points"}

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


# ---------------------------------------------------------------------------
# Debug-print plumbing (off unless TRAME_VTKLOCAL_PUSH_DEBUG is set)
# ---------------------------------------------------------------------------


def _debug_push_enabled():
    return bool(os.environ.get("TRAME_VTKLOCAL_PUSH_DEBUG"))


def _debug_push_event(event, **fields):
    if not _debug_push_enabled():
        return
    details = " ".join(f"{key}={value}" for key, value in fields.items())
    print(f"TRAME_VTKLOCAL_PUSH_DEBUG event={event} {details}", flush=True)


def _debug_ms(start):
    return f"{(time.perf_counter() - start) * 1000:.3f}"


# ---------------------------------------------------------------------------
# Payload-size accounting
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# State-tree walkers
# ---------------------------------------------------------------------------


def _object_manager_iid(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


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
                iid = _object_manager_iid(instance_id)
                if iid is None:
                    continue
                result[(iid, array_path)] = descriptor["hash"]

        deps = value.get("dependencies")
        if isinstance(deps, list):
            for dep in deps:
                visit_object(dep)

    visit_object(state)
    return result


def _state_for_ledger(value):
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


# ---------------------------------------------------------------------------
# VTK-side iteration helpers (used by dirty-tracking)
# ---------------------------------------------------------------------------


def _iter_via_getters(obj, names):
    """Yield each non-None result of calling obj.<name>() for each name."""
    if obj is None:
        return
    for getter in names:
        get = getattr(obj, getter, None)
        if get is None:
            continue
        result = get()
        if result is not None:
            yield result


def _iter_field_data_arrays(field_data):
    if field_data is None:
        return

    yield field_data

    try:
        count = field_data.GetNumberOfArrays()
    except AttributeError:
        count = 0
    for index in range(count):
        array = field_data.GetArray(index)
        if array is not None:
            yield array

    yield from _iter_via_getters(
        field_data, ("GetScalars", "GetTCoords", "GetNormals", "GetVectors")
    )


def _iter_cell_array_children(cell_array):
    if cell_array is None:
        return

    yield cell_array
    yield from _iter_via_getters(
        cell_array, ("GetData", "GetConnectivityArray", "GetOffsetsArray")
    )


def _iter_dataset_dirty_children(dataset):
    if dataset is None:
        return

    points = dataset.GetPoints() if hasattr(dataset, "GetPoints") else None
    if points is not None:
        yield points
        data = points.GetData() if hasattr(points, "GetData") else None
        if data is not None:
            yield data

    for cell_array in _iter_via_getters(
        dataset, ("GetVerts", "GetLines", "GetPolys", "GetStrips")
    ):
        yield from _iter_cell_array_children(cell_array)

    for field_data in _iter_via_getters(
        dataset, ("GetPointData", "GetCellData", "GetFieldData")
    ):
        yield from _iter_field_data_arrays(field_data)


# ---------------------------------------------------------------------------
# Numpy <-> JS typed-array bridging
# ---------------------------------------------------------------------------


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
