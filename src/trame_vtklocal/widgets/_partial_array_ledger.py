"""Synthetic-hash bookkeeping for partial-array push sync.

Split out of ``push_sync.py`` so PushSync owns the protocol state machine
and PartialArrayLedger owns the synthetic ``v:`` hash registry. The
ledger is composed in PushSync via ``self._partial_arrays = PartialArrayLedger(...)``
and has no back-reference to PushSync — every method is data-in / data-out.
"""

from __future__ import annotations

from trame_vtklocal._protocol_constants import SYNTHETIC_VERSION_PREFIX
from trame_vtklocal.widgets._push_sync_helpers import (
    PARTIAL_ARRAY_PATHS,
    _array_payload_for_js_type,
    _collect_hashes,
    _collect_partial_array_hashes,
    _numpy_array_from_vtk_data,
    _object_manager_iid,
)


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
        # Bulk-promotion paths call this once per client; second-and-later
        # iterations are no-ops, so short-circuit when the registry is empty.
        if not self._versions and not self._current_hashes:
            return
        self.clear()

    def retire_object(self, object_id):
        iid = _object_manager_iid(object_id)
        if iid is None:
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
