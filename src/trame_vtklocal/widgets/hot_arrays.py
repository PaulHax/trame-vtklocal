"""Retained-copy region differ for publisher-configured hot arrays."""

from __future__ import annotations

from dataclasses import dataclass

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


def live_dataset_array_sources(object_manager, node_id, key):
    """VTK objects whose modification can change a supported dataset array."""
    vtk_object = object_manager.GetObjectAtId(int(node_id))
    if vtk_object is None:
        return ()
    if key == HOT_ARRAY_KEY:
        points = vtk_object.GetPoints() if hasattr(vtk_object, "GetPoints") else None
        data = points.GetData() if points is not None else None
        sources = (points, data)
    elif key.startswith("field:pointData:"):
        name = key.split(":", 2)[2]
        point_data = (
            vtk_object.GetPointData() if hasattr(vtk_object, "GetPointData") else None
        )
        data = point_data.GetArray(name) if point_data is not None else None
        sources = (data,)
    else:
        sources = ()
    return tuple(source for source in sources if source is not None)


def live_dataset_array(object_manager, node_id, key):
    """Flat numpy view for a supported dataset array key, or ``None``."""
    sources = live_dataset_array_sources(object_manager, node_id, key)
    data = sources[-1] if sources else None
    if data is None:
        return None
    return np.asarray(numpy_array_from_vtk_data(data)).reshape(-1)


def _changed_spans(changed, gap_elements):
    """Inclusive changed-index groups separated by more than ``gap_elements``."""
    if changed.size == 0:
        return []
    breaks = np.flatnonzero(np.diff(changed) > gap_elements)
    firsts = changed[np.concatenate(([0], breaks + 1))]
    lasts = changed[np.concatenate((breaks, [changed.size - 1]))]
    return [
        (int(first), int(last) - int(first) + 1)
        for first, last in zip(firsts, lasts)
    ]


@dataclass(frozen=True)
class HotArrayPatchPlan:
    node_id: str
    key: str
    data_type: str
    current: np.ndarray
    spans: tuple


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

    @property
    def hot_keys(self):
        return self._hot_keys

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

    def plan_retained_patch(self, node_id, key, stored_entry):
        """Plan a patch without serializing a fresh object-manager state.

        ``None`` means the caller must use the full translation path. An empty
        span tuple is a verified no-op.
        """
        node_id = str(node_id)
        key = str(key)
        cache_key = self._cache_key(node_id, key)
        current = self._live_array(node_id, key)
        retained = self._retained.get(cache_key)
        if current is None or retained is None or stored_entry is None:
            return None
        if current.nbytes > self._cap_bytes:
            return None

        data_type = stored_entry.get("dataType")
        expected_dtype = JS_ARRAY_DTYPE_MAP.get(data_type)
        if (
            expected_dtype is None
            or retained.size != current.size
            or retained.dtype != current.dtype
            or current.dtype != np.dtype(expected_dtype)
        ):
            return None

        changed = np.flatnonzero(retained != current)
        if changed.size == 0:
            return HotArrayPatchPlan(node_id, key, data_type, current, ())
        if changed.size * 2 >= current.size:
            return None

        spans = tuple(_changed_spans(changed, self._gap_elements))
        patched_size = sum(length for _offset, length in spans)
        if len(spans) > self._max_spans or patched_size * 2 >= current.size:
            return None
        return HotArrayPatchPlan(node_id, key, data_type, current, spans)

    def apply_retained_patch(self, plan, tx):
        """Queue a retained patch plan and advance only its changed spans."""
        retained = self._retained[self._cache_key(plan.node_id, plan.key)]
        for offset, length in plan.spans:
            values = plan.current[offset : offset + length]
            tx.patch_array(
                plan.node_id,
                plan.key,
                offset,
                values.tobytes(),
                plan.data_type,
            )
            retained[offset : offset + length] = values

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

        # Spans only widen the patch beyond the changed elements, so half the
        # array changed already decides full-resend without assembling spans.
        if changed.size * 2 >= current.size:
            self._retained[cache_key] = current.copy()
            self._note_orphan(cache_key, fresh_ref, fresh_ref)
            return

        spans = _changed_spans(changed, self._gap_elements)
        patched_size = sum(length for _offset, length in spans)
        if len(spans) > self._max_spans or patched_size * 2 >= current.size:
            self._retained[cache_key] = current.copy()
            self._note_orphan(cache_key, fresh_ref, fresh_ref)
            return

        entry["ref"] = stored_entry["ref"]
        for offset, length in spans:
            values = current[offset : offset + length]
            tx.patch_array(
                node_id,
                key,
                offset,
                values.tobytes(),
                entry["dataType"],
            )
            retained[offset : offset + length] = values
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


def commit_hot_array_batch(batch, object_manager, store, hot_arrays):
    """Commit an array-only tick before VTK serializes the whole payload.

    Any structural, pipeline, node, or unsupported-array dirtiness returns
    ``None`` so the publisher uses its ordinary translation path.
    """
    if batch.structural or batch.producers or not batch.candidates:
        return None

    dirty_ids = {str(object_id) for object_id in batch.dirty_ids}
    allowed_dirty_ids = {
        str(node_id)
        for node_id in batch.candidates
        if str(node_id) in batch.swept_ids
    }
    plans = []
    for node_id in batch.candidates:
        node_id = str(node_id)
        stored = store.get(node_id)
        arrays = (stored or {}).get("arrays") or {}
        node_has_dirty_hot_array = False
        for key in hot_arrays.hot_keys:
            entry = arrays.get(key)
            if entry is None:
                continue
            source_ids = {
                str(object_manager.GetId(source))
                for source in live_dataset_array_sources(object_manager, node_id, key)
            }
            allowed_dirty_ids.update(source_ids)
            if dirty_ids.isdisjoint(source_ids):
                continue
            plan = hot_arrays.plan_retained_patch(node_id, key, entry)
            if plan is None:
                return None
            plans.append(plan)
            node_has_dirty_hot_array = True
        if not node_has_dirty_hot_array:
            return None

    if not dirty_ids or not dirty_ids.issubset(allowed_dirty_ids):
        return None

    tx = store.transact()
    for plan in plans:
        hot_arrays.apply_retained_patch(plan, tx)
    return tx.commit()
