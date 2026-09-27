from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import TYPE_CHECKING, TypeVar
from wslink import register as _wslink_register
from wslink.websocket import LinkProtocol

from vtkmodules.vtkSerializationManager import vtkObjectManager

from trame_vtklocal.module.push_views import PushViewRegistry

if TYPE_CHECKING:
    from trame_vtklocal.host_types import LinkProtocolRoot, ProtocolHostServer
    from trame_vtklocal.wire import ResyncPayload

_RpcT = TypeVar("_RpcT")


def export_rpc(name: str) -> Callable[[_RpcT], _RpcT]:
    """``wslink.register``, which marks and returns the decorated function."""
    decorate: Callable[[_RpcT], _RpcT] = _wslink_register(name)
    return decorate


# wslink ships no type information, so its base class is untyped here.
class ObjectManagerAPI(PushViewRegistry, LinkProtocol):  # type: ignore[misc, no-any-unimported]
    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)
        self.vtk_object_manager = vtkObjectManager()
        self.vtk_object_manager.Initialize()
        self._init_push_views()

    @export_rpc("scene.resync")
    def scene_resync(
        self, rw_id: int | str, known_refs: Iterable[str] | None = None
    ) -> ResyncPayload:
        """Full scene snapshot for the requesting client (push sync v2).

        Returns ``{"v": 2, "rw", "seq", "root", "nodes", "blobs"}`` where
        ``blobs`` inlines content only for live refs missing from the
        client-reported ``known_refs``. The server keeps no per-client state:
        the snapshot is a read of the publisher's scene store.
        """
        rw_id = int(rw_id)
        publisher = self._push_views.get(rw_id)
        if publisher is None:
            raise RuntimeError(f"No registered publisher for render window {rw_id}")
        return publisher.resync(known_refs)


class ObjectManagerHelper:
    def __init__(self, trame_server: ProtocolHostServer) -> None:
        self.trame_server = trame_server
        self.root_protocol: LinkProtocolRoot | None = None
        self.api = ObjectManagerAPI()
        self.trame_server.add_protocol_to_configure(self.configure_protocol)

    def configure_protocol(self, protocol: LinkProtocolRoot) -> None:
        self.root_protocol = protocol
        self.root_protocol.registerLinkProtocol(self.api)
