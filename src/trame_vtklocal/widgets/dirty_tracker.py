"""Event-driven dirty candidates and incremental observer ownership.

Normal publication consumes events. An explicit recovery sweep can discover
MTime changes when callers deliberately bypass ModifiedEvent.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from typing import TYPE_CHECKING, cast

from vtkmodules.vtkCommonCore import vtkCommand
from vtkmodules.vtkCommonExecutionModel import vtkAlgorithm

from trame_vtklocal.module.node_translator import is_node_class
from trame_vtklocal.module.vtkjs_translator import map_class_name
from trame_vtklocal.module.state_cache import ParsedStateCache
from trame_vtklocal.widgets.dependency_graph import DependencyGraph, mtime
from trame_vtklocal.widgets.dirty_batch import DirtyBatch
from trame_vtklocal.widgets.vtk_dependencies import (
    dataset_children,
    owned_collections,
    pipeline_producers,
    transform_children,
)

if TYPE_CHECKING:
    from vtkmodules.vtkCommonCore import vtkObject, vtkObjectBase
    from vtkmodules.vtkSerializationManager import vtkObjectManager

DATASET_PATCH_TYPES = {"vtkPolyData", "vtkImageData"}


class DirtyTracker:
    """Own observers and dependency-to-node invalidation for one window."""

    def __init__(
        self,
        object_manager: vtkObjectManager,
        rw_id: int | str,
        on_dirty: Callable[[], None] | None = None,
        state_cache: ParsedStateCache | None = None,
    ) -> None:
        self._object_manager = object_manager
        self._rw_id = int(rw_id)
        self._on_dirty = on_dirty
        self._graph = DependencyGraph(
            object_manager, self._rw_id, state_cache or ParsedStateCache()
        )
        self._classes = self._graph.classes
        self._dirty_ids: set[str] = set()
        self._swept_ids: set[str] = set()
        self._observed_objects: dict[str, tuple[vtkObject, int]] = {}
        self._mtimes: dict[str, int] = {}
        self._polled_dependencies: set[str] = set()
        # Live-only children and flattened dependencies have explicit owners.
        self._owner_ids: dict[str, set[str]] = {}
        self._children_by_owner: dict[str, set[str]] = {}
        self._pipeline_updates: dict[str, dict[int, vtkAlgorithm]] = {}
        self._pipeline_by_owner: dict[str, set[str]] = {}
        self._structural_ids: set[str] = set()
        self._suppressed = False
        self._disposed = False

    @contextmanager
    def suppress(self) -> Iterator[None]:
        previous = self._suppressed
        self._suppressed = True
        try:
            yield
        finally:
            self._suppressed = previous

    def _mark_dirty(self, object_id: str) -> None:
        if getattr(self, "_disposed", True) or self._suppressed:
            return
        self._dirty_ids.add(object_id)
        self._swept_ids.discard(object_id)
        if self._on_dirty:
            self._on_dirty()

    def has_pending(self) -> bool:
        return bool(self._dirty_ids)

    def classes(self) -> dict[str, str]:
        return self._classes

    def _observe(self, object_id: str, obj: vtkObjectBase) -> None:
        if not hasattr(obj, "AddObserver"):
            return
        observed = self._observed_objects.get(object_id)
        if observed is not None and observed[0] is obj:
            return
        if observed is not None:
            self._drop_observer(object_id)
        vtk_obj = cast("vtkObject", obj)

        def changed(_obj: vtkObject, _event: str) -> None:
            self._mark_dirty(object_id)

        tag = vtk_obj.AddObserver(vtkCommand.ModifiedEvent, changed)
        self._observed_objects[object_id] = (vtk_obj, tag)
        self._mtimes[object_id] = mtime(obj)
        if obj.IsA("vtkAbstractTransform") or object_id.startswith("pipeline:"):
            self._polled_dependencies.add(object_id)

    def _drop_observer(self, object_id: str) -> None:
        observed = self._observed_objects.pop(object_id, None)
        if observed:
            observed[0].RemoveObserver(observed[1])
        self._mtimes.pop(object_id, None)
        self._polled_dependencies.discard(object_id)
        self._dirty_ids.discard(object_id)
        self._swept_ids.discard(object_id)
        self._structural_ids.discard(object_id)

    def _key(self, obj: vtkObjectBase) -> str:
        known = self._graph.identifiers.get(id(obj))
        if known is not None:
            return known
        identifier = self._object_manager.GetId(obj)
        return str(identifier) if identifier else f"live:{id(obj)}"

    def _replace_live_children(self, owner: str, obj: vtkObjectBase | None) -> None:
        children: dict[str, vtkObjectBase] = {}
        pipeline: set[str] = set()
        if obj is not None:
            if obj.GetClassName() in DATASET_PATCH_TYPES:
                children.update(
                    (self._key(child), child) for child in dataset_children(obj)
                )
            children.update(
                (self._key(child), child) for child in transform_children(obj)
            )
            for child in owned_collections(obj):
                child_id = self._key(child)
                children[child_id] = child
                self._structural_ids.add(child_id)
            if isinstance(obj, vtkAlgorithm) and "Mapper" in obj.GetClassName():
                for producer in pipeline_producers(obj):
                    child_id = f"pipeline:{id(producer)}"
                    children[child_id] = producer
                    children.update(
                        (self._key(child), child)
                        for child in transform_children(producer)
                    )
                    pipeline.add(child_id)
                    self._pipeline_updates.setdefault(child_id, {})[int(owner)] = obj

        previous = self._children_by_owner.pop(owner, set())
        previous_pipeline = self._pipeline_by_owner.pop(owner, set())
        for child_id in previous_pipeline - pipeline:
            updates = self._pipeline_updates[child_id]
            updates.pop(int(owner), None)
            if not updates:
                self._pipeline_updates.pop(child_id)
        for child_id in previous - children.keys():
            owners = self._owner_ids[child_id]
            owners.discard(owner)
            if not owners:
                self._owner_ids.pop(child_id)
                if child_id not in self._graph.objects:
                    self._drop_observer(child_id)
        for child_id, dependency in children.items():
            self._owner_ids.setdefault(child_id, set()).add(owner)
            self._observe(child_id, dependency)
        if children:
            self._children_by_owner[owner] = set(children)
        if pipeline:
            self._pipeline_by_owner[owner] = pipeline

    def reconcile(self, refreshed_ids: Iterable[str]) -> set[str]:
        """Reconcile refreshed objects and changed/new serialized descendants."""
        with self.suppress():
            changed, removed = self._graph.refresh(refreshed_ids)
            for object_id in changed:
                obj = self._graph.objects[object_id]
                self._observe(object_id, obj)
                self._replace_live_children(object_id, obj)
            for object_id in removed:
                self._replace_live_children(object_id, None)
            for object_id in removed:
                if object_id not in self._owner_ids:
                    self._drop_observer(object_id)
            if removed:
                self._object_manager.PruneUnusedObjects()
                self._object_manager.PruneUnusedStates()
        return changed

    def sync_observers(self) -> None:
        """Explicit full graph recovery; normal ticks use reconcile()."""
        self.reconcile([str(self._rw_id), *self._graph.objects])

    def _node_owners(self, object_id: str) -> set[str]:
        result: set[str] = set()
        pending = [object_id]
        seen: set[str] = set()
        while pending:
            current = pending.pop()
            if current in seen:
                continue
            seen.add(current)
            pending.extend(self._owner_ids.get(current, ()))
            if is_node_class(self._classes.get(current, "")):
                result.add(current)
            elif map_class_name(self._classes.get(current, "")) != "vtkCamera":
                # Server cameras are intentionally absent from client scene
                # nodes. Their matrices must not invalidate the whole renderer.
                pending.extend(self._graph.parents.get(current, ()))
        return result

    def candidates_for(self, object_ids: Iterable[str]) -> set[str]:
        return self._map_dirty(object_ids).candidates

    def _map_dirty(
        self, dirty_ids: Iterable[str], swept_ids: Iterable[str] = ()
    ) -> DirtyBatch:
        batch = DirtyBatch(dirty_ids=set(dirty_ids), swept_ids=set(swept_ids))
        for object_id in batch.dirty_ids:
            owners = self._node_owners(object_id)
            batch.candidates.update(owners)
            batch.refresh_ids.update(owners)
            batch.producers.update(self._pipeline_updates.get(object_id, {}))
            if object_id in self._structural_ids:
                batch.structural = True
            if owners and object_id in self._classes:
                batch.refresh_ids.add(object_id)
            for owner in owners:
                obj = self._graph.objects.get(owner)
                if isinstance(obj, vtkAlgorithm) and "Mapper" in obj.GetClassName():
                    batch.producers[int(owner)] = obj
        return batch

    def _covered_input(self, object_id: str, obj: vtkObject) -> bool:
        if not object_id.startswith("pipeline:") or not obj.IsA("vtkTrivialProducer"):
            return False
        producer = cast("vtkAlgorithm", obj)
        data = producer.GetOutputDataObject(0)
        data_id = self._graph.identifiers.get(id(data), "")
        return self._classes.get(data_id) in DATASET_PATCH_TYPES and all(
            data_id in self._graph.children.get(str(mapper_id), ())
            for mapper_id in self._pipeline_updates.get(object_id, ())
        )

    def consume(self) -> DirtyBatch:
        # Transform concatenation and pipeline-owned implicit functions can
        # change aggregate MTime without a producer ModifiedEvent. Poll these
        # live dependencies, not every serialized object in the scene.
        for object_id in self._polled_dependencies:
            obj = self._observed_objects[object_id][0]
            if mtime(obj) != self._mtimes[object_id] and not self._covered_input(
                object_id, obj
            ):
                self._dirty_ids.add(object_id)
        dirty, swept = self._dirty_ids, self._swept_ids
        self._dirty_ids, self._swept_ids = set(), set()
        return self._map_dirty(dirty, swept)

    def restore(self, batch: DirtyBatch) -> None:
        """Keep failed work and any events that arrived during publication."""
        self._swept_ids.update(batch.swept_ids - self._dirty_ids)
        self._dirty_ids.update(batch.dirty_ids | batch.candidates)

    def acknowledge(self, object_ids: Iterable[str]) -> None:
        """Advance only processed MTimes after the scene commit succeeds."""
        for object_id in object_ids:
            observed = self._observed_objects.get(object_id)
            if observed is not None and object_id not in self._dirty_ids:
                self._mtimes[object_id] = mtime(observed[0])

    def sweep(self) -> None:
        """Explicit recovery for changed objects whose event was missed."""
        for object_id, previous in self._mtimes.items():
            obj = self._observed_objects[object_id][0]
            # A direct input's dataset and children are already observed.
            # Intermediate pipeline inputs may not be serialized at all.
            if self._covered_input(object_id, obj):
                continue
            if mtime(obj) != previous:
                if object_id not in self._dirty_ids:
                    self._swept_ids.add(object_id)
                self._dirty_ids.add(object_id)

    def cleanup(self) -> None:
        self._disposed = True
        for object_id in list(self._observed_objects):
            self._drop_observer(object_id)
        self._owner_ids.clear()
        self._children_by_owner.clear()
        self._pipeline_updates.clear()
        self._pipeline_by_owner.clear()
        self._graph.clear()
