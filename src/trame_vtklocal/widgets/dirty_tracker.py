"""Dirty-candidate tracking for the scene publisher.

Owns the ``ModifiedEvent`` observers over the render window's dependency
graph, the dataset-children and pipeline-producer walkers, the structural
collection observers, the suppress-dirty context manager, the live-ids
filter, and the mtime snapshot sweep.

The tracker's ONLY job is to produce *candidate* dirty ids per publish tick.
False positives are cheap — the store's generic diff drops no-op upserts —
and false negatives are healed by :meth:`DirtyTracker.sweep`, which compares
live ``GetMTime`` values against the last snapshot.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from typing import TYPE_CHECKING

from vtkmodules.vtkCommonCore import vtkCommand
from vtkmodules.vtkCommonExecutionModel import vtkAlgorithm

from trame_vtklocal.module.node_translator import is_node_class
from trame_vtklocal.widgets.dirty_batch import DirtyBatch

if TYPE_CHECKING:
    from vtkmodules.vtkCommonCore import vtkObject, vtkObjectBase
    from vtkmodules.vtkSerializationManager import vtkObjectManager

DATASET_PATCH_TYPES: set[str] = {"vtkPolyData", "vtkImageData"}


# ---------------------------------------------------------------------------
# VTK-side iteration helpers
# ---------------------------------------------------------------------------


def _iter_via_getters(obj: object, names: Iterable[str]) -> Iterator[vtkObject]:
    """Yield each non-None result of calling obj.<name>() for each name."""
    if obj is None:
        return
    for getter in names:
        get = getattr(obj, getter, None)
        if get is None:
            continue
        result = get()
        if result is not None:
            yield result


def _iter_field_data_arrays(field_data: vtkObject | None) -> Iterator[vtkObject]:
    if field_data is None:
        return

    yield field_data

    get_count = getattr(field_data, "GetNumberOfArrays", None)
    get_array = getattr(field_data, "GetArray", None)
    if get_count is not None and get_array is not None:
        for index in range(get_count()):
            array = get_array(index)
            if array is not None:
                yield array

    yield from _iter_via_getters(
        field_data, ("GetScalars", "GetTCoords", "GetNormals", "GetVectors")
    )


def _iter_cell_array_children(cell_array: vtkObject | None) -> Iterator[vtkObject]:
    if cell_array is None:
        return

    yield cell_array
    # Not GetData(): it copies the whole connectivity per call, never a dependency.
    getters = ("GetConnectivityArray", "GetOffsetsArray")
    yield from _iter_via_getters(cell_array, getters)


def _iter_dataset_dirty_children(dataset: vtkObjectBase | None) -> Iterator[vtkObject]:
    if dataset is None:
        return

    points = dataset.GetPoints() if hasattr(dataset, "GetPoints") else None
    if points is not None:
        yield points
        data = points.GetData() if hasattr(points, "GetData") else None
        if data is not None:
            yield data

    for cell_array in _iter_via_getters(
        dataset, ("GetVerts", "GetLines", "GetPolys", "GetStrips")
    ):
        yield from _iter_cell_array_children(cell_array)

    for field_data in _iter_via_getters(
        dataset, ("GetPointData", "GetCellData", "GetFieldData")
    ):
        yield from _iter_field_data_arrays(field_data)


def _owned_collections(vtk_obj: vtkObjectBase | None) -> Iterator[vtkObject]:
    """Structural collections owned by a node-worthy object.

    ``AddActor``/``RemoveActor``/``AddRenderer`` fire ``ModifiedEvent`` on the
    collection only — never on the renderer or window — so structural changes
    are observed on the collection and attributed back to its owner node.
    """
    if vtk_obj is None or not hasattr(vtk_obj, "IsA"):
        return
    if vtk_obj.IsA("vtkRenderWindow"):
        yield from _iter_via_getters(vtk_obj, ("GetRenderers",))
    elif vtk_obj.IsA("vtkRenderer"):
        yield from _iter_via_getters(vtk_obj, ("GetViewProps", "GetLights"))


class DirtyTracker:
    """Observes a render window's dependency graph for dirty candidates."""

    def __init__(
        self,
        object_manager: vtkObjectManager,
        rw_id: int | str,
        on_dirty: Callable[[], None] | None = None,
    ) -> None:
        self._object_manager = object_manager
        self._rw_id = int(rw_id)
        self._on_dirty = on_dirty
        self._dirty_ids: set[str] = set()
        self._swept_ids: set[str] = set()
        self._owner_ids: dict[str, set[str]] = {}
        self._pipeline_updates: dict[str, dict[int, vtkAlgorithm]] = {}
        self._structural_ids: set[str] = set()
        self._observed_objects: dict[str, tuple[vtkObject, int]] = {}
        self._classes: dict[str, str] = {}
        self._mtimes: dict[str, int] = {}
        self._suppressed = False
        self._disposed = False

    # -- dirty marks ---------------------------------------------------

    @contextmanager
    def suppress(self) -> Iterator[None]:
        """Ignore ModifiedEvents fired by our own serialization/translation."""
        previous = self._suppressed
        self._suppressed = True
        try:
            yield
        finally:
            self._suppressed = previous

    def _mark_dirty(self, object_id: str | int) -> None:
        # Observers can fire during interpreter teardown when self.__dict__ is
        # already cleared; default-True _disposed makes that a silent no-op.
        if getattr(self, "_disposed", True) or self._suppressed:
            return
        self._dirty_ids.add(str(object_id))
        self._swept_ids.discard(str(object_id))
        if self._on_dirty is not None:
            self._on_dirty()

    def _make_dirty_callback(self, object_id: str) -> Callable[[vtkObject, str], None]:
        def on_modified(
            _vtk_obj: vtkObject, _event: str, object_id: str = object_id
        ) -> None:
            self._mark_dirty(object_id)

        return on_modified

    def has_pending(self) -> bool:
        return bool(self._dirty_ids)

    def classes(self) -> dict[str, str]:
        return self._classes

    # -- observer graph ------------------------------------------------

    def _clear_observers(self) -> None:
        for vtk_obj, observer_tag in self._observed_objects.values():
            try:
                vtk_obj.RemoveObserver(observer_tag)
            except (AttributeError, RuntimeError, ValueError):
                pass
        self._observed_objects.clear()

    def _observe(self, object_id: str | int, vtk_obj: vtkObject | None) -> None:
        if vtk_obj is None or not hasattr(vtk_obj, "AddObserver"):
            return

        object_id = str(object_id)
        observed = self._observed_objects.get(object_id)
        if observed is not None and observed[0] is vtk_obj:
            return
        if observed is not None:
            try:
                observed[0].RemoveObserver(observed[1])
            except (AttributeError, RuntimeError, ValueError):
                pass

        tag = vtk_obj.AddObserver(
            vtkCommand.ModifiedEvent, self._make_dirty_callback(object_id)
        )
        self._observed_objects[object_id] = (vtk_obj, tag)

    def sync_observers(self) -> None:
        """Rebuild the observer graph from the current dependency set."""
        object_manager = self._object_manager
        with self.suppress():
            ids = list(object_manager.GetAllDependencies(self._rw_id))

        pending_dirty_ids = set(self._dirty_ids)
        pending_swept_ids = set(self._swept_ids)
        self._clear_observers()
        live_ids = {str(object_id) for object_id in ids}

        classes: dict[str, str] = {}
        mtimes: dict[str, int] = {}
        live_objects: dict[str, vtkObject] = {}
        for object_id in live_ids:
            vtk_obj = object_manager.GetObjectAtId(int(object_id))
            if vtk_obj is None:
                continue
            live_objects[object_id] = vtk_obj
            self._observe(object_id, vtk_obj)
            get_class_name = getattr(vtk_obj, "GetClassName", None)
            class_name = (get_class_name() if get_class_name else "") or ""
            if class_name:
                classes[object_id] = class_name
            if hasattr(vtk_obj, "GetMTime"):
                mtimes[object_id] = vtk_obj.GetMTime()
        self._classes = classes
        self._mtimes = mtimes

        owner_ids: dict[str, set[str]] = {}
        pipeline_updates: dict[str, dict[int, vtkAlgorithm]] = {}
        structural_ids: set[str] = set()
        for object_id, vtk_obj in live_objects.items():
            class_name = classes.get(object_id, "")
            if class_name in DATASET_PATCH_TYPES:
                self._sync_dataset_children(object_id, vtk_obj, live_ids, owner_ids)
            if "Mapper" in class_name:
                self._sync_mapper_pipeline(
                    object_id, vtk_obj, live_ids, owner_ids, pipeline_updates
                )
            for collection in _owned_collections(vtk_obj):
                collection_id = str(object_manager.GetId(collection))
                if collection_id in live_ids:
                    structural_ids.add(collection_id)
                    owner_ids.setdefault(collection_id, set()).add(object_id)

        self._owner_ids = owner_ids
        self._pipeline_updates = pipeline_updates
        self._structural_ids = structural_ids
        self._dirty_ids = {
            object_id
            for object_id in pending_dirty_ids
            if object_id in live_ids
            or object_id in owner_ids
            or object_id in pipeline_updates
        }
        self._swept_ids = pending_swept_ids & self._dirty_ids

    def _sync_dataset_children(
        self,
        dataset_id: str,
        dataset: vtkObjectBase | None,
        live_ids: Iterable[str] | None,
        owner_ids: dict[str, set[str]] | None = None,
    ) -> None:
        if owner_ids is None:
            owner_ids = self._owner_ids
        live_ids = set(live_ids or ())
        for child in _iter_dataset_dirty_children(dataset):
            try:
                child_id = str(self._object_manager.GetId(child))
            except (TypeError, ValueError, RuntimeError):
                continue
            # Live-ids filter: iteration yields transient Python
            # wrappers that GetId() assigns fresh ids to on every call;
            # observing them grows _observed_objects unboundedly (~33k in
            # 5 min of playback) and pins observer callbacks.
            if live_ids and child_id not in live_ids:
                continue
            owner_ids.setdefault(child_id, set()).add(str(dataset_id))
            self._observe(child_id, child)

    def refresh_dataset_children(self, dataset_ids: Iterable[str | int]) -> None:
        """Re-observe children of just-published datasets (arrays get swapped)."""
        object_manager = self._object_manager
        live_ids = set(self._classes)
        for object_id in dataset_ids:
            object_id = str(object_id)
            if self._classes.get(object_id, "") not in DATASET_PATCH_TYPES:
                continue
            dataset = object_manager.GetObjectAtId(int(object_id))
            self._sync_dataset_children(object_id, dataset, live_ids)

    def _sync_mapper_pipeline(
        self,
        mapper_id: str,
        mapper: vtkObject | None,
        live_ids: set[str],
        owner_ids: dict[str, set[str]],
        pipeline_updates: dict[str, dict[int, vtkAlgorithm]],
    ) -> None:
        if not isinstance(mapper, vtkAlgorithm):
            return

        try:
            port_count = mapper.GetNumberOfInputPorts()
        except (AttributeError, RuntimeError):
            port_count = 1

        for port_index in range(port_count):
            try:
                connection_count = mapper.GetNumberOfInputConnections(port_index)
            except (AttributeError, RuntimeError):
                connection_count = 1

            for connection_index in range(connection_count):
                owner_id = self._mapper_input_dataset_id(
                    mapper, port_index, connection_index, live_ids
                )
                if owner_id is None:
                    continue

                try:
                    connection = mapper.GetInputConnection(port_index, connection_index)
                except (AttributeError, RuntimeError):
                    connection = None
                if connection is None or not hasattr(connection, "GetProducer"):
                    continue

                producer = connection.GetProducer()
                if producer is None:
                    continue

                self._observe_pipeline_producer(
                    mapper_id,
                    producer,
                    owner_id,
                    producer,
                    owner_ids,
                    pipeline_updates,
                    set(),
                )

    def _mapper_input_dataset_id(
        self,
        mapper: vtkAlgorithm,
        port_index: int,
        connection_index: int,
        live_ids: set[str],
    ) -> str | None:
        data_object = None
        get_input_data = getattr(mapper, "GetInputDataObject", None)
        if get_input_data is not None:
            try:
                data_object = get_input_data(port_index, connection_index)
            except (TypeError, RuntimeError):
                data_object = None

        if data_object is None and port_index == 0 and connection_index == 0:
            get_input = getattr(mapper, "GetInput", None)
            if get_input is not None:
                try:
                    data_object = get_input()
                except RuntimeError:
                    data_object = None

        if data_object is None:
            return None

        try:
            owner_id = str(self._object_manager.GetId(data_object))
        except (TypeError, ValueError, RuntimeError):
            return None

        if owner_id not in live_ids:
            return None
        if self._classes.get(owner_id, "") not in DATASET_PATCH_TYPES:
            return None
        return owner_id

    def _observe_pipeline_producer(
        self,
        mapper_id: str,
        producer: vtkAlgorithm,
        owner_id: str,
        terminal_producer: vtkAlgorithm,
        owner_ids: dict[str, set[str]],
        pipeline_updates: dict[str, dict[int, vtkAlgorithm]],
        seen: set[int],
    ) -> None:
        producer_key = id(producer)
        if producer_key in seen:
            return
        seen.add(producer_key)

        dirty_id = f"pipeline:{mapper_id}:{owner_id}:{producer_key}"
        owner_ids.setdefault(dirty_id, set()).add(str(owner_id))
        pipeline_updates.setdefault(dirty_id, {})[id(terminal_producer)] = (
            terminal_producer
        )
        self._observe(dirty_id, producer)

        get_input_connection = getattr(producer, "GetInputConnection", None)
        if get_input_connection is None:
            return

        try:
            port_count = producer.GetNumberOfInputPorts()
        except (AttributeError, RuntimeError):
            port_count = 0

        for port_index in range(port_count):
            try:
                connection_count = producer.GetNumberOfInputConnections(port_index)
            except (AttributeError, RuntimeError):
                connection_count = 0

            for connection_index in range(connection_count):
                try:
                    connection = get_input_connection(port_index, connection_index)
                except RuntimeError:
                    continue
                if connection is None or not hasattr(connection, "GetProducer"):
                    continue

                upstream = connection.GetProducer()
                if upstream is None:
                    continue
                self._observe_pipeline_producer(
                    mapper_id,
                    upstream,
                    owner_id,
                    terminal_producer,
                    owner_ids,
                    pipeline_updates,
                    seen,
                )

    # -- consuming -----------------------------------------------------

    def _map_dirty(
        self, dirty_ids: Iterable[str], swept_ids: Iterable[str] = ()
    ) -> DirtyBatch:
        batch = DirtyBatch(
            dirty_ids=set(dirty_ids),
            swept_ids=set(swept_ids),
        )
        for object_id in dirty_ids:
            owners = self._owner_ids.get(object_id, ())
            batch.candidates.update(owners)
            batch.refresh_ids.update(owners)
            batch.producers.update(self._pipeline_updates.get(object_id, {}))
            if object_id in self._structural_ids:
                batch.structural = True
            if is_node_class(self._classes.get(object_id, "")):
                batch.candidates.add(object_id)
            if object_id in self._classes:
                # Refresh every live dirty object's serialized state: array
                # children re-hash their blobs (the owner dataset's node ref
                # comes from the child state), and a structural collection
                # refresh registers newly added members with the manager.
                batch.refresh_ids.add(object_id)
        return batch

    def consume(self) -> DirtyBatch:
        """Take the pending dirty marks as a :class:`DirtyBatch`."""
        dirty_ids = self._dirty_ids
        swept_ids = self._swept_ids
        self._dirty_ids = set()
        self._swept_ids = set()
        return self._map_dirty(dirty_ids, swept_ids)

    def sweep(self) -> None:
        """Fold ids whose live mtime moved since the last snapshot into the
        pending dirty set — heals observer false negatives."""
        object_manager = self._object_manager
        for object_id, previous in list(self._mtimes.items()):
            vtk_obj = object_manager.GetObjectAtId(int(object_id))
            if vtk_obj is None or not hasattr(vtk_obj, "GetMTime"):
                continue
            mtime = vtk_obj.GetMTime()
            if mtime != previous:
                self._mtimes[object_id] = mtime
                if object_id not in self._dirty_ids:
                    self._swept_ids.add(object_id)
                self._dirty_ids.add(object_id)

    def cleanup(self) -> None:
        self._clear_observers()
        self._dirty_ids.clear()
        self._swept_ids.clear()
        self._owner_ids.clear()
        self._pipeline_updates.clear()
        self._structural_ids.clear()
        self._classes = {}
        self._mtimes = {}
        self._disposed = True
