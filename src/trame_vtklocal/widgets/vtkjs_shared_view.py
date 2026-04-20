import weakref

from trame_vtklocal.widgets.vtkjs_base import VtkJsBaseView


class VtkJsSharedView(VtkJsBaseView):
    _ref_prefix = "_vtkjssharedview"
    _shared_views = weakref.WeakValueDictionary()

    def __init__(self, render_window, sync_mode="push", **kwargs):
        super().__init__("vtk-js-shared", render_window, **kwargs)

        self._view_id = str(self._window_id)

        self._event_names += [
            "updated",
            ("view_state_change", "viewStateChange"),
            ("on_ready", "onReady"),
            ("before_scene_loaded", "beforeSceneLoaded"),
            ("after_scene_loaded", "afterSceneLoaded"),
        ]

        self._attributes["sync_mode"] = f'sync-mode="{sync_mode}"'

        self._init_push_sync(sync_mode)

        VtkJsSharedView._shared_views[self._view_id] = self

    def update(self, extra=None):
        if self._sync_mode == "push":
            self._push_sync.update(extra=extra)
        else:
            self._render_window.Render()
            self.api.update()
            self.server.js_call(self._ref, "update")

    def render_shared(self, options=None, **kwargs):
        self.server.js_call(self._ref, "renderShared", options or {})

    def on_render_requested(self, callback_name, **kwargs):
        self.server.js_call(self._ref, "onRenderRequested", callback_name)

    def set_camera(self, params):
        self.server.js_call(self._ref, "setCamera", params)

    def reset_camera(self):
        self.server.js_call(self._ref, "resetCamera")

    def get_renderer(self):
        renderers = self._render_window.GetRenderers()
        if renderers.GetNumberOfItems() > 0:
            return renderers.GetItemAsObject(0)
        return None


__all__ = ["VtkJsSharedView"]
