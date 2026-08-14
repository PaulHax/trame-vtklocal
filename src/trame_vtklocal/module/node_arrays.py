"""Dataset array entries for the flat-node translator.

Builds the ``arrays`` section of a dataset node: polydata topology
(points/verts/lines/polys/strips) and field-data arrays, each carrying a blob
ref instead of content — ``c:<hash>`` for content-addressed blobs,
``c2:<connHash>:<offHash>`` for packed vtk.js cell arrays.
"""

from __future__ import annotations

import hashlib
import weakref

import numpy as np
from vtkmodules.util.numpy_support import numpy_to_vtk, vtk_to_numpy

from trame_vtklocal.module.vtkjs_translator import (
    ATTRIBUTE_REGISTRATIONS,
    FIELD_DATA_GETTERS,
    POLYDATA_ARRAYS,
    get_ref_id,
    to_camel_case,
)
from trame_vtklocal.module.array_datatypes import js_datatype
from trame_vtklocal.store import REF_CELLS_PREFIX, REF_CONTENT_PREFIX


def _data_array_entry(data_state):
    hash_value = data_state.get("Hash")
    if not hash_value:
        return None

    js_type = js_datatype(
        data_state.get("ClassName", ""),
        data_state.get("DataType"),
        missing_default="Float32Array",
    )
    components = data_state.get("NumberOfComponents", 1)
    entry = {
        "ref": REF_CONTENT_PREFIX + hash_value,
        "dataType": js_type,
        "size": data_state.get("NumberOfTuples", 0) * components,
        "numberOfComponents": components,
    }
    name = data_state.get("Name") or ""
    if name:
        entry["name"] = name
    return entry


def _cell_array_entry(reader, container_state):
    number_of_cells = container_state.get("NumberOfCells", 0)
    if number_of_cells <= 0:
        return None
    connectivity_id = get_ref_id(container_state.get("Connectivity"))
    offsets_id = get_ref_id(container_state.get("Offsets"))
    if not connectivity_id or not offsets_id:
        return None
    connectivity_state = reader.state(connectivity_id)
    connectivity_hash = connectivity_state.get("Hash")
    offsets_hash = reader.state(offsets_id).get("Hash")
    if not connectivity_hash or not offsets_hash:
        return None
    return {
        # The publisher derives the packed vtk.js single-array Uint32 layout
        # (cell size followed by point ids, per cell) from these two blobs.
        "ref": f"{REF_CELLS_PREFIX}{connectivity_hash}:{offsets_hash}",
        "dataType": "Uint32Array",
        "size": connectivity_state.get("NumberOfTuples", 0) + number_of_cells,
        "numberOfComponents": 1,
    }


def _topology_entry(reader, ref_value, spec):
    ref_id = get_ref_id(ref_value)
    if not ref_id:
        return None
    container_state = reader.state(ref_id)
    container_class = container_state.get("ClassName", "")
    if container_class == "vtkPoints":
        data_id = get_ref_id(container_state.get("Data"))
        entry = _data_array_entry(reader.state(data_id)) if data_id else None
    elif container_class == "vtkCellArray":
        entry = _cell_array_entry(reader, container_state)
    else:
        entry = None
    if entry:
        entry["registration"] = spec["registration"]
        entry["vtkClass"] = spec["vtkClass"]
    return entry


# array -> (mtime, entry). MTime covers content and name; a changed array
# always lands on a new MTime, so a hit means the md5 and the registered
# blob are both still valid for these bytes.
_FIELD_BLOB_CACHE = weakref.WeakKeyDictionary()


def registered_blob(object_manager, hash_value):
    """The blob registered at ``hash_value``, or None when it is missing.

    VTK >= 9.6 answers an unknown hash with an empty array instead of None,
    so emptiness -- not identity -- is the liveness test.
    """
    try:
        blob = object_manager.GetBlob(hash_value)
    except (RuntimeError, TypeError, ValueError):
        return None
    if blob is None:
        return None
    try:
        return blob if memoryview(blob).nbytes else None
    except (TypeError, ValueError):
        return blob


def _flat_array_bytes(array):
    """Return one VTK data array's logical values as contiguous bytes."""
    if array.GetClassName() == "vtkBitArray":
        flat = np.fromiter(
            (array.GetValue(index) for index in range(array.GetNumberOfValues())),
            dtype=np.uint8,
            count=array.GetNumberOfValues(),
        )
    else:
        flat = vtk_to_numpy(array)
    return np.ascontiguousarray(flat).reshape(-1).view(np.uint8)


def _live_arrays_for_key(dataset, key):
    if key == "points":
        points = dataset.GetPoints() if hasattr(dataset, "GetPoints") else None
        data = points.GetData() if points is not None else None
        return [] if data is None else [data]

    cell_getter = {
        "verts": "GetVerts",
        "lines": "GetLines",
        "polys": "GetPolys",
        "strips": "GetStrips",
    }.get(key)
    if cell_getter is not None:
        cells = getattr(dataset, cell_getter, lambda: None)()
        if cells is None:
            return []
        connectivity = cells.GetConnectivityArray()
        offsets = cells.GetOffsetsArray()
        return (
            [] if connectivity is None or offsets is None else [connectivity, offsets]
        )

    if not key.startswith("field:"):
        return []
    _prefix, location, name = key.split(":", 2)
    field_getter = {
        "pointData": "GetPointData",
        "cellData": "GetCellData",
        "fieldData": "GetFieldData",
    }.get(location)
    if field_getter is None:
        return []
    field_data = getattr(dataset, field_getter, lambda: None)()
    array = field_data.GetArray(name) if field_data is not None else None
    return [] if array is None else [array]


def restore_dataset_blobs(object_manager, node_id, node):
    """Re-register missing blobs for one translated live dataset node.

    VTK 9.6.2 can retain a cached array state after ``UnRegisterBlob`` without
    restoring that state's payload during a render-window reserialization.
    The translated node still names the correct hashes, so bridge the live VTK
    arrays back into the object manager under those hashes.
    """
    dataset = object_manager.GetObjectAtId(int(node_id))
    if dataset is None:
        return set()

    restored = set()
    for key, entry in (node.get("arrays") or {}).items():
        ref = entry.get("ref") if isinstance(entry, dict) else None
        if not ref:
            continue
        if ref.startswith(REF_CONTENT_PREFIX):
            hashes = [ref[len(REF_CONTENT_PREFIX) :]]
        elif ref.startswith(REF_CELLS_PREFIX):
            hashes = ref[len(REF_CELLS_PREFIX) :].split(":", 1)
        else:
            continue

        arrays = _live_arrays_for_key(dataset, key)
        if len(arrays) != len(hashes):
            continue
        for hash_value, array in zip(hashes, arrays):
            if registered_blob(object_manager, hash_value) is not None:
                continue
            raw_bytes = _flat_array_bytes(array)
            if raw_bytes.nbytes == 0:
                continue
            object_manager.RegisterBlob(hash_value, numpy_to_vtk(raw_bytes, deep=True))
            restored.add(hash_value)
    return restored


def _register_field_array_blob(object_manager, array, location):
    # vtkObjectManager doesn't serialize vtkDataSetAttributes arrays, so
    # bridge them by hand: md5-address the raw bytes and register the blob
    # under that hash. Re-hashing + re-registering
    # every translate is O(bytes) per attribute array, so the entry is cached
    # by MTime; the blob's presence is re-checked on a hit because the blob
    # GC may have retired it while the owning node was out of the scene.
    cached = _FIELD_BLOB_CACHE.get(array)
    mtime = array.GetMTime()
    if cached is not None and cached[0] == mtime:
        entry = dict(cached[1])
        entry["location"] = location
        hash_value = entry["ref"][len(REF_CONTENT_PREFIX):]
        if registered_blob(object_manager, hash_value) is not None:
            return entry

    # ``np.array(vtkBitArray)`` exposes VTK's packed backing bytes instead of
    # its tuple values.  vtk.js receives an ordinary Uint8Array, so publish one
    # byte per bit rather than advertising a logical value count for a shorter
    # packed payload.  ``vtk_to_numpy`` correctly exposes all other numeric
    # VTK arrays without relying on the Python array protocol.
    raw_bytes = _flat_array_bytes(array)
    content_hash = hashlib.md5(raw_bytes).hexdigest()
    # RegisterBlob requires a vtkTypeUInt8Array (= vtkUnsignedCharArray).
    object_manager.RegisterBlob(content_hash, numpy_to_vtk(raw_bytes, deep=True))

    components = array.GetNumberOfComponents()
    entry = {
        "ref": REF_CONTENT_PREFIX + content_hash,
        "dataType": js_datatype(array.GetClassName(), array.GetDataType()),
        "size": array.GetNumberOfTuples() * components,
        "numberOfComponents": components,
        "name": array.GetName() or "",
        "location": location,
    }
    # Cache a private copy: callers stamp "registration" onto the returned
    # entry, which must not leak into the cache.
    _FIELD_BLOB_CACHE[array] = (mtime, dict(entry))
    return entry


def _field_data_arrays(reader, dataset_id):
    vtk_dataset = reader.vtk_object(dataset_id)
    if vtk_dataset is None:
        return {}

    arrays = {}
    for field_key, getter_name in FIELD_DATA_GETTERS.items():
        getter = getattr(vtk_dataset, getter_name, None)
        field_data = getter() if getter is not None else None
        if not field_data or field_data.GetNumberOfArrays() == 0:
            continue

        location = to_camel_case(field_key)
        attribute_registrations = {}
        for vtk_attribute, registration in ATTRIBUTE_REGISTRATIONS.items():
            get_attribute = getattr(field_data, f"Get{vtk_attribute}", None)
            attribute_array = get_attribute() if get_attribute is not None else None
            if attribute_array is not None:
                attribute_registrations[attribute_array.GetName()] = registration

        for index in range(field_data.GetNumberOfArrays()):
            array = field_data.GetArray(index)
            if array is None or array.GetNumberOfTuples() == 0:
                continue
            entry = _register_field_array_blob(
                reader.object_manager, array, location
            )
            registration = attribute_registrations.get(entry["name"])
            if registration:
                entry["registration"] = registration
            arrays[f"field:{location}:{entry['name']}"] = entry
    return arrays


def polydata_array_entries(reader, state):
    """The full ``arrays`` section for a polydata node."""
    arrays = {}
    for state_key, spec in POLYDATA_ARRAYS.items():
        entry = _topology_entry(reader, state.get(state_key), spec)
        if entry:
            arrays[state_key.lower()] = entry
    arrays.update(_field_data_arrays(reader, state["Id"]))
    return arrays
