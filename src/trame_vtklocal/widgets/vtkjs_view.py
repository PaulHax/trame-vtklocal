from trame_vtklocal.widgets.vtkjs_base import VtkJsBaseView
from trame_vtklocal.widgets.push_sync import PushSync


class VtkJsLocalView(VtkJsBaseView):
    _ref_prefix = "_vtkjslocalview"

    def __init__(self, render_window, sync_mode="pull", **kwargs):
        super().__init__("vtk-js-local", render_window, **kwargs)
        self._sync_mode = sync_mode
        self._push_sync = None

        self._attr_names += [
            ("interactor_settings", "interactorSettings"),
        ]
        self._attributes["sync_mode"] = f'sync-mode="{sync_mode}"'
        self._event_names += [
            "updated",
            "camera",
        ]

        if sync_mode == "push":
            self._push_sync = PushSync(
                self.server,
                self.object_manager,
                self._get_vtkjs_state,
                self.get_instance_id,
                api=self.api,
            )
            self.api.register_push_sent_hashes(self._push_sync._sent_hashes)

    def update(self, push_camera=False, **kwargs):
        if self._sync_mode == "push":
            # _get_vtkjs_state() already calls Render() + UpdateStatesFromObjects()
            self._push_sync.update()
        else:
            self._render_window.Render()
            self.api.update()
            self.server.js_call(self._ref, "update")

        if push_camera:
            self._push_camera()

    def mark_modified(self, vtk_object, array_path, start=0, count=None, data=None, data_type=None):
        if self._push_sync:
            self._push_sync.mark_modified(vtk_object, array_path, start, count, data, data_type)

    def request_resync(self, extra=None):
        if self._push_sync:
            self._collection_tracker.clear()
            self._push_sync.request_resync(extra)

    def _push_camera(self):
        renderer = self._render_window.GetRenderers().GetFirstRenderer()
        if not renderer:
            return
        cam = renderer.GetActiveCamera()
        if not cam:
            return
        params = {
            "position": list(cam.GetPosition()),
            "focalPoint": list(cam.GetFocalPoint()),
            "viewUp": list(cam.GetViewUp()),
            "viewAngle": cam.GetViewAngle(),
            "parallelProjection": bool(cam.GetParallelProjection()),
            "parallelScale": cam.GetParallelScale(),
            "clippingRange": list(cam.GetClippingRange()),
        }
        self.server.js_call(self._ref, "setCamera", params)

    def reset_camera(self):
        self.server.js_call(self._ref, "resetCamera")


__all__ = ["VtkJsLocalView"]
