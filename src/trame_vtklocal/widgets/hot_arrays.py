"""Retained-copy region differ for publisher-configured hot arrays."""

from __future__ import annotations

import numpy as np

from trame_vtklocal.widgets.blob_payloads import numpy_array_from_vtk_data

HOT_ARRAY_KEY = "points"
DEFAULT_HOT_ARRAY_KEYS = frozenset({HOT_ARRAY_KEY})
RETENTION_CAP_BYTES = 64 * 1024 * 1024
DEFAULT_MAX_SPANS = 8
DEFAULT_GAP_ELEMENTS = 3

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


def live_dataset_array(object_manager, node_id, key):
    """Flat numpy view for a supported dataset array key, or ``None``."""
    vtk_object = object_manager.GetObjectAtId(int(node_id))
    if vtk_object is None:
        return None
    if key == HOT_ARRAY_KEY:
        points = vtk_object.GetPoints() if hasattr(vtk_object, "GetPoints") else None
        data = points.GetData() if points is not None else None
    elif key.startswith("field:pointData:"):
        name = key.split(":", 2)[2]
        point_data = (
            vtk_object.GetPointData() if hasattr(vtk_object, "GetPointData") else None
        )
        data = point_data.GetArray(name) if point_data is not None else None
    else:
        data = None
    if data is None:
        return None
    return np.asarray(numpy_array_from_vtk_data(data)).reshape(-1)


def _changed_spans(changed, gap_elements):
    """Inclusive changed-index groups separated by more than ``gap_elements``."""
    if changed.size == 0:
        return []
    spans = []
    first = previous = int(changed[0])
    for value in changed[1:]:
        current = int(value)
        if current - previous > gap_elements:
            spans.append((first, previous - first + 1))
            first = current
        previous = current
    spans.append((first, previous - first + 1))
    return spans


class HotArrayDiffer:
    """Turn small edits to selected dataset arrays into ``patchArray`` ops."""

    def __init__(
        self,
        live_array_getter,
        hot_keys=DEFAULT_HOT_ARRAY_KEYS,
        cap_bytes=RETENTION_CAP_BYTES,
        max_spans=DEFAULT_MAX_SPANS,
        gap_elements=DEFAULT_GAP_ELEMENTS,
    ):
        self._live_array = live_array_getter
        self._hot_keys = frozenset(str(key) for key in hot_keys)
        self._cap_bytes = cap_bytes
        self._max_spans = max_spans
        self._gap_elements = gap_elements
        self._retained = {}  # (node_id, key) -> last-sent flat numpy copy
        self._orphaned_refs = {}  # (node_id, key) -> unused fresh content ref
        self._released_refs = set()

    def take_released_refs(self):
        released = self._released_refs
        self._released_refs = set()
        return released

    @staticmethod
    def _cache_key(node_id, key):
        # Keep the long-standing points-only inspection shape while namespacing
        # additional configured arrays by key.
        return str(node_id) if key == HOT_ARRAY_KEY else (str(node_id), key)

    @staticmethod
    def _belongs_to(cache_key, node_id):
        return cache_key == node_id or (
            isinstance(cache_key, tuple) and cache_key[0] == node_id
        )

    def drop(self, node_id, key=None):
        node_id = str(node_id)
        cache_keys = (
            [self._cache_key(node_id, str(key))]
            if key is not None
            else [item for item in self._retained if self._belongs_to(item, node_id)]
        )
        cache_keys += [
            item
            for item in self._orphaned_refs
            if self._belongs_to(item, node_id) and item not in cache_keys
        ]
        for cache_key in cache_keys:
            self._retained.pop(cache_key, None)
            orphan = self._orphaned_refs.pop(cache_key, None)
            if orphan:
                self._released_refs.add(orphan)

    def clear(self):
        self._retained.clear()
        self._orphaned_refs.clear()
        self._released_refs.clear()

    def _note_orphan(self, cache_key, fresh_ref, used_ref):
        previous = self._orphaned_refs.pop(cache_key, None)
        if previous and previous not in (fresh_ref, used_ref):
            self._released_refs.add(previous)
        if fresh_ref != used_ref:
            self._orphaned_refs[cache_key] = fresh_ref

    def _apply_key(self, node_id, key, entry, stored_entry, tx):
        cache_key = self._cache_key(node_id, key)
        current = self._live_array(node_id, key)
        if current is None or current.nbytes > self._cap_bytes:
            self.drop(node_id, key)
            return

        fresh_ref = entry["ref"]
        retained = self._retained.get(cache_key)
        if retained is None or stored_entry is None:
            self._retained[cache_key] = current.copy()
            self._note_orphan(cache_key, fresh_ref, fresh_ref)
            return

        expected_dtype = JS_ARRAY_DTYPE_MAP.get(entry.get("dataType"))
        comparable = (
            expected_dtype is not None
            and retained.size == current.size
            and retained.dtype == current.dtype
            and current.dtype == np.dtype(expected_dtype)
        )
        if not comparable:
            self._retained[cache_key] = current.copy()
            self._note_orphan(cache_key, fresh_ref, fresh_ref)
            return

        changed = np.flatnonzero(retained != current)
        if changed.size == 0:
            entry["ref"] = stored_entry["ref"]
            self._note_orphan(cache_key, fresh_ref, stored_entry["ref"])
            return

        spans = _changed_spans(changed, self._gap_elements)
        patched_size = sum(length for _offset, length in spans)
        if len(spans) > self._max_spans or patched_size * 2 >= current.size:
            self._retained[cache_key] = current.copy()
            self._note_orphan(cache_key, fresh_ref, fresh_ref)
            return

        entry["ref"] = stored_entry["ref"]
        for offset, length in spans:
            tx.patch_array(
                node_id,
                key,
                offset,
                current[offset : offset + length].tobytes(),
                entry["dataType"],
            )
        self._retained[cache_key] = current.copy()
        self._note_orphan(cache_key, fresh_ref, stored_entry["ref"])

    def apply(self, node_id, node, stored_node, tx):
        """Rewrite selected array refs and/or queue one or more patches."""
        arrays = node.get("arrays") or {}
        stored_arrays = (stored_node or {}).get("arrays") or {}
        for key in self._hot_keys:
            entry = arrays.get(key)
            if entry is None:
                self.drop(node_id, key)
                continue
            self._apply_key(node_id, key, entry, stored_arrays.get(key), tx)
