"""Retained-copy region differ for publisher-configured hot arrays."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from functools import partial
from typing import TYPE_CHECKING, Tuple

import numpy as np

from trame_vtklocal.widgets.blob_payloads import numpy_array_from_vtk_data

if TYPE_CHECKING:
    import numpy.typing as npt
    from vtkmodules.vtkCommonCore import vtkObject
    from vtkmodules.vtkSerializationManager import vtkObjectManager

    from trame_vtklocal.store import (
        ArrayEntry,
        SceneNode,
        SceneTransaction,
    )
    from trame_vtklocal.widgets.blob_payloads import LiveHotArray, NumericArray

# (element offset, element count) of one changed region
Span = Tuple[int, int]
_CacheKey = Tuple[str, str]

HOT_ARRAY_KEY = "points"
DEFAULT_HOT_ARRAY_KEYS = frozenset({HOT_ARRAY_KEY})
RETENTION_CAP_BYTES = 64 * 1024 * 1024
DEFAULT_MAX_SPANS = 8
DEFAULT_GAP_ELEMENTS = 3

JS_ARRAY_DTYPE_MAP: dict[str, type[np.generic]] = {
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


def live_dataset_array_sources(
    object_manager: vtkObjectManager, node_id: str | int, key: str
) -> tuple[vtkObject, ...]:
    """VTK objects whose modification can change a supported dataset array."""
    vtk_object = object_manager.GetObjectAtId(int(node_id))
    if vtk_object is None:
        return ()
    if key == HOT_ARRAY_KEY:
        points = vtk_object.GetPoints() if hasattr(vtk_object, "GetPoints") else None
        data = points.GetData() if points is not None else None
        sources: tuple[vtkObject | None, ...] = (points, data)
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


def live_dataset_array(
    object_manager: vtkObjectManager, node_id: str | int, key: str
) -> NumericArray | None:
    """Flat numpy view for a supported dataset array key, or ``None``."""
    sources = live_dataset_array_sources(object_manager, node_id, key)
    data = sources[-1] if sources else None
    if data is None:
        return None
    return np.asarray(numpy_array_from_vtk_data(data)).reshape(-1)


def _changed_spans(changed: npt.NDArray[np.intp], gap_elements: int) -> list[Span]:
    """Inclusive changed-index groups separated by more than ``gap_elements``."""
    if changed.size == 0:
        return []
    breaks = np.flatnonzero(np.diff(changed) > gap_elements)
    firsts = changed[np.concatenate(([0], breaks + 1))]
    lasts = changed[np.concatenate((breaks, [changed.size - 1]))]
    return [
        (int(first), int(last) - int(first) + 1) for first, last in zip(firsts, lasts)
    ]


@dataclass(frozen=True)
class Verdict:
    """A payload-free classification of one array's change."""

    name: str


DROP = Verdict("drop")  # gone or past the retention cap: keep no copy
RESET = Verdict("reset")  # send the whole array and retain it
NO_OP = Verdict("no-op")  # unchanged: reuse the client's stored content


@dataclass(frozen=True)
class Patch:
    """Changed regions small enough to send as ``patchArray`` ops."""

    spans: tuple[Span, ...]


@dataclass(frozen=True)
class HotArrayPatchPlan:
    node_id: str
    key: str
    data_type: str
    current: NumericArray
    spans: tuple[Span, ...]


class HotArrayDiffer:
    """Turn small edits to selected dataset arrays into ``patchArray`` ops."""

    def __init__(
        self,
        live_array_getter: LiveHotArray,
        hot_keys: Iterable[str] = DEFAULT_HOT_ARRAY_KEYS,
        cap_bytes: int = RETENTION_CAP_BYTES,
        max_spans: int = DEFAULT_MAX_SPANS,
        gap_elements: int = DEFAULT_GAP_ELEMENTS,
    ) -> None:
        self._live_array = live_array_getter
        self._hot_keys = frozenset(str(key) for key in hot_keys)
        self._cap_bytes = cap_bytes
        self._max_spans = max_spans
        self._gap_elements = gap_elements
        # (node_id, key) -> last-sent flat numpy copy
        self._retained: dict[_CacheKey, NumericArray] = {}
        # (node_id, key) -> unused fresh content ref
        self._orphaned_refs: dict[_CacheKey, str] = {}
        self._released_refs: set[str] = set()
        self._staged: list[Callable[[], None]] | None = None

    @property
    def hot_keys(self) -> frozenset[str]:
        return self._hot_keys

    def take_released_refs(self) -> set[str]:
        released = self._released_refs
        self._released_refs = set()
        return released

    @contextmanager
    def transaction(self) -> Iterator[None]:
        """Advance retained content only after the scene transaction commits."""
        actions: list[Callable[[], None]] = []
        self._staged = actions
        try:
            yield
        except BaseException:
            self._staged = None
            raise
        self._staged = None
        for action in actions:
            action()

    def _stage(self, action: Callable[[], None]) -> None:
        if self._staged is None:
            action()
        else:
            self._staged.append(action)

    @staticmethod
    def _cache_key(node_id: str, key: str) -> _CacheKey:
        return (str(node_id), key)

    @staticmethod
    def _belongs_to(cache_key: _CacheKey, node_id: str) -> bool:
        return cache_key[0] == node_id

    def drop(self, node_id: str | int, key: str | None = None) -> None:
        if self._staged is not None:
            self._stage(lambda: self.drop(node_id, key))
            return
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

    def clear(self) -> None:
        self._retained.clear()
        self._orphaned_refs.clear()
        self._released_refs.clear()

    def _note_orphan(self, cache_key: _CacheKey, fresh_ref: str, used_ref: str) -> None:
        if self._staged is not None:
            self._stage(lambda: self._note_orphan(cache_key, fresh_ref, used_ref))
            return
        previous = self._orphaned_refs.pop(cache_key, None)
        if previous and previous not in (fresh_ref, used_ref):
            self._released_refs.add(previous)
        if fresh_ref != used_ref:
            self._orphaned_refs[cache_key] = fresh_ref

    def classify_change(
        self,
        current: NumericArray | None,
        retained: NumericArray | None,
        data_type: str | None,
    ) -> Verdict | Patch:
        """Decide what one configured array's tick needs, in cascade order.

        ``retained`` is ``None`` whenever no comparable client-side content
        exists -- including when the caller holds no stored entry to reuse.
        The retention cap is answered before anything else, so an array too
        large to ever patch is never copied into the retained map.
        """
        if current is None or current.nbytes > self._cap_bytes:
            return DROP

        expected_dtype = (
            None if data_type is None else JS_ARRAY_DTYPE_MAP.get(data_type)
        )
        if (
            retained is None
            or expected_dtype is None
            or retained.size != current.size
            or retained.dtype != current.dtype
            or current.dtype != np.dtype(expected_dtype)
        ):
            return RESET

        changed = np.flatnonzero(retained != current)
        if changed.size == 0:
            return NO_OP
        # Spans only widen the patch beyond the changed elements, so half the
        # array changed already decides full-resend without assembling spans.
        if changed.size * 2 >= current.size:
            return RESET

        spans = tuple(_changed_spans(changed, self._gap_elements))
        patched_size = sum(length for _offset, length in spans)
        if len(spans) > self._max_spans or patched_size * 2 >= current.size:
            return RESET
        return Patch(spans)

    def plan_retained_patch(
        self, node_id: str | int, key: str, stored_entry: ArrayEntry | None
    ) -> HotArrayPatchPlan | None:
        """Plan a patch without serializing a fresh object-manager state.

        ``None`` means the caller must use the full translation path. An empty
        span tuple is a verified no-op.
        """
        node_id = str(node_id)
        key = str(key)
        cache_key = self._cache_key(node_id, key)
        current = self._live_array(node_id, key)
        retained = None if stored_entry is None else self._retained.get(cache_key)
        data_type = None if stored_entry is None else stored_entry.get("dataType")

        verdict = self.classify_change(current, retained, data_type)
        if current is None or data_type is None:
            return None
        if verdict is NO_OP:
            return HotArrayPatchPlan(node_id, key, data_type, current, ())
        if isinstance(verdict, Patch):
            return HotArrayPatchPlan(node_id, key, data_type, current, verdict.spans)
        return None

    def _write_spans(
        self,
        node_id: str,
        key: str,
        current: NumericArray,
        spans: Iterable[Span],
        data_type: str,
        tx: SceneTransaction,
    ) -> None:
        """Queue each span and advance the retained copy over the same bytes."""
        retained = self._retained[self._cache_key(node_id, key)]
        for offset, length in spans:
            # ``current`` is a live view of VTK-owned memory. Copy the span
            # once so the bytes on the wire and the bytes recorded as the
            # client's new content are the same read.
            values = current[offset : offset + length].copy()
            tx.patch_array(node_id, key, offset, values.tobytes(), data_type)
            self._stage(
                partial(
                    retained.__setitem__, slice(offset, offset + values.size), values
                )
            )

    def apply_retained_patch(
        self, plan: HotArrayPatchPlan, tx: SceneTransaction
    ) -> None:
        """Queue a retained patch plan and advance only its changed spans."""
        self._write_spans(
            plan.node_id, plan.key, plan.current, plan.spans, plan.data_type, tx
        )

    def _apply_key(
        self,
        node_id: str,
        key: str,
        entry: ArrayEntry,
        stored_entry: ArrayEntry | None,
        tx: SceneTransaction,
    ) -> None:
        cache_key = self._cache_key(node_id, key)
        current = self._live_array(node_id, key)
        retained = None if stored_entry is None else self._retained.get(cache_key)
        verdict = self.classify_change(current, retained, entry.get("dataType"))

        if verdict is DROP or current is None:
            self.drop(node_id, key)
            return

        fresh_ref = entry["ref"]
        if verdict is RESET or stored_entry is None:
            copied = current.copy()
            self._stage(lambda: self._retained.__setitem__(cache_key, copied))
            self._note_orphan(cache_key, fresh_ref, fresh_ref)
            return

        entry["ref"] = stored_entry["ref"]
        if isinstance(verdict, Patch):
            self._write_spans(
                node_id, key, current, verdict.spans, entry["dataType"], tx
            )
        self._note_orphan(cache_key, fresh_ref, stored_entry["ref"])

    def apply(
        self,
        node_id: str,
        node: SceneNode,
        stored_node: SceneNode | None,
        tx: SceneTransaction,
    ) -> None:
        """Rewrite selected array refs and/or queue one or more patches."""
        arrays = node.get("arrays") or {}
        stored_arrays = (stored_node.get("arrays") if stored_node else None) or {}
        for key in self._hot_keys:
            entry = arrays.get(key)
            if entry is None:
                self.drop(node_id, key)
                continue
            self._apply_key(node_id, key, entry, stored_arrays.get(key), tx)
