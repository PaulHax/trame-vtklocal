"""Hot-array auto region diff for the scene publisher (push sync v2).

Replaces v1's explicit ``mark_modified``/``flush`` partial-array API: mutate
``vtkPoints`` in place, and the publisher turns it into a small
``patchArray`` op automatically by comparing the live array against a
retained last-sent copy.

Policy per candidate dataset:

- no retained copy yet → the fresh ``c:`` ref flows (one full send) and
  retention starts; arrays above the retention cap are never retained;
- identical content → the translated node keeps the store's current ref so
  no op emits for the array;
- changed span smaller than half the array → one ``patchArray`` op carrying
  the flat element offset plus span bytes, and the translated node keeps the
  store's current ref so the upsert stays suppressed unless other keys
  changed;
- larger changes or shape/dtype changes → full resend under the fresh
  ``c:`` ref.

The differ also tracks "orphaned" refs — fresh ``c:`` hashes the translator
minted that the store never adopted (patch/equal cases). Their manager blobs
stay referenced by the serialized array state until the next refresh
replaces them, at which point they are handed to the blob GC via
:meth:`HotArrayDiffer.take_released_refs`.
"""

from __future__ import annotations

import numpy as np

HOT_ARRAY_KEY = "points"
RETENTION_CAP_BYTES = 64 * 1024 * 1024

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


class HotArrayDiffer:
    """Retained-copy region differ for one publisher's hot arrays."""

    def __init__(self, live_array_getter, cap_bytes=RETENTION_CAP_BYTES):
        self._live_array = live_array_getter
        self._cap_bytes = cap_bytes
        self._retained = {}  # node_id -> flat numpy copy of the last-sent array
        self._orphaned_refs = {}  # node_id -> fresh c: ref the store never used
        self._released_refs = set()

    def take_released_refs(self):
        """Refs whose manager blobs just became unreferenced (for blob GC)."""
        released = self._released_refs
        self._released_refs = set()
        return released

    def drop(self, node_id):
        self._retained.pop(node_id, None)
        orphan = self._orphaned_refs.pop(node_id, None)
        if orphan:
            self._released_refs.add(orphan)

    def clear(self):
        self._retained.clear()
        self._orphaned_refs.clear()
        self._released_refs.clear()

    def _note_orphan(self, node_id, fresh_ref, used_ref):
        previous = self._orphaned_refs.pop(node_id, None)
        if previous and previous not in (fresh_ref, used_ref):
            self._released_refs.add(previous)
        if fresh_ref != used_ref:
            self._orphaned_refs[node_id] = fresh_ref

    def apply(self, node_id, node, stored_node, tx):
        """Rewrite ``node``'s hot-array ref and/or queue a region patch."""
        entry = (node.get("arrays") or {}).get(HOT_ARRAY_KEY)
        if entry is None:
            self.drop(node_id)
            return

        current = self._live_array(node_id)
        if current is None or current.nbytes > self._cap_bytes:
            self.drop(node_id)
            return

        fresh_ref = entry["ref"]
        stored_entry = ((stored_node or {}).get("arrays") or {}).get(HOT_ARRAY_KEY)
        retained = self._retained.get(node_id)

        if retained is None or stored_entry is None:
            # First publish of this array: pay one full send, start retention.
            self._retained[node_id] = current.copy()
            self._note_orphan(node_id, fresh_ref, fresh_ref)
            return

        expected_dtype = JS_ARRAY_DTYPE_MAP.get(entry.get("dataType"))
        comparable = (
            expected_dtype is not None
            and retained.size == current.size
            and retained.dtype == current.dtype
            and current.dtype == np.dtype(expected_dtype)
        )
        if not comparable:
            # Length/dtype change: full resend under the fresh c: ref.
            self._retained[node_id] = current.copy()
            self._note_orphan(node_id, fresh_ref, fresh_ref)
            return

        changed = np.flatnonzero(retained != current)
        if changed.size == 0:
            entry["ref"] = stored_entry["ref"]
            self._note_orphan(node_id, fresh_ref, stored_entry["ref"])
            return

        first = int(changed[0])
        span = int(changed[-1]) - first + 1
        if span * 2 >= current.size:
            self._retained[node_id] = current.copy()
            self._note_orphan(node_id, fresh_ref, fresh_ref)
            return

        entry["ref"] = stored_entry["ref"]
        tx.patch_array(
            node_id,
            HOT_ARRAY_KEY,
            first,
            current[first : first + span].tobytes(),
            entry["dataType"],
        )
        self._retained[node_id] = current.copy()
        self._note_orphan(node_id, fresh_ref, stored_entry["ref"])
