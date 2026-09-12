"""Publisher-lifetime cache for parsed vtkObjectManager states."""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from typing import TYPE_CHECKING, TypedDict

from trame_vtklocal.module.camera_authority import (
    CameraAuthority,
    validate_camera_authority,
)

if TYPE_CHECKING:
    from vtkmodules.vtkCommonCore import vtkObjectBase
    from vtkmodules.vtkSerializationManager import vtkObjectManager

    from trame_vtklocal.module.streamed_scene_registry import _StreamedSceneRegistry
    from trame_vtklocal.module.vtkjs_translator import VtkRef


class VtkState(TypedDict, total=False):
    """The ``vtkObjectManager.GetState`` keys the translator reads by name.

    Every other serialized property is still present and read generically.
    """

    Id: int
    ClassName: str
    Hash: str
    Name: str | None
    DataType: int
    NumberOfTuples: int
    NumberOfComponents: int
    NumberOfCells: int
    Connectivity: VtkRef
    Offsets: VtkRef
    Data: VtkRef
    Items: list[VtkRef]
    InputDataObjects: list[object]
    LookupTable: object
    BackgroundAlpha: float


class ParsedStateCache:
    """Cache ``GetState`` JSON by live object id and exact VTK MTime."""

    def __init__(self) -> None:
        self._entries: dict[int, tuple[int, VtkState]] = {}

    @staticmethod
    def _mtime(vtk_object: vtkObjectBase | None) -> int | None:
        getter = getattr(vtk_object, "GetMTime", None)
        return getter() if getter is not None else None

    def state(self, object_manager: vtkObjectManager, obj_id: int | str) -> VtkState:
        obj_id = int(obj_id)
        vtk_object = object_manager.GetObjectAtId(obj_id)
        before = self._mtime(vtk_object)
        cached = self._entries.get(obj_id)
        if before is not None and cached is not None and cached[0] == before:
            return cached[1]

        parsed: VtkState = json.loads(object_manager.GetState(obj_id))
        # GetState may itself touch serialization state. Key on the exact MTime
        # observed after the refresh/read, never on an approximate comparison.
        observed = self._mtime(vtk_object)
        if observed is not None:
            self._entries[obj_id] = (observed, parsed)
        return parsed

    def drop(self, obj_id: int | str) -> None:
        self._entries.pop(int(obj_id), None)

    def retain(self, live_ids: Iterable[int | str]) -> None:
        live = {int(obj_id) for obj_id in live_ids}
        self._entries = {
            obj_id: entry for obj_id, entry in self._entries.items() if obj_id in live
        }

    def clear(self) -> None:
        self._entries.clear()


class SceneReader:
    """Pass-local reads backed by an optional publisher-lifetime cache."""

    def __init__(
        self,
        object_manager: vtkObjectManager,
        camera_authority: CameraAuthority = "server",
        state_cache: ParsedStateCache | None = None,
        class_names: Mapping[str, str] | None = None,
        streamed_scene_registry: _StreamedSceneRegistry | None = None,
    ) -> None:
        self.object_manager = object_manager
        self.camera_authority = validate_camera_authority(camera_authority)
        self.streamed_scene_registry = streamed_scene_registry
        self._states: dict[int, VtkState] = {}
        self._state_cache = state_cache
        self._class_names: Mapping[str, str] = class_names or {}

    def state(self, obj_id: int | str) -> VtkState:
        obj_id = int(obj_id)
        if obj_id not in self._states:
            if self._state_cache is None:
                state: VtkState = json.loads(self.object_manager.GetState(obj_id))
            else:
                state = self._state_cache.state(self.object_manager, obj_id)
            self._states[obj_id] = state
        return self._states[obj_id]

    def class_name(self, obj_id: int | str) -> str:
        cached = self._class_names.get(str(obj_id))
        return cached if cached is not None else self.state(obj_id).get("ClassName", "")

    def vtk_object(self, obj_id: int | str) -> vtkObjectBase | None:
        vtk_object: vtkObjectBase | None = self.object_manager.GetObjectAtId(
            int(obj_id)
        )
        return vtk_object

    def clear_state_cache(self) -> None:
        self._states.clear()
