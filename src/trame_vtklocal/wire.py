"""Push sync v2 message shapes shared by the publisher and its RPC host.

VTK-free like :mod:`trame_vtklocal.store`, whose node and op shapes the
messages carry, so both ``module/`` and ``widgets/`` may import it.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Optional, Protocol, TypedDict, TypeVar, final

if TYPE_CHECKING:
    from trame_vtklocal.store import SceneNode, SceneOp, WirePayload

# A ``scene.resync`` observer; it receives the requesting wslink client id.
ResyncCallbackT = TypeVar("ResyncCallbackT", bound=Callable[[Optional[str]], object])


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
