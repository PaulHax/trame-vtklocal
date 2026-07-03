"""Array-ref payload resolution for the scene publisher (push sync v2).

Maps the store's array-ref namespaces to wire bytes:

- ``c:<hash>`` — raw object-manager blob.
- ``c2:<connHash>:<offHash>`` — packed vtk.js Uint32 cell array derived from
  the two int64 blobs (per-cell ``size, ids...`` layout).
- ``v:<id>:<key>:<n>`` — versioned identity; content comes from the live VTK
  array (only hot points arrays receive region patches).

Plus the wslink attachment encoding for payloads riding a message.
"""

from __future__ import annotations

import numpy as np

from trame_vtklocal.store import (
    REF_CELLS_PREFIX,
    REF_CONTENT_PREFIX,
    REF_VERSION_PREFIX,
)
from trame_vtklocal.widgets.hot_arrays import HOT_ARRAY_KEY

try:
    from vtkmodules.util.numpy_support import vtk_to_numpy
except ImportError:  # pragma: no cover - VTK is an optional dependency
    vtk_to_numpy = None


def numpy_array_from_vtk_data(data):
    if vtk_to_numpy is not None and hasattr(data, "GetDataType"):
        try:
            return vtk_to_numpy(data)
        except Exception:
            pass
    return np.asarray(data)


def pack_cell_array_payload(vtk_object_manager, cells_ref):
    """Packed vtk.js Uint32 cell-array bytes for a ``c2:<conn>:<off>`` ref."""
    parts = cells_ref.split(":")
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


def resolve_ref_payload(object_manager, ref, live_hot_array):
    """Wire bytes for one array ref (``live_hot_array(node_id)`` -> flat
    numpy view or None, for ``v:`` refs)."""
    if ref.startswith(REF_CONTENT_PREFIX):
        blob = object_manager.GetBlob(ref[len(REF_CONTENT_PREFIX):])
        if blob is None:
            raise RuntimeError(f"missing object-manager blob for {ref!r}")
        return bytes(memoryview(blob))
    if ref.startswith(REF_CELLS_PREFIX):
        return pack_cell_array_payload(object_manager, ref)
    if ref.startswith(REF_VERSION_PREFIX):
        _prefix, node_id, key, _version = ref.split(":")
        if key != HOT_ARRAY_KEY:
            raise RuntimeError(f"unsupported versioned array ref {ref!r}")
        current = live_hot_array(node_id)
        if current is None:
            raise RuntimeError(f"cannot resolve {ref!r} from live objects")
        return current.tobytes()
    raise RuntimeError(f"unresolvable array ref {ref!r}")


def attach_binary(api, message):
    """Replace binary payloads in ``message`` with wslink attachments."""
    attach = getattr(api, "addAttachment", None)
    if attach is None:
        return
    for op in message.get("ops", ()):
        if op.get("op") == "patchArray":
            op["data"] = attach(memoryview(op["data"]))
    blobs = message.get("blobs")
    if blobs:
        for ref, payload in blobs.items():
            blobs[ref] = attach(memoryview(payload))
