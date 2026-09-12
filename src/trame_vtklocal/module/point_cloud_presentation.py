"""Direct ``vtkPointGaussianMapper`` presentation translation helpers."""

from __future__ import annotations

import math
import weakref
from typing import TYPE_CHECKING, Literal, SupportsFloat, TypedDict

if TYPE_CHECKING:
    from vtkmodules.vtkCommonCore import vtkObjectBase
    from vtkmodules.vtkRenderingCore import vtkMapper

POINT_CLOUD_PRESENTATION_BLOCK = "pointCloudPresentation"


class PointCloudPresentationConfig(TypedDict):
    mode: Literal["fixed"]
    diameterCssPx: float


_PRESENTATION_CONFIGS: weakref.WeakKeyDictionary[
    vtkObjectBase, PointCloudPresentationConfig
] = weakref.WeakKeyDictionary()


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
    _PRESENTATION_CONFIGS[mapper] = config
    mapper.Modified()
    return config


def clear_point_cloud_presentation(mapper: vtkMapper) -> None:
    if _PRESENTATION_CONFIGS.pop(mapper, None) is not None:
        mapper.Modified()


def point_cloud_presentation_config(
    mapper: vtkObjectBase,
) -> PointCloudPresentationConfig | None:
    config = _PRESENTATION_CONFIGS.get(mapper)
    return config.copy() if config else None
