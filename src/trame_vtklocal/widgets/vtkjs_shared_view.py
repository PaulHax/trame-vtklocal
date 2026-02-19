from trame_vtklocal.widgets.vtkjs_base import VtkJsBaseView
from trame_vtklocal.widgets.push_sync import PushSync


class VtkJsSharedView(VtkJsBaseView):
    _ref_prefix = "_vtkjssharedview"
    _shared_views = {}

    def __init__(self, render_window, sync_mode="push", debug_arrays=False, **kwargs):
        super().__init__("vtk-js-shared", render_window, **kwargs)

        self._view_id = str(self._window_id)
        self._sync_mode = sync_mode
        self._inline_array_cache = {}
        self._debug_arrays = debug_arrays
        self._push_sync = None

        self._event_names += [
            "updated",
            ("view_state_change", "viewStateChange"),
            ("on_ready", "onReady"),
            ("before_scene_loaded", "beforeSceneLoaded"),
            ("after_scene_loaded", "afterSceneLoaded"),
        ]

        self._attributes["sync_mode"] = f'sync-mode="{sync_mode}"'

        if sync_mode == "push":
            self._push_sync = PushSync(
                self.server,
                self.object_manager,
                self._get_vtkjs_state,
                self.get_instance_id,
            )
            self.server.controller.on_client_connected.add(self._push_sync.on_client_connected)

        VtkJsSharedView._shared_views[self._view_id] = self

    def request_resync(self, extra=None):
        if self._push_sync:
            self._push_sync.request_resync(extra)

    def mark_modified(self, vtk_object, array_path, start=0, count=None, data=None, data_type=None):
        if self._push_sync:
            self._push_sync.mark_modified(vtk_object, array_path, start, count, data, data_type)

    def update(self, inline_arrays=False, extra=None, push_pending=True, **kwargs):
        if self._sync_mode == "push":
            self._push_sync.update(inline_arrays=inline_arrays, extra=extra, push_pending=push_pending)
        else:
            self._render_window.Render()
            self.api.update()
            self.server.js_call(self._ref, "update")

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
