import base64
import numpy as np
from trame_vtklocal.widgets.vtkjs_base import VtkJsBaseView, _inline_arrays


class VtkJsSharedView(VtkJsBaseView):
    _ref_prefix = "_vtkjssharedview"
    _shared_views = {}

    def __init__(self, render_window, debug_arrays=False, **kwargs):
        super().__init__("vtk-js-shared", render_window, **kwargs)

        self._view_id = str(self._window_id)
        self._inline_array_cache = {}
        self._sent_hashes = set()
        self._debug_arrays = debug_arrays
        self._initial_sync_done = False
        self._pending_changes = []

        self._event_names += [
            "updated",
            ("view_state_change", "viewStateChange"),
            ("on_ready", "onReady"),
        ]

        self.server.controller.on_client_connected.add(self._on_client_connected)
        VtkJsSharedView._shared_views[self._view_id] = self

    def _on_client_connected(self, **kwargs):
        self._initial_sync_done = False
        self.request_resync()

    def request_resync(self, extra=None):
        self._sent_hashes.clear()
        self._pending_changes.clear()

        if not self.server.protocol:
            return

        full_state = self._get_vtkjs_state()
        _inline_arrays(full_state, self.object_manager, self._sent_hashes)
        if extra:
            full_state.setdefault("extra", {}).update(extra)

        self.server.protocol.publish("trame.vtk.delta", full_state)
        self._initial_sync_done = True

    def mark_modified(self, vtk_object, array_path, start=0, count=None, data=None, data_type=None):
        instance_id = self.get_instance_id(vtk_object)
        self._pending_changes.append((vtk_object, instance_id, array_path, start, count, data, data_type))

    def _flush_pending_changes(self):
        if not self._pending_changes or not self.server.protocol:
            return False

        if not self._initial_sync_done:
            self.request_resync()

        for vtk_obj, instance_id, array_path, start, count, raw_data, raw_type in self._pending_changes:
            if raw_data is not None:
                data = raw_data
                data_type = raw_type
                if array_path == "points":
                    element_offset = start * 3
                else:
                    element_offset = start
            else:
                data, data_type, bytes_per_elem = self._extract_array_region(
                    vtk_obj, array_path, start, count
                )
                if data is None:
                    continue
                if array_path == "points":
                    element_offset = start * 3
                else:
                    element_offset = start

            if isinstance(data, bytes):
                data = base64.b64encode(data).decode("ascii")

            self.server.protocol.publish(
                "trame.vtk.array.partial",
                {
                    "instanceId": instance_id,
                    "arrayPath": array_path,
                    "offset": element_offset,
                    "data": data,
                    "dataType": data_type,
                },
            )

        self._pending_changes.clear()
        return True

    def _extract_array_region(self, vtk_object, array_path, start, count):
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

    def update(self, inline_arrays=False, extra=None, push_pending=True, **kwargs):
        if not self.server.protocol:
            return

        if push_pending and self._pending_changes:
            self._flush_pending_changes()

        delta_state = self._get_vtkjs_state()

        if inline_arrays:
            _inline_arrays(delta_state, self.object_manager, self._sent_hashes)
            self._initial_sync_done = True

        if extra:
            delta_state.setdefault("extra", {}).update(extra)

        self.server.protocol.publish("trame.vtk.delta", delta_state)

    def render_shared(self, options=None, **kwargs):
        self.server.js_call(self._ref, "renderShared", options or {})

    def on_render_requested(self, callback_name, **kwargs):
        self.server.js_call(self._ref, "onRenderRequested", callback_name)

    def get_renderer(self):
        renderers = self._render_window.GetRenderers()
        if renderers.GetNumberOfItems() > 0:
            return renderers.GetItemAsObject(0)
        return None


__all__ = ["VtkJsSharedView"]
