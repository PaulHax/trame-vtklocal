"""JSON shapes of the ``streamedScene`` feature block.

:func:`trame_vtklocal.streamed_scene.source_block` builds these from a
validated source; the client reads them back from the scene node.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal, TypedDict, Union

if TYPE_CHECKING:
    from typing_extensions import ReadOnly

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


class AdaptiveOptionsDraft(TypedDict, total=False):
    minBudget: int
    maxBudget: int
    interactionTargetMs: float
    stationaryTargetMs: float


class SourceBlockCommon(TypedDict):
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


class PointCloudSourceBlock(SourceBlockCommon):
    kind: Literal["pointCloud"]
    pointCloud: PointCloudBlock


class _Tiles3DBlockRequired(TypedDict):
    tilesetToScene: list[float]
    verticalExaggeration: float
    verticalPivotZ: float
    geometricErrorScale: GeometricErrorScale


class Tiles3DBlock(_Tiles3DBlockRequired, total=False):
    maximumScreenSpaceErrorPx: float
    opacity: float
    textureBlend: float
    overlayOrder: int


class Tiles3DSourceBlock(SourceBlockCommon):
    kind: Literal["tiles3d"]
    tiles3d: Tiles3DBlock


StreamedSceneBlock = Union[PointCloudSourceBlock, Tiles3DSourceBlock]
