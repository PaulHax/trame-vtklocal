"""
VtkJsSharedView widget for rendering VTK scenes using vtk.js with a shared WebGL context.

This enables integration with other WebGL libraries like MapLibre, Three.js, etc.
The external library owns the WebGL context and VTK renders into it.
"""

import base64
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

        if not self.server.protocol:
            return

        full_state = self._get_vtkjs_state()
        _inline_arrays(full_state, self.object_manager, self._sent_hashes)
        if extra:
            full_state.setdefault("extra", {}).update(extra)

        self.server.protocol.publish("trame.vtk.delta", full_state)

    def update(self, inline_arrays=False, extra=None, **kwargs):
        """
        Push geometry updates to client via delta channel.

        Args:
            inline_arrays: If True, inline array content in the state.
                Uses hash tracking to skip arrays already sent to client.
            extra: Optional dict to include in state (e.g., orbitCamera for MapLibre).
        """
        if not self.server.protocol:
            return

        delta_state = self._get_vtkjs_state()
        if inline_arrays:
            _inline_arrays(delta_state, self.object_manager, self._sent_hashes)
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


__all__ = ["VtkJsSharedView"]
