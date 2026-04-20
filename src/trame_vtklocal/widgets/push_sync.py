import logging
import os
import time

import numpy as np
from trame_vtklocal.widgets.vtkjs_base import _inline_arrays

_PROF = os.environ.get("TRAME_VTKLOCAL_PROF") == "1"
_prof_logger = logging.getLogger("trame_vtklocal.prof")


class PushSync:
    def __init__(
        self,
        server,
        object_manager,
        get_vtkjs_state,
        get_instance_id,
        render_window_id,
        always_inline_arrays=False,
        api=None,
    ):
        self._server = server
        self._object_manager = object_manager
        self._get_vtkjs_state = get_vtkjs_state
        self._get_instance_id = get_instance_id
        self._render_window_id = str(render_window_id)
        self._always_inline_arrays = always_inline_arrays
        self._api = api
        self._pending_changes = []
        self._sent_hashes = set()

    def request_resync(self, extra=None):
        self._pending_changes.clear()
        self._sent_hashes.clear()

        if not self._server.protocol:
            return

        full_state = self._get_vtkjs_state()
        _inline_arrays(full_state, self._object_manager)
        if extra:
            full_state.setdefault("extra", {}).update(extra)

        if self._api:
            self._api._convert_bytes_to_attachments(full_state)
        self._server.protocol.publish("trame.vtk.delta", full_state)

    def update(self, extra=None):
        if not self._server.protocol:
            return

        if _PROF:
            t0 = time.perf_counter()
            self._pending_changes.clear()
            delta_state = self._get_vtkjs_state()
            t1 = time.perf_counter()
            if self._always_inline_arrays:
                _inline_arrays(delta_state, self._object_manager)
            else:
                _inline_arrays(delta_state, self._object_manager, self._sent_hashes)
            t2 = time.perf_counter()
            if extra:
                delta_state.setdefault("extra", {}).update(extra)
            if self._api:
                self._api._convert_bytes_to_attachments(delta_state)
            t3 = time.perf_counter()
            self._server.protocol.publish("trame.vtk.delta", delta_state)
            t4 = time.perf_counter()
            _prof_logger.info(
                "[trame-prof] push_sync.update get_state=%.2fms inline_arrays=%.2fms convert=%.2fms publish=%.2fms",
                (t1 - t0) * 1000.0,
                (t2 - t1) * 1000.0,
                (t3 - t2) * 1000.0,
                (t4 - t3) * 1000.0,
            )
            return

        self._pending_changes.clear()
        delta_state = self._get_vtkjs_state()
        if self._always_inline_arrays:
            _inline_arrays(delta_state, self._object_manager)
        else:
            _inline_arrays(delta_state, self._object_manager, self._sent_hashes)

        if extra:
            delta_state.setdefault("extra", {}).update(extra)

        if self._api:
            self._api._convert_bytes_to_attachments(delta_state)

        self._server.protocol.publish("trame.vtk.delta", delta_state)

    def mark_modified(self, vtk_object, array_path, start=0, count=None, data=None, data_type=None):
        instance_id = self._get_instance_id(vtk_object)
        self._pending_changes.append((vtk_object, instance_id, array_path, start, count, data, data_type))

    def flush(self):
        if not self._pending_changes or not self._server.protocol:
            return False

        for vtk_obj, instance_id, array_path, start, count, raw_data, raw_type in self._pending_changes:
            if raw_data is not None:
                data = raw_data
                data_type = raw_type
                if array_path == "points":
                    element_offset = start * 3
                else:
                    element_offset = start
            else:
                data, data_type, bytes_per_elem = self.extract_array_region(
                    vtk_obj, array_path, start, count
                )
                if data is None:
                    continue
                if array_path == "points":
                    element_offset = start * 3
                else:
                    element_offset = start

            self._server.protocol.publish(
                "trame.vtk.array.partial",
                {
                    "rwId": self._render_window_id,
                    "instanceId": instance_id,
                    "arrayPath": array_path,
                    "offset": element_offset,
                    "data": data,
                    "dataType": data_type,
                },
            )

        self._pending_changes.clear()
        return True

    @staticmethod
    def extract_array_region(vtk_object, array_path, start, count):
        if array_path == "points" and hasattr(vtk_object, "GetPoints"):
            pts = vtk_object.GetPoints()
            if pts:
                data = pts.GetData()
                if data:
                    arr = np.array(data)
                    n_components = 3
                    if count is None:
                        count = len(arr) - start
                    end = start + count
                    region = arr[start:end].flatten().astype(np.float32)
                    return region.tobytes(), "Float32Array", 4 * n_components

        elif array_path == "lines" and hasattr(vtk_object, "GetLines"):
            lines = vtk_object.GetLines()
            if lines:
                data = lines.GetData()
                if data:
                    arr = np.array(data)
                    if count is None:
                        count = len(arr) - start
                    end = start + count
                    region = arr[start:end]
                    return region.astype(np.int64).tobytes(), "BigInt64Array", 8

        elif array_path == "polys" and hasattr(vtk_object, "GetPolys"):
            polys = vtk_object.GetPolys()
            if polys:
                data = polys.GetData()
                if data:
                    arr = np.array(data)
                    if count is None:
                        count = len(arr) - start
                    end = start + count
                    region = arr[start:end]
                    return region.astype(np.int64).tobytes(), "BigInt64Array", 8

        return None, None, None
