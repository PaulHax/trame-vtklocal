"""vtkDistanceToCamera translation helpers."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
import math
import weakref
from typing import TYPE_CHECKING, TypedDict

from vtkmodules.vtkCommonDataModel import vtkDataObject

if TYPE_CHECKING:
    from typing_extensions import TypeGuard
    from vtkmodules.vtkCommonCore import vtkCollection, vtkObject, vtkObjectBase
    from vtkmodules.vtkCommonExecutionModel import vtkAlgorithm
    from vtkmodules.vtkRenderingCore import vtkDistanceToCamera
    from vtkmodules.vtkSerializationManager import vtkObjectManager


class DistanceToCameraConfig(TypedDict):
    arrayName: str
    screenSize: float


class DistanceToCameraTranslation(TypedDict):
    config: DistanceToCameraConfig
    inputDataObject: vtkDataObject


DEFAULT_DISTANCE_TO_CAMERA_ARRAY = "DistanceToCamera"
_MAPPER_TRANSLATION_SNAPSHOTS: weakref.WeakKeyDictionary[
    vtkObjectBase, DistanceToCameraTranslation
] = weakref.WeakKeyDictionary()
_REWIRE_DEPTH = 0
_POST_REWIRE_MTIMES: weakref.WeakKeyDictionary[vtkObjectBase, int] = (
    weakref.WeakKeyDictionary()
)


def serialization_rewire_active() -> bool:
    """True while the bypass is rewiring mapper inputs (enter/exit loops).

    The rewires fire ``ModifiedEvent`` on every dtc-fed mapper even though
    they are semantic no-ops (data in, connection restored). Dirty trackers
    consult this to drop that noise at the source, no matter which layer runs
    the bypass — publisher, tracker, protocol blob GC, or widget init.
    """
    return _REWIRE_DEPTH > 0


def mtime_is_rewire_noise(vtk_obj: vtkObjectBase, mtime: int) -> bool:
    """True when ``mtime`` is exactly the bypass's own post-restore bump.

    Lets MTime-based change detection (:meth:`DirtyTracker.sweep`) tell "the
    bypass touched this mapper" apart from a real modification: anything real
    after the bypass yields a strictly larger MTime.
    """
    try:
        return _POST_REWIRE_MTIMES.get(vtk_obj) == mtime
    except TypeError:
        return False


@contextmanager
def _rewire_scope() -> Iterator[None]:
    global _REWIRE_DEPTH
    _REWIRE_DEPTH += 1
    try:
        yield
    finally:
        _REWIRE_DEPTH -= 1


def mapper_input_algorithm(vtk_mapper: vtkObjectBase | None) -> vtkAlgorithm | None:
    if vtk_mapper is None:
        return None

    get_input_algorithm = getattr(vtk_mapper, "GetInputAlgorithm", None)
    if get_input_algorithm is None:
        return None

    for args in ((0, 0), ()):
        try:
            algorithm: vtkAlgorithm | None = get_input_algorithm(*args)
            return algorithm
        except TypeError:
            continue
    return None


def mapper_input_array_name(
    vtk_mapper: vtkObjectBase | None, index: int = 0
) -> str | None:
    if index == 0:
        get_scale_array = getattr(vtk_mapper, "GetScaleArray", None)
        if get_scale_array is not None:
            scale_array: str | None = get_scale_array()
            if scale_array:
                return scale_array

    get_input_array_info = getattr(vtk_mapper, "GetInputArrayInformation", None)
    if get_input_array_info is None:
        return None

    try:
        info = get_input_array_info(index)
    except TypeError:
        return None

    if not info:
        return None

    name: str | None = info.Get(vtkDataObject.FIELD_NAME())
    return name or None


def is_distance_to_camera_algorithm(
    vtk_algorithm: vtkObjectBase | None,
) -> TypeGuard[vtkDistanceToCamera]:
    if vtk_algorithm is None:
        return False

    is_a = getattr(vtk_algorithm, "IsA", None)
    if is_a is not None and is_a("vtkDistanceToCamera"):
        return True

    get_class_name = getattr(vtk_algorithm, "GetClassName", None)
    return get_class_name is not None and get_class_name() == "vtkDistanceToCamera"


def distance_to_camera_input_data_object(
    vtk_algorithm: vtkObjectBase | None,
) -> vtkDataObject | None:
    if not is_distance_to_camera_algorithm(vtk_algorithm):
        return None

    get_input_data_object = getattr(vtk_algorithm, "GetInputDataObject", None)
    if get_input_data_object is None:
        return None

    try:
        data_object: vtkDataObject | None = get_input_data_object(0, 0)
        return data_object
    except TypeError:
        return None


def mapper_distance_to_camera_input(
    vtk_mapper: vtkObjectBase | None,
) -> tuple[vtkAlgorithm | None, vtkDataObject | None]:
    input_algorithm = mapper_input_algorithm(vtk_mapper)
    return (
        input_algorithm,
        distance_to_camera_input_data_object(input_algorithm),
    )


def _distance_to_camera_mapper_config(
    vtk_mapper: vtkObjectBase | None,
) -> DistanceToCameraConfig | None:
    input_algorithm = mapper_input_algorithm(vtk_mapper)
    if not is_distance_to_camera_algorithm(input_algorithm):
        return None

    screen_size = float(input_algorithm.GetScreenSize())
    if not math.isfinite(screen_size) or screen_size <= 0:
        return None

    array_name = mapper_input_array_name(vtk_mapper)
    if not array_name:
        get_array_name = getattr(input_algorithm, "GetDistanceArrayName", None)
        array_name = get_array_name() if get_array_name is not None else None
    if not array_name:
        array_name = DEFAULT_DISTANCE_TO_CAMERA_ARRAY

    return {
        "arrayName": array_name,
        "screenSize": screen_size,
    }


def _capture_mapper_translation_snapshot(
    vtk_mapper: vtkObjectBase, input_data_object: vtkDataObject | None
) -> None:
    config = _distance_to_camera_mapper_config(vtk_mapper)
    if not config or input_data_object is None:
        return

    _MAPPER_TRANSLATION_SNAPSHOTS[vtk_mapper] = {
        "config": config.copy(),
        "inputDataObject": input_data_object,
    }


def _current_primary_input_data_object(
    vtk_mapper: vtkObjectBase,
) -> vtkDataObject | None:
    get_input_data_object = getattr(vtk_mapper, "GetInputDataObject", None)
    if get_input_data_object is None:
        return None

    for args in ((0, 0), (0,), ()):
        try:
            data_object: vtkDataObject | None = get_input_data_object(*args)
            return data_object
        except TypeError:
            continue
    return None


def distance_to_camera_mapper_translation(
    vtk_mapper: vtkObjectBase,
) -> DistanceToCameraTranslation | None:
    config = _distance_to_camera_mapper_config(vtk_mapper)
    if config:
        input_data_object = distance_to_camera_input_data_object(
            mapper_input_algorithm(vtk_mapper)
        )
        if input_data_object is not None:
            return {
                "config": config,
                "inputDataObject": input_data_object,
            }

    snapshot = _MAPPER_TRANSLATION_SNAPSHOTS.get(vtk_mapper)
    if not snapshot:
        return None

    input_data_object = snapshot.get("inputDataObject")
    if _current_primary_input_data_object(vtk_mapper) is not input_data_object:
        return None

    return {
        "config": snapshot["config"].copy(),
        "inputDataObject": input_data_object,
    }


def state_available(object_manager: vtkObjectManager, obj_id: int) -> bool:
    try:
        return bool(object_manager.GetState(obj_id))
    except Exception:
        return False


def refresh_object_manager_states(
    object_manager: vtkObjectManager,
    clear_state_cache: Callable[[], None],
    obj_id: int | None = None,
) -> None:
    update_state = getattr(object_manager, "UpdateStateFromObject", None)
    if obj_id is not None and update_state is not None:
        update_state(int(obj_id))
        clear_state_cache()
        return

    update_states = getattr(object_manager, "UpdateStatesFromObjects", None)
    if update_states is not None:
        update_states()
        clear_state_cache()


def ensure_registered_vtk_object(
    object_manager: vtkObjectManager,
    vtk_obj: vtkObjectBase | None,
    clear_state_cache: Callable[[], None],
) -> int | None:
    if vtk_obj is None:
        return None

    get_id = getattr(object_manager, "GetId", None)
    obj_id: int = get_id(vtk_obj) if get_id is not None else 0
    if obj_id and obj_id > 0:
        if not state_available(object_manager, obj_id):
            refresh_object_manager_states(
                object_manager, clear_state_cache, obj_id=obj_id
            )
        return obj_id

    register_object = getattr(object_manager, "RegisterObject", None)
    if register_object is None:
        return None

    registered_id: int = register_object(vtk_obj)
    resolved_id: int = get_id(vtk_obj) if get_id is not None else registered_id
    obj_id = resolved_id if resolved_id and resolved_id > 0 else registered_id
    if not obj_id or obj_id <= 0:
        return None

    refresh_object_manager_states(object_manager, clear_state_cache, obj_id=obj_id)
    return obj_id


def _iter_collection_items(collection: vtkCollection | None) -> Iterator[vtkObject]:
    if collection is None:
        return

    get_number_of_items = getattr(collection, "GetNumberOfItems", None)
    get_item_as_object = getattr(collection, "GetItemAsObject", None)
    if get_number_of_items is not None and get_item_as_object is not None:
        for index in range(get_number_of_items()):
            item = get_item_as_object(index)
            if item is not None:
                yield item
        return

    init_traversal = getattr(collection, "InitTraversal", None)
    get_next_item = getattr(collection, "GetNextItemAsObject", None)
    if init_traversal is None or get_next_item is None:
        return

    init_traversal()
    while True:
        item = get_next_item()
        if item is None:
            break
        yield item


def _iter_prop_tree(prop: vtkObject | None, seen: set[int]) -> Iterator[vtkObject]:
    if prop is None:
        return
    prop_key = id(prop)
    if prop_key in seen:
        return
    seen.add(prop_key)
    yield prop

    get_parts = getattr(prop, "GetParts", None)
    if get_parts is None:
        return
    for child in _iter_collection_items(get_parts()):
        yield from _iter_prop_tree(child, seen)


def iter_scene_mappers(vtk_root: vtkObjectBase | None) -> Iterator[vtkObjectBase]:
    if vtk_root is None:
        return

    get_class_name = getattr(vtk_root, "GetClassName", None)
    class_name = get_class_name() if get_class_name is not None else ""
    if "Mapper" in class_name:
        yield vtk_root
        return

    renderers: list[vtkObjectBase] = []
    get_renderers = getattr(vtk_root, "GetRenderers", None)
    if get_renderers is not None:
        renderers.extend(_iter_collection_items(get_renderers()))
    elif class_name and "Renderer" in class_name:
        renderers.append(vtk_root)

    seen_props: set[int] = set()
    seen_mappers: set[int] = set()
    for renderer in renderers:
        get_view_props = getattr(renderer, "GetViewProps", None)
        if get_view_props is None:
            continue
        for root_prop in _iter_collection_items(get_view_props()):
            for prop in _iter_prop_tree(root_prop, seen_props):
                get_mapper = getattr(prop, "GetMapper", None)
                if get_mapper is None:
                    continue
                mapper = get_mapper()
                if mapper is None or id(mapper) in seen_mappers:
                    continue
                seen_mappers.add(id(mapper))
                yield mapper


def _set_mapper_primary_input_data(
    mapper: vtkObjectBase, input_data: vtkDataObject
) -> bool:
    set_input_data = getattr(mapper, "SetInputData", None)
    if set_input_data is not None:
        set_input_data(input_data)
        return True

    set_input_data_object = getattr(mapper, "SetInputDataObject", None)
    if set_input_data_object is None:
        return False

    for args in ((0, input_data), (input_data,)):
        try:
            set_input_data_object(*args)
            return True
        except TypeError:
            continue
    return False


def _restore_mapper_primary_input_connection(
    mapper: vtkObjectBase, input_algorithm: vtkAlgorithm
) -> None:
    get_output_port = getattr(input_algorithm, "GetOutputPort", None)
    set_input_connection = getattr(mapper, "SetInputConnection", None)
    if get_output_port is None or set_input_connection is None:
        return

    output_port = get_output_port()
    for args in ((0, output_port), (output_port,)):
        try:
            set_input_connection(*args)
            return
        except TypeError:
            continue


@contextmanager
def bypass_distance_to_camera_for_serialization(
    vtk_root: vtkObjectBase | None,
) -> Iterator[None]:
    rewired: list[tuple[vtkObjectBase, vtkAlgorithm]] = []
    with _rewire_scope():
        for mapper in iter_scene_mappers(vtk_root):
            input_algorithm, input_data = mapper_distance_to_camera_input(mapper)
            if input_algorithm is None or input_data is None:
                continue
            _capture_mapper_translation_snapshot(mapper, input_data)
            if _set_mapper_primary_input_data(mapper, input_data):
                rewired.append((mapper, input_algorithm))

    try:
        yield
    finally:
        with _rewire_scope():
            for mapper, input_algorithm in reversed(rewired):
                _restore_mapper_primary_input_connection(mapper, input_algorithm)
                if hasattr(mapper, "GetMTime"):
                    _POST_REWIRE_MTIMES[mapper] = mapper.GetMTime()
