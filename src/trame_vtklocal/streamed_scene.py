"""Public server-side seam for HTTP-streamed scene members.

``StreamedSceneActor`` is a normal VTK actor for scene membership, transforms,
and visibility.  Its source descriptor becomes one ``streamedScene`` feature
block; the actor deliberately has no mapper on the wire.
"""

from __future__ import annotations

import math
from numbers import Real
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, NoReturn, TypedDict, Union

from vtkmodules.vtkRenderingCore import vtkActor

from trame_vtklocal.module.streamed_scene_registry import (
    _register_actor,
    _registered_source,
    _registration_for_actor,
    _update_registered_source,
)

if TYPE_CHECKING:
    from typing_extensions import ReadOnly

STREAMED_SCENE_TYPE = "vtkStreamedSceneActor"
STREAMED_SCENE_BLOCK = "streamedScene"

# Mirrored from pointcloud-lod's adaptive governor.  verify_chain.py checks the
# copy against the linked library source.
DEFAULT_ADAPTIVE_MIN_BUDGET = 200_000

# The one tolerance rule for a column-major affine matrix on the wire, owned
# here because this is where a matrix becomes a published payload.  The fixed
# entries are exact constants, so the band is absolute, not relative: an entry
# is accepted when ``abs(value - expected) <= AFFINE_ENTRY_ABS_TOL``.  The
# client boundary re-checks arriving payloads with the same numbers -- see
# AFFINE_ENTRY_ABS_TOL in vue-components/src/components/streamedSceneHost.js.
AFFINE_ENTRY_ABS_TOL = 1e-12
AFFINE_FIXED_ENTRIES = ((3, 0.0), (7, 0.0), (11, 0.0), (15, 1.0))
# A linear block this close to singular has no usable inverse for picking.
AFFINE_DETERMINANT_FLOOR = 1e-15

GeometricErrorScale = Literal["maximum", "horizontal"]


class FixedPresentation(TypedDict):
    mode: ReadOnly[Literal["fixed"]]
    diameterCssPx: ReadOnly[float]


class AutoPresentation(TypedDict):
    mode: ReadOnly[Literal["auto"]]
    userScale: ReadOnly[float]
    minDiameterCssPx: ReadOnly[float]
    maxDiameterCssPx: ReadOnly[float]


Presentation = Union[FixedPresentation, AutoPresentation]


class AdaptiveOptions(TypedDict, total=False):
    minBudget: ReadOnly[int]
    maxBudget: ReadOnly[int]
    interactionTargetMs: ReadOnly[float]
    stationaryTargetMs: ReadOnly[float]


class _AdaptiveOptionsDraft(TypedDict, total=False):
    minBudget: int
    maxBudget: int
    interactionTargetMs: float
    stationaryTargetMs: float


class _SourceBlockCommon(TypedDict):
    sourceAssetId: str
    revision: str
    endpoint: str


class _PointCloudBlockRequired(TypedDict):
    pointCount: int
    presentation: Presentation
    adaptive: bool


class PointCloudBlock(_PointCloudBlockRequired, total=False):
    adaptiveOptions: AdaptiveOptions
    pointBudget: int
    refinementCutoffPx: float


class PointCloudSourceBlock(_SourceBlockCommon):
    kind: Literal["pointCloud"]
    pointCloud: PointCloudBlock


class _Tiles3DBlockRequired(TypedDict):
    tilesetToScene: list[float]
    verticalExaggeration: float
    verticalPivotZ: float
    geometricErrorScale: GeometricErrorScale


class Tiles3DBlock(_Tiles3DBlockRequired, total=False):
    maximumScreenSpaceErrorPx: float


class Tiles3DSourceBlock(_SourceBlockCommon):
    kind: Literal["tiles3d"]
    tiles3d: Tiles3DBlock


StreamedSceneBlock = Union[PointCloudSourceBlock, Tiles3DSourceBlock]


class _FrozenDict(dict[str, object]):
    """A JSON-compatible mapping whose normalized values cannot be changed."""

    # Hashable despite dict's contract so frozen sources holding it stay hashable.
    def __hash__(self) -> int:  # type: ignore[override]
        return hash(tuple(sorted(self.items())))

    def _immutable(self, *_args: object, **_kwargs: object) -> NoReturn:
        raise TypeError("source configuration is immutable")

    __setitem__ = _immutable
    __delitem__ = _immutable
    clear = _immutable
    pop = _immutable
    popitem = _immutable
    setdefault = _immutable
    update = _immutable
    __ior__ = _immutable


def _is_positive_finite(value: float) -> bool:
    return math.isfinite(value) and value > 0


def _is_affine_entry(value: float, expected: float) -> bool:
    return abs(value - expected) <= AFFINE_ENTRY_ABS_TOL


def _as_presentation(value: object) -> Presentation:
    if not isinstance(value, dict):
        raise ValueError("presentation must be a Fixed or Auto object")
    mode = value.get("mode")
    if mode == "fixed":
        diameter = float(value["diameterCssPx"])
        if not _is_positive_finite(diameter):
            raise ValueError("Fixed diameterCssPx must be positive and finite")
        return {"mode": "fixed", "diameterCssPx": diameter}
    if mode == "auto":
        user_scale = float(value["userScale"])
        minimum = float(value["minDiameterCssPx"])
        maximum = float(value["maxDiameterCssPx"])
        if (
            not _is_positive_finite(user_scale)
            or not _is_positive_finite(minimum)
            or not _is_positive_finite(maximum)
            or minimum > maximum
        ):
            raise ValueError(
                "Auto scale and diameter clamps must be positive, finite and ordered"
            )
        return {
            "mode": "auto",
            "userScale": user_scale,
            "minDiameterCssPx": minimum,
            "maxDiameterCssPx": maximum,
        }
    raise ValueError("presentation mode must be 'fixed' or 'auto'")


def _as_adaptive_options(value: object) -> AdaptiveOptions:
    if not isinstance(value, dict):
        raise ValueError("adaptive_options must be an object")
    unknown = set(value) - {
        "minBudget",
        "maxBudget",
        "interactionTargetMs",
        "stationaryTargetMs",
    }
    if unknown:
        raise ValueError(f"unknown adaptive_options: {', '.join(sorted(unknown))}")

    options: _AdaptiveOptionsDraft = {}
    minimum = DEFAULT_ADAPTIVE_MIN_BUDGET
    if (raw := value.get("minBudget")) is not None:
        minimum = int(raw)
        if not minimum > 0:
            raise ValueError(f"minBudget must be > 0, got {minimum}")
        options["minBudget"] = minimum
    if (raw := value.get("maxBudget")) is not None:
        maximum = int(raw)
        if maximum < minimum:
            raise ValueError(
                f"maxBudget must be >= minBudget ({minimum}), got {maximum}"
            )
        options["maxBudget"] = maximum
    for key in ("interactionTargetMs", "stationaryTargetMs"):
        if (raw := value.get(key)) is not None:
            target = float(raw)
            if not _is_positive_finite(target):
                raise ValueError(f"{key} must be positive and finite, got {target}")
            options[key] = target
    return options


def _as_identity(value: object, name: str) -> str:
    text = str(value).strip() if value is not None else ""
    if not text:
        raise ValueError(f"{name} is required")
    return text


def _as_endpoint(value: object) -> str:
    if not value or str(value).endswith("/"):
        raise ValueError("endpoint is required and must not end with '/'")
    return str(value)


@dataclass(frozen=True)
class PointCloudSource:
    """Validated immutable configuration for one streamed point cloud."""

    source_asset_id: str
    revision: str
    endpoint: str
    point_count: int
    presentation: Presentation
    adaptive: bool = True
    adaptive_options: AdaptiveOptions | None = None
    point_budget: int | None = None
    refinement_cutoff_px: float | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "source_asset_id",
            _as_identity(self.source_asset_id, "source_asset_id"),
        )
        object.__setattr__(self, "revision", _as_identity(self.revision, "revision"))
        object.__setattr__(self, "endpoint", _as_endpoint(self.endpoint))

        point_count = int(self.point_count)
        if point_count < 0:
            raise ValueError(f"point_count must be >= 0, got {point_count}")
        object.__setattr__(self, "point_count", point_count)
        object.__setattr__(
            self, "presentation", _FrozenDict(_as_presentation(self.presentation))
        )
        object.__setattr__(self, "adaptive", bool(self.adaptive))

        if self.adaptive_options is not None:
            if not self.adaptive:
                raise ValueError("adaptive_options requires adaptive=True")
            object.__setattr__(
                self,
                "adaptive_options",
                _FrozenDict(_as_adaptive_options(self.adaptive_options)),
            )
        if self.point_budget is not None:
            point_budget = int(self.point_budget)
            if not point_budget > 0:
                raise ValueError(f"point_budget must be > 0, got {point_budget}")
            object.__setattr__(self, "point_budget", point_budget)
        if self.refinement_cutoff_px is not None:
            cutoff = float(self.refinement_cutoff_px)
            if not math.isfinite(cutoff):
                raise ValueError("refinement_cutoff_px must be finite")
            if cutoff < 0:
                raise ValueError(f"refinement_cutoff_px must be >= 0, got {cutoff}")
            object.__setattr__(self, "refinement_cutoff_px", cutoff)


@dataclass(frozen=True)
class Tiles3DSource:
    """Validated immutable configuration for one explicit 3D Tiles tree."""

    source_asset_id: str
    revision: str
    endpoint: str
    tileset_to_scene: tuple[float, ...]
    maximum_screen_space_error_px: float | None = None
    vertical_exaggeration: float = 1.0
    vertical_pivot_z: float = 0.0
    geometric_error_scale: GeometricErrorScale = "maximum"

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "source_asset_id",
            _as_identity(self.source_asset_id, "source_asset_id"),
        )
        object.__setattr__(self, "revision", _as_identity(self.revision, "revision"))
        object.__setattr__(self, "endpoint", _as_endpoint(self.endpoint))
        try:
            raw_matrix = tuple(self.tileset_to_scene)
        except TypeError as exc:
            raise ValueError("tileset_to_scene must contain 16 finite numbers") from exc
        if len(raw_matrix) != 16 or not all(
            isinstance(value, Real)
            and not isinstance(value, bool)
            and math.isfinite(value)
            for value in raw_matrix
        ):
            raise ValueError("tileset_to_scene must contain 16 finite numbers")
        matrix = tuple(float(value) for value in raw_matrix)
        if not all(
            _is_affine_entry(matrix[index], expected)
            for index, expected in AFFINE_FIXED_ENTRIES
        ):
            raise ValueError("tileset_to_scene must be a column-major affine transform")
        determinant = (
            matrix[0] * (matrix[5] * matrix[10] - matrix[9] * matrix[6])
            - matrix[4] * (matrix[1] * matrix[10] - matrix[9] * matrix[2])
            + matrix[8] * (matrix[1] * matrix[6] - matrix[5] * matrix[2])
        )
        if (
            not math.isfinite(determinant)
            or abs(determinant) <= AFFINE_DETERMINANT_FLOOR
        ):
            raise ValueError(
                "tileset_to_scene must have an invertible linear transform"
            )
        object.__setattr__(self, "tileset_to_scene", matrix)

        if self.maximum_screen_space_error_px is not None:
            if isinstance(self.maximum_screen_space_error_px, bool) or not isinstance(
                self.maximum_screen_space_error_px, Real
            ):
                raise ValueError(
                    "maximum_screen_space_error_px must be positive and finite"
                )
            maximum = float(self.maximum_screen_space_error_px)
            if not _is_positive_finite(maximum):
                raise ValueError(
                    "maximum_screen_space_error_px must be positive and finite"
                )
            object.__setattr__(self, "maximum_screen_space_error_px", maximum)

        if isinstance(self.vertical_exaggeration, bool) or not isinstance(
            self.vertical_exaggeration, (int, float)
        ):
            raise ValueError("vertical_exaggeration must be positive and finite")
        vertical_exaggeration = float(self.vertical_exaggeration)
        if not _is_positive_finite(vertical_exaggeration):
            raise ValueError("vertical_exaggeration must be positive and finite")
        object.__setattr__(self, "vertical_exaggeration", vertical_exaggeration)

        if isinstance(self.vertical_pivot_z, bool) or not isinstance(
            self.vertical_pivot_z, (int, float)
        ):
            raise ValueError("vertical_pivot_z must be finite")
        vertical_pivot_z = float(self.vertical_pivot_z)
        if not math.isfinite(vertical_pivot_z):
            raise ValueError("vertical_pivot_z must be finite")
        object.__setattr__(self, "vertical_pivot_z", vertical_pivot_z)

        if self.geometric_error_scale not in {"maximum", "horizontal"}:
            raise ValueError("geometric_error_scale must be 'maximum' or 'horizontal'")


_SOURCE_TYPES = (PointCloudSource, Tiles3DSource)

StreamedSource = Union[PointCloudSource, Tiles3DSource]


def _validate_source(source: object) -> StreamedSource:
    if not isinstance(source, _SOURCE_TYPES):
        raise TypeError("source must be a PointCloudSource or Tiles3DSource")
    return source


def _is_vtk_reconstitution(value: object) -> bool:
    return isinstance(value, str) and "_p_vtk" in value and value.endswith("Actor")


class StreamedSceneActor(vtkActor):
    """A mapper-free VTK actor carrying one immutable streamed source."""

    def __init__(self, source: StreamedSource) -> None:
        if _is_vtk_reconstitution(source):
            # VTK's stub omits the wrapped-pointer constructor argument.
            super().__init__(source)  # type: ignore[call-arg]
            registration = _registration_for_actor(self)
            if registration is None or not isinstance(
                registration.source, _SOURCE_TYPES
            ):
                raise RuntimeError(
                    "reconstituted StreamedSceneActor lost its streamed source"
                )
            self._source = registration.source
            return

        super().__init__()
        self._source = _validate_source(source)
        _register_actor(self, self._source)

    @property
    def source(self) -> StreamedSource:
        registered = _registered_source(self)
        return self._source if registered is None else registered

    @source.setter
    def source(self, source: StreamedSource) -> None:
        self._source = _validate_source(source)
        _update_registered_source(self, self._source)
        self.Modified()


def source_block(source: StreamedSource) -> StreamedSceneBlock:
    """Create the JSON-ready ``streamedScene`` block for a source."""
    common: _SourceBlockCommon = {
        "sourceAssetId": source.source_asset_id,
        "revision": source.revision,
        "endpoint": source.endpoint,
    }
    if isinstance(source, PointCloudSource):
        config: PointCloudBlock = {
            "pointCount": source.point_count,
            "presentation": source.presentation.copy(),
            "adaptive": source.adaptive,
        }
        if source.adaptive_options is not None:
            config["adaptiveOptions"] = source.adaptive_options.copy()
        if source.point_budget is not None:
            config["pointBudget"] = source.point_budget
        if source.refinement_cutoff_px is not None:
            config["refinementCutoffPx"] = source.refinement_cutoff_px
        return {"kind": "pointCloud", **common, "pointCloud": config}

    tiles3d_config: Tiles3DBlock = {
        "tilesetToScene": list(source.tileset_to_scene),
        "verticalExaggeration": source.vertical_exaggeration,
        "verticalPivotZ": source.vertical_pivot_z,
        "geometricErrorScale": source.geometric_error_scale,
    }
    if source.maximum_screen_space_error_px is not None:
        tiles3d_config["maximumScreenSpaceErrorPx"] = (
            source.maximum_screen_space_error_px
        )
    return {"kind": "tiles3d", **common, "tiles3d": tiles3d_config}
