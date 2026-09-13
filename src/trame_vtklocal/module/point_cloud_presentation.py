"""Direct ``vtkPointGaussianMapper`` presentation translation helpers."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Literal, SupportsFloat, TypedDict, cast

from trame_vtklocal.module.feature_blocks import get_block, set_block

if TYPE_CHECKING:
    from vtkmodules.vtkCommonCore import vtkObjectBase
    from vtkmodules.vtkRenderingCore import vtkMapper

POINT_CLOUD_PRESENTATION_BLOCK = "pointCloudPresentation"


class PointCloudPresentationConfig(TypedDict):
    mode: Literal["fixed"]
    diameterCssPx: float


def _is_positive_finite(value: float) -> bool:
    return math.isfinite(value) and value > 0


def mark_point_cloud_presentation(
    mapper: vtkMapper, *, diameter_css_px: SupportsFloat
) -> PointCloudPresentationConfig:
    """Attach fixed CSS-pixel point sizing to a direct point-cloud mapper."""
    diameter = float(diameter_css_px)
    if not _is_positive_finite(diameter):
        raise ValueError("diameter_css_px must be positive and finite")
    config: PointCloudPresentationConfig = {"mode": "fixed", "diameterCssPx": diameter}
    set_block(mapper, POINT_CLOUD_PRESENTATION_BLOCK, config)
    return config


def clear_point_cloud_presentation(mapper: vtkMapper) -> None:
    set_block(mapper, POINT_CLOUD_PRESENTATION_BLOCK, None)


def point_cloud_presentation_config(
    mapper: vtkObjectBase,
) -> PointCloudPresentationConfig | None:
    return cast(
        "PointCloudPresentationConfig | None",
        get_block(mapper, POINT_CLOUD_PRESENTATION_BLOCK),
    )
