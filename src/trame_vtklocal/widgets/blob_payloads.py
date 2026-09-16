"""Array-ref payload resolution for the scene publisher (push sync v2).

Maps the store's array-ref namespaces to wire bytes:

- ``c:<hash>`` — raw object-manager blob.
- ``c2:<connHash>:<offHash>`` — packed vtk.js Uint32 cell array derived from
  the two int64 blobs (per-cell ``size, ids...`` layout).
- ``v:<id>:<key>:<n>`` — versioned identity; content comes from the live VTK
  array selected by the publisher's hot-array resolver.

Plus the wslink attachment encoding for payloads riding a message.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import TYPE_CHECKING, Union

import numpy as np
from vtkmodules.util.numpy_support import vtk_to_numpy

from trame_vtklocal.module.node_arrays import registered_blob
from trame_vtklocal.store import (
    REF_CELLS_PREFIX,
    REF_CONTENT_PREFIX,
    REF_VERSION_PREFIX,
    ref_manager_hashes,
)

if TYPE_CHECKING:
    import numpy.typing as npt
    from vtkmodules.vtkSerializationManager import vtkObjectManager

    from trame_vtklocal.store import SceneNode
    from trame_vtklocal.wire import OpsMessage, ResyncPayload

    # A dataset array of any numeric VTK scalar type, viewed through numpy.
    NumericArray = npt.NDArray[np.generic]
    LiveHotArray = Callable[[str, str], Union[NumericArray, None]]


def numpy_array_from_vtk_data(data: object) -> NumericArray:
    if hasattr(data, "GetDataType"):
        try:
            array: NumericArray = vtk_to_numpy(data)
            return array
        except Exception:
            pass
    return np.asarray(data)


def pack_cell_array_payload(
    vtk_object_manager: vtkObjectManager, cells_ref: str
) -> bytes:
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


def resolve_ref_payload(
    object_manager: vtkObjectManager, ref: str, live_hot_array: LiveHotArray
) -> bytes:
    """Wire bytes for one array ref (``live_hot_array(node_id, key)`` -> flat
    numpy view or None, for ``v:`` refs)."""
    if ref.startswith(REF_CONTENT_PREFIX):
        blob = registered_blob(object_manager, ref[len(REF_CONTENT_PREFIX) :])
        if blob is None:
            raise RuntimeError(f"missing object-manager blob for {ref!r}")
        return bytes(memoryview(blob))
    if ref.startswith(REF_CELLS_PREFIX):
        return pack_cell_array_payload(object_manager, ref)
    if ref.startswith(REF_VERSION_PREFIX):
        node_id, remainder = ref[len(REF_VERSION_PREFIX) :].split(":", 1)
        key, _version = remainder.rsplit(":", 1)
        current = live_hot_array(node_id, key)
        if current is None:
            raise RuntimeError(f"cannot resolve {ref!r} from live objects")
        return current.tobytes()
    raise RuntimeError(f"unresolvable array ref {ref!r}")


def nodes_reference_missing_blob(
    object_manager: vtkObjectManager, nodes: Iterable[SceneNode]
) -> bool:
    """Whether non-empty content arrays cite a missing manager blob."""
    for node in nodes:
        for entry in (node.get("arrays") or {}).values():
            if not isinstance(entry, dict) or not entry.get("size"):
                continue
            ref = entry.get("ref")
            if ref and any(
                registered_blob(object_manager, hash_value) is None
                for hash_value in ref_manager_hashes([ref])
            ):
                return True
    return False


def attach_binary(api: object, message: OpsMessage | ResyncPayload) -> None:
    """Replace binary payloads in ``message`` with wslink attachments."""
    attach = getattr(api, "addAttachment", None)
    if attach is None:
        return
    if "ops" in message:
        for op in message["ops"]:
            if op["op"] == "patchArray":
                op["data"] = attach(memoryview(op["data"]))
    blobs = message.get("blobs")
    if blobs:
        for ref, payload in blobs.items():
            blobs[ref] = attach(memoryview(payload))
