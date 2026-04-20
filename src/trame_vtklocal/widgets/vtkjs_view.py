from trame_vtklocal.widgets.vtkjs_base import VtkJsBaseView


class VtkJsLocalView(VtkJsBaseView):
    _ref_prefix = "_vtkjslocalview"
    # Local push-mode scenes are small and can legitimately move identical array
    # payloads between different objects across updates (for example, selected
    # versus normal overlay actors). Always inlining arrays avoids hash-cache
    # reuse bugs on those full updates.
    _always_inline_arrays = True

    def __init__(self, render_window, sync_mode="pull", **kwargs):
        super().__init__("vtk-js-local", render_window, **kwargs)

        self._attr_names += [
            ("interactor_settings", "interactorSettings"),
        ]
        self._attributes["sync_mode"] = f'sync-mode="{sync_mode}"'
        self._event_names += [
            "updated",
            "camera",
            ("view_state_change", "viewStateChange"),
            ("on_ready", "onReady"),
            ("before_scene_loaded", "beforeSceneLoaded"),
            ("after_scene_loaded", "afterSceneLoaded"),
        ]

        self._init_push_sync(sync_mode)

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

    def set_camera(self, params):
        self.server.js_call(self._ref, "setCamera", params)


__all__ = ["VtkJsLocalView"]
