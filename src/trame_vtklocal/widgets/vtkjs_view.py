from __future__ import annotations

from typing import TYPE_CHECKING

from trame_vtklocal.widgets.vtkjs_base import VtkJsBaseView

if TYPE_CHECKING:
    from vtkmodules.vtkRenderingCore import vtkRenderWindow

    from trame_vtklocal.widgets.vtkjs_base import (
        Tiles3DQualityPolicy,
        Tiles3DTexturePolicy,
    )


class VtkJsLocalView(VtkJsBaseView):
    _ref_prefix = "_vtkjslocalview"

    def __init__(
        self,
        render_window: vtkRenderWindow,
        *,
        tiles3d_texture_policy: Tiles3DTexturePolicy = "auto",
        tiles3d_quality_policy: Tiles3DQualityPolicy = "adaptive",
        **kwargs: object,
    ) -> None:
        super().__init__(
            "vtk-js-local",
            render_window,
            tiles3d_texture_policy=tiles3d_texture_policy,
            tiles3d_quality_policy=tiles3d_quality_policy,
            **kwargs,
        )
        self._configure_push()
        # A standalone view starts from the server's framing; its own
        # interactor owns the camera from there.
        self.set_camera()


__all__ = ["VtkJsLocalView"]
