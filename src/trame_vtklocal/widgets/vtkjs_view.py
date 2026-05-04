from trame_vtklocal.widgets.vtkjs_base import VtkJsBaseView


class VtkJsLocalView(VtkJsBaseView):
    _ref_prefix = "_vtkjslocalview"

    def __init__(self, render_window, sync_mode="push", **kwargs):
        super().__init__("vtk-js-local", render_window, **kwargs)

        self._attr_names += [
            ("interactor_settings", "interactorSettings"),
        ]
        self._configure_sync_mode(sync_mode, extra_event_names=["camera"])

    def update(self, push_camera=False, **kwargs):
        self._update_view()

        if push_camera:
            self._push_camera()


__all__ = ["VtkJsLocalView"]
