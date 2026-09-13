"""Glyphs that keep a constant on-screen size.

Marking a ``vtkGlyph3DMapper`` makes the translator emit a ``distanceToCamera``
block. Before each paint the client writes a per-point scale array into the
mapper's input so every glyph spans ``screen_px`` CSS pixels at its current
depth. The server never computes that scale, so the mapper reads its glyph
centers directly and no ``vtkDistanceToCamera`` filter sits in the pipeline.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, SupportsFloat, TypedDict, cast

from trame_vtklocal.module.feature_blocks import get_block, set_block

if TYPE_CHECKING:
    from vtkmodules.vtkCommonCore import vtkObjectBase
    from vtkmodules.vtkRenderingCore import vtkGlyph3DMapper

SCREEN_SIZE_GLYPHS_BLOCK = "distanceToCamera"
DEFAULT_SCALE_ARRAY = "DistanceToCamera"


class ScreenSizeGlyphsConfig(TypedDict):
    arrayName: str
    screenSize: float


def mark_screen_size_glyphs(
    mapper: vtkGlyph3DMapper,
    screen_px: SupportsFloat,
    array_name: str = DEFAULT_SCALE_ARRAY,
) -> ScreenSizeGlyphsConfig:
    """Scale ``mapper``'s glyphs on the client to ``screen_px`` CSS pixels."""
    screen_size = float(screen_px)
    if not math.isfinite(screen_size) or screen_size <= 0:
        raise ValueError("screen_px must be positive and finite")
    if not array_name:
        raise ValueError("array_name is required")
    mapper.SetScaleArray(array_name)
    mapper.SetScaleModeToScaleByMagnitude()
    mapper.ScalingOn()
    config: ScreenSizeGlyphsConfig = {
        "arrayName": array_name,
        "screenSize": screen_size,
    }
    set_block(mapper, SCREEN_SIZE_GLYPHS_BLOCK, config)
    return config


def clear_screen_size_glyphs(mapper: vtkGlyph3DMapper) -> None:
    set_block(mapper, SCREEN_SIZE_GLYPHS_BLOCK, None)


def screen_size_glyphs_config(
    mapper: vtkObjectBase,
) -> ScreenSizeGlyphsConfig | None:
    return cast(
        "ScreenSizeGlyphsConfig | None", get_block(mapper, SCREEN_SIZE_GLYPHS_BLOCK)
    )
