"""vtkProjectedTextureMapper translation helpers.

Marking a server-side mapper makes the translator emit its serialized node
with type "vtkProjectedTextureMapper" plus the projected-texture props, so the
client builds the fork's projective-texturing mapper subclass. The texture
pixels never ride this channel: the client stages them per view via
uploadTexture(key, source) and the mapper resolves them by textureKey at
render time.
"""

from __future__ import annotations

import weakref
from collections.abc import Iterable
from typing import TYPE_CHECKING, Final, Literal, SupportsFloat, TypedDict

if TYPE_CHECKING:
    from vtkmodules.vtkCommonCore import vtkObjectBase
    from vtkmodules.vtkRenderingCore import vtkMapper

ProjectedTextureMode = Literal["homography", "worldToClip"]

PROJECTED_TEXTURE_TYPE: Final = "vtkProjectedTextureMapper"
MODE_HOMOGRAPHY: Final = "homography"
MODE_WORLD_TO_CLIP: Final = "worldToClip"
MODES: tuple[ProjectedTextureMode, ...] = (MODE_HOMOGRAPHY, MODE_WORLD_TO_CLIP)


class _ProjectedTextureConfigRequired(TypedDict):
    textureKey: str
    mode: ProjectedTextureMode


class ProjectedTextureConfig(_ProjectedTextureConfigRequired, total=False):
    homographyArrayName: str
    homography: list[float]
    worldToClip: list[float]


_MAPPER_CONFIGS: weakref.WeakKeyDictionary[vtkObjectBase, ProjectedTextureConfig] = (
    weakref.WeakKeyDictionary()
)


def _as_matrix(
    value: Iterable[SupportsFloat] | None, size: int, name: str
) -> list[float] | None:
    if value is None:
        return None
    matrix = [float(v) for v in value]
    if len(matrix) != size:
        raise ValueError(f"{name} must have {size} values, got {len(matrix)}")
    return matrix


def mark_projected_texture(
    mapper: vtkMapper,
    texture_key: str,
    mode: ProjectedTextureMode = MODE_HOMOGRAPHY,
    homography_array_name: str | None = None,
) -> ProjectedTextureConfig:
    """Mark a mapper to translate as a projected-texture mapper.

    mode "homography" samples through a mat3 on model XY (from the
    ``homography`` matrix, or an input field-data array named
    ``homography_array_name`` — client default "HomographyInverse"); mode
    "worldToClip" samples through a mat4 camera projection on model XYZ.
    """
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}, got {mode!r}")
    if not texture_key:
        raise ValueError("texture_key is required")

    config: ProjectedTextureConfig = {
        "textureKey": str(texture_key),
        "mode": mode,
    }
    if homography_array_name:
        config["homographyArrayName"] = str(homography_array_name)

    previous = _MAPPER_CONFIGS.get(mapper)
    if previous:
        for key in ("homography", "worldToClip"):
            if key in previous:
                config[key] = previous[key]

    _MAPPER_CONFIGS[mapper] = config
    mapper.Modified()
    return config


def set_projected_texture_matrix(
    mapper: vtkMapper,
    homography: Iterable[SupportsFloat] | None = None,
    world_to_clip: Iterable[SupportsFloat] | None = None,
) -> ProjectedTextureConfig:
    """Update the marked mapper's projection matrix (column-major values)."""
    config = _MAPPER_CONFIGS.get(mapper)
    if config is None:
        raise ValueError("mapper is not marked with mark_projected_texture")

    updated = False
    matrix = _as_matrix(homography, 9, "homography")
    if matrix is not None:
        config["homography"] = matrix
        updated = True
    matrix = _as_matrix(world_to_clip, 16, "world_to_clip")
    if matrix is not None:
        config["worldToClip"] = matrix
        updated = True

    if updated:
        # The config rides the mapper's serialized state; bump its MTime so
        # the push sync emits a delta for this mapper.
        mapper.Modified()
    return config


def projected_texture_config(mapper: vtkObjectBase) -> ProjectedTextureConfig | None:
    config = _MAPPER_CONFIGS.get(mapper)
    return config.copy() if config else None
