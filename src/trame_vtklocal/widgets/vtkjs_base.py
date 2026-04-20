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

            sizes = np.diff(offsets).astype(np.uint32)
            conn_uint32 = connectivity.astype(np.uint32)
            # Build vtk.js cell array: [size, id0, id1, ..., size, id0, id1, ...]
            # Pre-allocate output: total = num_cells (sizes) + len(connectivity) (ids)
            result = np.empty(len(sizes) + len(conn_uint32), dtype=np.uint32)
            # Insert sizes at the correct positions using cumulative offsets
            cell_starts = np.arange(len(sizes), dtype=np.int64) + offsets[:-1]
            result[cell_starts] = sizes
            # Build mask for connectivity positions
            mask = np.ones(len(result), dtype=bool)
            mask[cell_starts] = False
            result[mask] = conn_uint32
            return result.tobytes()

        return bytes(object_manager.GetBlob(hash_str))

    current_hashes = set()

    def walk(node):
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return

        data_hash = node.get("hash")
        if data_hash and node.get("dataType") and "content" not in node:
            current_hashes.add(data_hash)
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

    # Prune sent_hashes to only contain hashes in the current state.
    # Old hashes must be removed so they get re-inlined if they reappear,
    # since the client GC may have evicted them from its cache.
    if sent_hashes is not None:
        sent_hashes &= current_hashes


class VtkJsBaseView(HtmlElement):
    _next_id = 0
    _ref_prefix = "_vtkjsview"
    # Full vtk.js push updates should be self-contained. Partial updates still
    # use the array fast path, but full deltas always inline arrays so payloads
    # can safely move between different scene objects across updates.
    _always_inline_arrays = True
    _scene_event_names = [
        "updated",
        ("view_state_change", "viewStateChange"),
        ("on_ready", "onReady"),
        ("before_scene_loaded", "beforeSceneLoaded"),
        ("after_scene_loaded", "afterSceneLoaded"),
    ]

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

        self._collection_tracker = {}
        self._push_sync = None

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
        return translate_scene(
            self.object_manager, self._window_id, self._collection_tracker
        )

    def get_instance_id(self, vtk_object):
        vtk_id = self.object_manager.GetId(vtk_object)
        return str(vtk_id)

    def _init_push_sync(self, sync_mode):
        from trame_vtklocal.widgets.push_sync import PushSync

        self._sync_mode = sync_mode
        if sync_mode == "push":
            self._push_sync = PushSync(
                self.server,
                self.object_manager,
                self._get_vtkjs_state,
                self.get_instance_id,
                self._window_id,
                always_inline_arrays=getattr(self, "_always_inline_arrays", False),
                api=self.api,
            )
            self.api.register_push_sent_hashes(self._push_sync._sent_hashes)

    def _configure_sync_mode(self, sync_mode, extra_event_names=None):
        self._attributes["sync_mode"] = f'sync-mode="{sync_mode}"'
        self._event_names += ["updated"]
        if extra_event_names:
            self._event_names += list(extra_event_names)
        self._event_names += self._scene_event_names[1:]
        self._init_push_sync(sync_mode)

    def _update_view(self, extra=None):
        if self._sync_mode == "push":
            self._push_sync.update(extra=extra)
            return

        self._render_window.Render()
        self.api.update()
        self.server.js_call(self._ref, "update")

    def get_renderer(self):
        renderers = self._render_window.GetRenderers()
        if renderers.GetNumberOfItems() > 0:
            return renderers.GetItemAsObject(0)
        return None

    def _push_camera(self):
        renderer = self.get_renderer()
        if not renderer:
            return
        cam = renderer.GetActiveCamera()
        if not cam:
            return
        self.set_camera(
            {
                "position": list(cam.GetPosition()),
                "focalPoint": list(cam.GetFocalPoint()),
                "viewUp": list(cam.GetViewUp()),
                "viewAngle": cam.GetViewAngle(),
                "parallelProjection": bool(cam.GetParallelProjection()),
                "parallelScale": cam.GetParallelScale(),
                "clippingRange": list(cam.GetClippingRange()),
            }
        )

    def reset_camera(self):
        self.server.js_call(self._ref, "resetCamera")

    def set_camera(self, params):
        self.server.js_call(self._ref, "setCamera", params)

    def mark_modified(self, vtk_object, array_path, start=0, count=None, data=None, data_type=None):
        if self._push_sync:
            self._push_sync.mark_modified(vtk_object, array_path, start, count, data, data_type)

    def flush(self):
        if self._push_sync:
            self._push_sync.flush()

    def request_resync(self, extra=None):
        if self._push_sync:
            self._collection_tracker.clear()
            self._push_sync.request_resync(extra)
