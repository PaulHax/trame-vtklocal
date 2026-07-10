"""Publisher-lifetime cache for parsed vtkObjectManager states."""

from __future__ import annotations

import json

from trame_vtklocal.module.camera_authority import validate_camera_authority


class ParsedStateCache:
    """Cache ``GetState`` JSON by live object id and exact VTK MTime."""

    def __init__(self):
        self._entries = {}  # int id -> (mtime, parsed state)

    @staticmethod
    def _mtime(vtk_object):
        getter = getattr(vtk_object, "GetMTime", None)
        return getter() if getter is not None else None

    def state(self, object_manager, obj_id):
        obj_id = int(obj_id)
        vtk_object = object_manager.GetObjectAtId(obj_id)
        before = self._mtime(vtk_object)
        cached = self._entries.get(obj_id)
        if before is not None and cached is not None and cached[0] == before:
            return cached[1]

        parsed = json.loads(object_manager.GetState(obj_id))
        # GetState may itself touch serialization state. Key on the exact MTime
        # observed after the refresh/read, never on an approximate comparison.
        observed = self._mtime(vtk_object)
        if observed is not None:
            self._entries[obj_id] = (observed, parsed)
        return parsed

    def drop(self, obj_id):
        self._entries.pop(int(obj_id), None)

    def retain(self, live_ids):
        live = {int(obj_id) for obj_id in live_ids}
        self._entries = {
            obj_id: entry for obj_id, entry in self._entries.items() if obj_id in live
        }

    def clear(self):
        self._entries.clear()


class SceneReader:
    """Pass-local reads backed by an optional publisher-lifetime cache."""

    def __init__(
        self,
        object_manager,
        camera_authority="server",
        state_cache=None,
        class_names=None,
    ):
        self.object_manager = object_manager
        self.camera_authority = validate_camera_authority(camera_authority)
        self._states = {}
        self._state_cache = state_cache
        self._class_names = class_names or {}

    def state(self, obj_id):
        obj_id = int(obj_id)
        if obj_id not in self._states:
            if self._state_cache is None:
                state = json.loads(self.object_manager.GetState(obj_id))
            else:
                state = self._state_cache.state(self.object_manager, obj_id)
            self._states[obj_id] = state
        return self._states[obj_id]

    def class_name(self, obj_id):
        cached = self._class_names.get(str(obj_id))
        return cached if cached is not None else self.state(obj_id).get("ClassName", "")

    def vtk_object(self, obj_id):
        return self.object_manager.GetObjectAtId(int(obj_id))

    def clear_state_cache(self):
        self._states.clear()
