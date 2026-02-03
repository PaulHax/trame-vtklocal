"""
VtkJsSharedView widget for rendering VTK scenes using vtk.js with a shared WebGL context.

This enables integration with other WebGL libraries like MapLibre, Three.js, etc.
The external library owns the WebGL context and VTK renders into it.
"""

import base64
import numpy as np
from trame_client.widgets.core import AbstractElement
from trame_vtklocal import module


def _inline_arrays(state, object_manager, sent_hashes=None):
    """Inline array content into state for synchronous client rendering.

    Args:
        state: The vtk.js state dict to modify in-place
        object_manager: The vtkObjectManager instance
        sent_hashes: Optional set of hashes already sent to client.
            If provided, only inlines arrays not in this set.
            If None, inlines all arrays.
    """
    if not state or not object_manager:
        return

    def get_blob_base64(hash_str):
        import numpy as np

        if hash_str.startswith("cell:"):
            parts = hash_str.split(":")
            conn_hash = parts[1]
            off_hash = parts[2]

            conn_blob = object_manager.GetBlob(conn_hash)
            off_blob = object_manager.GetBlob(off_hash)

            connectivity = np.frombuffer(memoryview(conn_blob), dtype=np.int64)
            offsets = np.frombuffer(memoryview(off_blob), dtype=np.int64)

            num_cells = len(offsets) - 1
            result = []
            for i in range(num_cells):
                start = offsets[i]
                end = offsets[i + 1]
                cell_size = end - start
                result.append(int(cell_size))
                result.extend(int(x) for x in connectivity[start:end])

            data = np.array(result, dtype=np.uint32).tobytes()
            return base64.b64encode(data).decode("ascii")

        blob = object_manager.GetBlob(hash_str)
        return base64.b64encode(bytes(blob)).decode("ascii")

    def walk(node):
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return

        data_hash = node.get("hash")
        if data_hash and node.get("dataType") and "content" not in node:
            should_inline = sent_hashes is None or data_hash not in sent_hashes
            if should_inline:
                content = get_blob_base64(data_hash)
                if content:
                    node["content"] = content
                    if sent_hashes is not None:
                        sent_hashes.add(data_hash)

        if "properties" in node and isinstance(node["properties"], dict):
            for value in node["properties"].values():
                walk(value)
        if "dependencies" in node:
            for dep in node["dependencies"]:
                walk(dep)

    walk(state)


class HtmlElement(AbstractElement):
    def __init__(self, _elem_name, children=None, **kwargs):
        super().__init__(_elem_name, children, **kwargs)
        if self.server:
            kwargs.pop("trame_server", None)
            self.server.enable_module(module, **kwargs)


class VtkJsSharedView(HtmlElement):
    """
    VtkJsSharedView renders a server-side vtkRenderWindow using vtk.js
    in a shared WebGL context owned by another library (MapLibre, Three.js, etc).

    The view doesn't create its own canvas. Instead, call initializeForSharedContext()
    from JavaScript with the external canvas and WebGL context.

    Args:
        render_window (vtkRenderWindow):
            The VTK render window to mirror on the client.
        debug_arrays (bool):
            If True, print statistics about array inlining.
        view_state_change (event):
            Event emitted when view state changes (for camera sync).
        on_ready (event):
            Event emitted when the view is ready.
        updated (event):
            Emitted after each completed client-side update.

    Example:
        >>> view = VtkJsSharedView(render_window, on_ready="window.initMapLibre()")
        >>> view.update(inline_arrays=True)  # Push updates with inline arrays
    """

    _next_id = 0
    _shared_views = {}

    def __init__(self, render_window, debug_arrays=False, **kwargs):
        super().__init__("vtk-js-shared", **kwargs)

        self.__ref = kwargs.get("ref")
        if self.__ref is None:
            VtkJsSharedView._next_id += 1
            self.__ref = f"_vtkjssharedview_{VtkJsSharedView._next_id}"

        self._render_window = render_window
        self._window_id = self.object_manager.RegisterObject(render_window)
        self._view_id = str(self._window_id)
        render_window.Render()
        self.object_manager.UpdateStatesFromObjects()

        self._inline_array_cache = {}
        self._sent_hashes = set()
        self._debug_arrays = debug_arrays
        self._initial_sync_done = False
        self._pending_changes = []  # [(vtk_obj, instance_id, array_path, start, count)]

        self._attributes["rw_id"] = f':render-window="{self._window_id}"'
        self._attributes["ref"] = f'ref="{self.__ref}"'
        self._event_names += [
            "updated",
            ("view_state_change", "viewStateChange"),
            ("on_ready", "onReady"),
        ]

        self.server.controller.on_client_connected.add(self._on_client_connected)
        VtkJsSharedView._shared_views[self._view_id] = self

    @property
    def api(self):
        """Return API from helper."""
        return module.get_helper(self.server).api

    @property
    def object_manager(self):
        """Return object_manager."""
        return self.api.vtk_object_manager

    @property
    def ref_name(self):
        """Return the assigned name as a vue.js ref."""
        return self.__ref

    def _on_client_connected(self, **kwargs):
        """Send full state when client (re)connects."""
        self._initial_sync_done = False
        self.request_resync()

    def _get_vtkjs_state(self):
        """Get state translated to vtk.js format."""
        from trame_vtklocal.module.vtkjs_translator import translate_scene

        self._render_window.Render()
        self.object_manager.UpdateStatesFromObjects()
        return translate_scene(self.object_manager, self._window_id)

    def request_resync(self, extra=None):
        """Request full state resync - clears tracking and publishes full state.

        Call this when the client needs full state (e.g., on mount, after
        browser sleep/wake, visibility change, or detected missing content).
        """
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
        """Mark a range of an array as modified for partial update.

        Call this after modifying VTK array data. The next update() will
        send only the marked regions instead of doing a full sync.

        Args:
            vtk_object: The VTK object (e.g., vtkPolyData) that was modified
            array_path: Which array changed ("points", "lines", "polys")
            start: Starting element index (not byte offset)
            count: Number of elements changed (None = to end of array)
            data: Optional pre-computed bytes to send (skips VTK extraction)
            data_type: Required if data provided. Use "Float32Array" for points
                (matches vtk.js internal format), "BigInt64Array" for cell arrays.

        Example:
            # Simple - extracts from VTK:
            points.SetPoint(10, x, y, z)
            view.mark_modified(polydata, "points", start=10, count=1)

            # Fast - pass pre-computed data (use float32 for points):
            point_bytes = np.array([x, y, z], dtype=np.float32).tobytes()
            view.mark_modified(polydata, "points", start=10, data=point_bytes, data_type="Float32Array")

            view.update()  # Sends only the marked changes
        """
        instance_id = self.get_instance_id(vtk_object)
        self._pending_changes.append((vtk_object, instance_id, array_path, start, count, data, data_type))

    def _flush_pending_changes(self):
        """Send all pending partial updates."""
        if not self._pending_changes or not self.server.protocol:
            return False

        if not self._initial_sync_done:
            self.request_resync()

        for vtk_obj, instance_id, array_path, start, count, raw_data, raw_type in self._pending_changes:
            if raw_data is not None:
                # Fast path: use pre-computed data
                data = raw_data
                data_type = raw_type
                # Calculate element offset (JS TypedArray.set uses element index, not bytes)
                if array_path == "points":
                    element_offset = start * 3  # 3 components per point
                else:
                    element_offset = start  # 1 element per cell data entry
            else:
                # Simple path: extract from VTK
                data, data_type, bytes_per_elem = self._extract_array_region(
                    vtk_obj, array_path, start, count
                )
                if data is None:
                    continue
                # Calculate element offset from bytes_per_elem
                if array_path == "points":
                    element_offset = start * 3  # 3 components per point
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
        """Extract a region of array data from a VTK object.

        Returns:
            Tuple of (bytes, data_type_str, bytes_per_element) or (None, None, None)
        """
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
                    # Use Float32 to match vtk.js internal storage format
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
        """
        Push geometry updates to client via delta channel.

        Args:
            inline_arrays: If True, inline array content in the state.
                Uses hash tracking to skip arrays already sent to client.
                Unchanged arrays (same hash) won't have content re-sent.
            extra: Optional dict to include in state (e.g., orbitCamera for MapLibre).
            push_pending: If True (default), send any pending partial updates first.
        """
        if not self.server.protocol:
            return

        # Send partial array updates if any
        if push_pending and self._pending_changes:
            self._flush_pending_changes()

        # Get current state
        delta_state = self._get_vtkjs_state()

        if inline_arrays:
            _inline_arrays(delta_state, self.object_manager, self._sent_hashes)
            self._initial_sync_done = True

        if extra:
            delta_state.setdefault("extra", {}).update(extra)

        self.server.protocol.publish("trame.vtk.delta", delta_state)

    def render_shared(self, options=None, **kwargs):
        """Render VTK in shared context mode (host render loop)."""
        self.server.js_call(self.__ref, "renderShared", options or {})

    def on_render_requested(self, callback_name, **kwargs):
        """Forward VTK render requests to the host."""
        self.server.js_call(self.__ref, "onRenderRequested", callback_name)

    def get_renderer(self):
        """Get the first renderer from the render window."""
        renderers = self._render_window.GetRenderers()
        if renderers.GetNumberOfItems() > 0:
            return renderers.GetItemAsObject(0)
        return None

    def append_array(self, array_id, data, data_type, offset, total_size):
        """Publish an incremental array update.

        This is used for high-frequency geometry updates where only a portion
        of the array changes. The client maintains a buffer and appends the
        new data at the specified offset.

        Args:
            array_id: Unique identifier for the array (use consistent IDs for the same array)
            data: The data to append (bytes or base64 string)
            data_type: JavaScript typed array type (e.g., "Float32Array")
            offset: Element offset where data should be written
            total_size: Total number of elements in the complete array
        """
        if not self.server.protocol:
            return

        if isinstance(data, bytes):
            data = base64.b64encode(data).decode("ascii")

        self.server.protocol.publish(
            "trame.vtk.array.append",
            {
                "arrayId": array_id,
                "dataType": data_type,
                "data": data,
                "offset": offset,
                "totalSize": total_size,
            },
        )

    def get_instance_id(self, vtk_object):
        """Get the vtk.js synchronized instance ID for a VTK object.

        Args:
            vtk_object: A VTK object that has been registered with the object manager

        Returns:
            String ID that can be used with update_array_region
        """
        vtk_id = self.object_manager.GetId(vtk_object)
        return str(vtk_id)

    def update_array_region(self, instance_id, array_path, data, offset=0, data_type="Float64Array"):
        """Update a portion of an array on an existing vtk.js object.

        This directly modifies the vtk.js object's array data and triggers a re-render.
        Much more efficient than full state sync for high-frequency updates.

        Note: If called before any full sync has occurred, this will automatically
        trigger a full state sync first to ensure the vtk.js objects exist.

        Args:
            instance_id: The vtk.js instance ID (from get_instance_id)
            array_path: Which array to update ("points", "polys", "lines", "verts", "strips")
            data: The data to write (bytes, numpy array, or base64 string)
            offset: Element offset where data should be written (default 0)
            data_type: JavaScript typed array type (default "Float64Array")

        Example:
            # Update points 10-12 of a PolyData
            trail_id = view.get_instance_id(trail_polydata)
            point_data = np.array([[x1,y1,z1], [x2,y2,z2]], dtype=np.float64).tobytes()
            view.update_array_region(
                instance_id=trail_id,
                array_path="points",
                data=point_data,
                offset=10 * 3,  # 10 points * 3 components
            )
        """
        if not self.server.protocol:
            return

        if not self._initial_sync_done:
            self.request_resync()

        if isinstance(data, bytes):
            data = base64.b64encode(data).decode("ascii")

        self.server.protocol.publish(
            "trame.vtk.array.partial",
            {
                "instanceId": instance_id,
                "arrayPath": array_path,
                "offset": offset,
                "data": data,
                "dataType": data_type,
            },
        )


__all__ = ["VtkJsSharedView"]
