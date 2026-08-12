"""Direct ``vtkPointGaussianMapper`` presentation translation helpers."""

import math
import weakref

POINT_CLOUD_PRESENTATION_BLOCK = "pointCloudPresentation"

_PRESENTATION_CONFIGS = weakref.WeakKeyDictionary()


def _is_positive_finite(value):
    return math.isfinite(value) and value > 0


def mark_point_cloud_presentation(mapper, *, diameter_css_px):
    """Attach fixed CSS-pixel point sizing to a direct point-cloud mapper."""
    diameter = float(diameter_css_px)
    if not _is_positive_finite(diameter):
        raise ValueError("diameter_css_px must be positive and finite")
    config = {"mode": "fixed", "diameterCssPx": diameter}
    _PRESENTATION_CONFIGS[mapper] = config
    mapper.Modified()
    return config


def clear_point_cloud_presentation(mapper):
    if _PRESENTATION_CONFIGS.pop(mapper, None) is not None:
        mapper.Modified()


def point_cloud_presentation_config(mapper):
    config = _PRESENTATION_CONFIGS.get(mapper)
    return dict(config) if config else None
