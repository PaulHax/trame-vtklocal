from trame_vtklocal.widgets.vtkjs_base import VtkJsBaseView


class VtkJsSharedView(VtkJsBaseView):
    _ref_prefix = "_vtkjssharedview"

    def __init__(self, render_window, **kwargs):
        super().__init__("vtk-js-shared", render_window, **kwargs)
        self._configure_push()


__all__ = ["VtkJsSharedView"]
