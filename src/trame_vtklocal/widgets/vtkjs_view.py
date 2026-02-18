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

    def update(self):
        self._render_window.Render()
        self.api.update()
        self.server.js_call(self._ref, "update")

    def push_camera(self):
        """Push server camera state to client."""
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

    def render(self):
        self.server.js_call(self._ref, "render")

    def resize(self):
        self.server.js_call(self._ref, "resize")


__all__ = ["VtkJsLocalView"]
