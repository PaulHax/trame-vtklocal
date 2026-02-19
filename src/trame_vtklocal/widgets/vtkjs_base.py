import numpy as np
from trame_client.widgets.core import AbstractElement
from trame_vtklocal import module


class HtmlElement(AbstractElement):
    def __init__(self, _elem_name, children=None, **kwargs):
        super().__init__(_elem_name, children, **kwargs)
        if self.server:
            kwargs.pop("trame_server", None)
            self.server.enable_module(module, **kwargs)


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

    def get_blob_bytes(hash_str):
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

            return np.array(result, dtype=np.uint32).tobytes()

        return bytes(object_manager.GetBlob(hash_str))

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
                content = get_blob_bytes(data_hash)
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


class VtkJsBaseView(HtmlElement):
    _next_id = 0
    _ref_prefix = "_vtkjsview"

    def __init__(self, _elem_name, render_window, **kwargs):
        super().__init__(_elem_name, **kwargs)

        self._ref = kwargs.get("ref")
        if self._ref is None:
            VtkJsBaseView._next_id += 1
            self._ref = f"{self._ref_prefix}_{VtkJsBaseView._next_id}"

        self._render_window = render_window
        self._window_id = self.object_manager.RegisterObject(render_window)
        render_window.Render()
        self.object_manager.UpdateStatesFromObjects()

        self._attributes["rw_id"] = f':render-window="{self._window_id}"'
        self._attributes["ref"] = f'ref="{self._ref}"'

    @property
    def api(self):
        return module.get_helper(self.server).api

    @property
    def object_manager(self):
        return self.api.vtk_object_manager

    @property
    def ref_name(self):
        return self._ref

    def _get_vtkjs_state(self):
        from trame_vtklocal.module.vtkjs_translator import translate_scene

        self._render_window.Render()
        self.object_manager.UpdateStatesFromObjects()
        return translate_scene(self.object_manager, self._window_id)

    def get_instance_id(self, vtk_object):
        vtk_id = self.object_manager.GetId(vtk_object)
        return str(vtk_id)
