"""Conservative eligibility guard for serialization-free array publication."""

from __future__ import annotations

from typing import TYPE_CHECKING

from vtkmodules.vtkCommonCore import vtkDataArray

from trame_vtklocal.widgets.hot_arrays import live_dataset_array_sources

if TYPE_CHECKING:
    from vtkmodules.vtkSerializationManager import vtkObjectManager
    from trame_vtklocal.store import CommitResult, SceneStore
    from trame_vtklocal.widgets.dirty_batch import DirtyBatch
    from trame_vtklocal.widgets.hot_arrays import HotArrayDiffer, HotArrayPatchPlan


def commit_hot_array_batch(
    batch: DirtyBatch,
    object_manager: vtkObjectManager,
    store: SceneStore,
    hot_arrays: HotArrayDiffer,
) -> CommitResult | None:
    """Commit an array-only tick before VTK serializes the whole payload.

    Any structural, pipeline, node, or unsupported-array dirtiness returns
    ``None`` so the publisher uses its ordinary translation path.

    Only observed array-source events qualify. Recovery batches may include
    suppressed metadata changes and always take the full translation path.

    Reads VTK but never mutates it; the publisher still enters its tracker's
    ``suppress()`` around the call so that stays a contract rather than an
    assumption.
    """
    if batch.structural or batch.producers or batch.swept_ids or not batch.candidates:
        return None

    dirty_ids = {str(object_id) for object_id in batch.dirty_ids}
    allowed_dirty_ids: set[str] = set()
    plans: list[HotArrayPatchPlan] = []
    for node_id in batch.candidates:
        node_id = str(node_id)
        stored = store.get(node_id)
        arrays = (stored.get("arrays") if stored else None) or {}
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
            sources = live_dataset_array_sources(object_manager, node_id, key)
            array = sources[-1] if sources else None
            serialized_ids = {
                str(dependency)
                for dependency in object_manager.GetAllDependencies(int(node_id))
            }
            if (
                not isinstance(array, vtkDataArray)
                # A live source the node's last serialization did not record,
                # such as an array ``vtkPoints.SetData`` swapped in, is not
                # observed either: only serializing the node makes its later
                # edits visible.
                or not source_ids <= serialized_ids
                or array.GetNumberOfComponents() != entry.get("numberOfComponents", 1)
                or (array.GetName() or "") != (entry.get("name") or "")
            ):
                return None
            plan = hot_arrays.plan_retained_patch(node_id, key, entry)
            if plan is None:
                return None
            plans.append(plan)
            node_has_dirty_hot_array = True
        if not node_has_dirty_hot_array:
            return None

    if not dirty_ids.issubset(allowed_dirty_ids):
        return None

    tx = store.transact()
    for plan in plans:
        hot_arrays.apply_retained_patch(plan, tx)
    return tx.commit()
