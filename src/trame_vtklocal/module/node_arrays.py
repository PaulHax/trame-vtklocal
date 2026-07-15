"""Dataset array entries for the flat-node translator (push sync v2).

Builds the ``arrays`` section of a dataset node: polydata topology
(points/verts/lines/polys/strips) and field-data arrays, each carrying a blob
ref instead of content — ``c:<hash>`` for content-addressed blobs,
``c2:<connHash>:<offHash>`` for packed vtk.js cell arrays. Same bridging
knowledge as the v1 translator (md5 field-array blobs, cell packing shape),
new output shape.
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
    js_datatype,
    to_camel_case,
)
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


def _blob_present(object_manager, hash_value):
    try:
        blob = object_manager.GetBlob(hash_value)
    except (RuntimeError, TypeError, ValueError):
        return False
    if blob is None:
        return False
    try:
        return memoryview(blob).nbytes > 0
    except (TypeError, ValueError):
        return True


def _register_field_array_blob(object_manager, array, location):
    # vtkObjectManager doesn't serialize vtkDataSetAttributes arrays, so
    # bridge them by hand: md5-address the raw bytes and register the blob
    # under that hash (same gap-bridging as v1). Re-hashing + re-registering
    # every translate is O(bytes) per attribute array, so the entry is cached
    # by MTime; the blob's presence is re-checked on a hit because the blob
    # GC may have retired it while the owning node was out of the scene.
    cached = _FIELD_BLOB_CACHE.get(array)
    mtime = array.GetMTime()
    if cached is not None and cached[0] == mtime:
        entry = dict(cached[1])
        entry["location"] = location
        hash_value = entry["ref"][len(REF_CONTENT_PREFIX):]
        if _blob_present(object_manager, hash_value):
            return entry

    # ``np.array(vtkBitArray)`` exposes VTK's packed backing bytes instead of
    # its tuple values.  vtk.js receives an ordinary Uint8Array, so publish one
    # byte per bit rather than advertising a logical value count for a shorter
    # packed payload.  ``vtk_to_numpy`` correctly exposes all other numeric
    # VTK arrays without relying on the Python array protocol.
    if array.GetClassName() == "vtkBitArray":
        flat = np.fromiter(
            (array.GetValue(index) for index in range(array.GetNumberOfValues())),
            dtype=np.uint8,
            count=array.GetNumberOfValues(),
        )
    else:
        flat = vtk_to_numpy(array)
    flat = np.ascontiguousarray(flat).reshape(-1)
    raw_bytes = flat.view(np.uint8)
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
