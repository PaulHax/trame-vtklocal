from trame_vtklocal.widgets.vtkjs_base import VtkJsBaseView


class VtkJsLocalView(VtkJsBaseView):
    _ref_prefix = "_vtkjslocalview"

    def __init__(self, render_window, **kwargs):
        super().__init__("vtk-js-local", render_window, **kwargs)
        self._attr_names += [
            ("interactor_settings", "interactorSettings"),
        ]
        self._event_names += [
            "updated",
            "camera",
        ]

    def update(self, push_camera=False, **kwargs):
        self._render_window.Render()
        self.api.update()
        self.server.js_call(self._ref, "update")
        if push_camera:
            self._push_camera()

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
