from trame_vtklocal.widgets.vtkjs_base import VtkJsBaseView


class VtkJsLocalView(VtkJsBaseView):
    _ref_prefix = "_vtkjslocalview"

    def __init__(self, render_window, **kwargs):
        super().__init__("vtk-js-local", render_window, **kwargs)
        self._configure_push()


__all__ = ["VtkJsLocalView"]
