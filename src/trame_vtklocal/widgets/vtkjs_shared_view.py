import weakref

from trame_vtklocal.widgets.vtkjs_base import VtkJsBaseView


class VtkJsSharedView(VtkJsBaseView):
    _ref_prefix = "_vtkjssharedview"
    _shared_views = weakref.WeakValueDictionary()

    def __init__(self, render_window, sync_mode="push", **kwargs):
        super().__init__("vtk-js-shared", render_window, **kwargs)

        self._view_id = str(self._window_id)

        self._configure_sync_mode(sync_mode)

        VtkJsSharedView._shared_views[self._view_id] = self

    def update(self, extra=None):
        self._update_view(extra=extra)

    def render_shared(self, options=None, **kwargs):
        self.server.js_call(self._ref, "renderShared", options or {})

    def on_render_requested(self, callback_name, **kwargs):
        self.server.js_call(self._ref, "onRenderRequested", callback_name)


__all__ = ["VtkJsSharedView"]
