"""Message shapes on the wslink wire, and the push sync v2 seams between the
publisher and its RPC host.

VTK-free like :mod:`trame_vtklocal.store`, whose node and op shapes the
messages carry, so both ``module/`` and ``widgets/`` may import it.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import TYPE_CHECKING, Protocol, TypedDict, final

if TYPE_CHECKING:
    from vtkmodules.vtkSerializationManager import vtkObjectManager

    from trame_vtklocal.store import SceneNode, SceneOp, WirePayload


class _SceneCommandFields(TypedDict):
    name: str
    payload: object


class SceneCommand(_SceneCommandFields, total=False):
    render: bool


class _OpsMessageFields(TypedDict):
    v: int
    rw: str
    baseSeq: int
    seq: int
    ops: list[SceneOp]
    blobs: dict[str, WirePayload]


@final
class OpsMessage(_OpsMessageFields, total=False):
    """One ``scene.ops`` broadcast."""

    commands: list[SceneCommand]


class _ResyncPayloadFields(TypedDict):
    v: int
    rw: str
    seq: int
    root: str
    nodes: dict[str, SceneNode]
    blobs: dict[str, WirePayload]


@final
class ResyncPayload(_ResyncPayloadFields, total=False):
    """One ``scene.resync`` reply."""

    commands: list[SceneCommand]


class OpsPublisher(Protocol):
    """The wslink root protocol's broadcast entry point."""

    def publish(self, topic: str, data: OpsMessage, /) -> object: ...


class PushView(Protocol):
    """The publisher serving one render window's ``scene.resync``."""

    def resync(self, known_refs: Iterable[str] | None = None) -> ResyncPayload: ...


class PushViewHost(Protocol):
    """What a publisher needs from the object-manager API that hosts it."""

    @property
    def vtk_object_manager(self) -> vtkObjectManager: ...

    def register_push_view(self, rw_id: int, publisher: PushView, /) -> object: ...

    def unregister_push_view(self, rw_id: int, /) -> object: ...


class ObjectStatus(TypedDict):
    """The ``vtklocal.get.status`` reply for one root object."""

    ids: list[tuple[int, int]]
    hashes: Sequence[str]
    ignore_ids: list[int]
    cameras: list[int]
    force_push: list[int]
    interactor: int | None
