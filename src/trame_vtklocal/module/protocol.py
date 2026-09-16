from __future__ import annotations

import zipfile
import json
from collections.abc import Callable, Iterable, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, TypeVar
from wslink import register as _wslink_register
from wslink.websocket import LinkProtocol

from vtkmodules.vtkSerializationManager import vtkObjectManager
from vtkmodules.vtkCommonCore import vtkVersion

from trame_vtklocal.module.push_views import PushViewRegistry

if TYPE_CHECKING:
    from vtkmodules.vtkCommonCore import vtkObjectBase

    from trame_vtklocal.host_types import LinkProtocolRoot, ProtocolHostServer
    from trame_vtklocal.wire import ObjectStatus, ResyncPayload

try:
    import zlib  # noqa

    ZIP_COMPRESSION = zipfile.ZIP_DEFLATED
except ImportError:
    ZIP_COMPRESSION = zipfile.ZIP_STORED

_RpcT = TypeVar("_RpcT")


def export_rpc(name: str) -> Callable[[_RpcT], _RpcT]:
    """``wslink.register``, which marks and returns the decorated function."""
    decorate: Callable[[_RpcT], _RpcT] = _wslink_register(name)
    return decorate


def map_id_mtime(object_manager: vtkObjectManager, vtk_id: int) -> tuple[int, int]:
    vtk_obj = object_manager.GetObjectAtId(vtk_id)
    if vtk_obj is None:
        return (vtk_id, 0)
    return (vtk_id, vtk_obj.GetMTime())


# wslink ships no type information, so its base class is untyped here.
class ObjectManagerAPI(PushViewRegistry, LinkProtocol):  # type: ignore[misc, no-any-unimported]
    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)
        self.vtk_object_manager = vtkObjectManager()
        self.vtk_object_manager.Initialize()
        self._subscriptions: dict[int, int] = {}
        self._widgets: dict[int, set[int]] = {}
        self._last_publish_states: dict[int, int] = {}
        self._last_publish_hash: set[str] = set()
        self._push_camera = False
        self._init_push_views()

        self._debug_state = False
        self._debug_state_counter = 1

    def register_widget(self, root_obj: vtkObjectBase, dep_obj: vtkObjectBase) -> None:
        self.vtk_object_manager.RegisterObject(dep_obj)
        root_id = self.vtk_object_manager.GetId(root_obj)
        dep_id = self.vtk_object_manager.GetId(dep_obj)
        if root_id not in self._widgets:
            self._widgets[root_id] = set()

        self._widgets[root_id].add(dep_id)

    def unregister_widget(
        self, root_obj: vtkObjectBase, dep_obj: vtkObjectBase
    ) -> None:
        root_id = self.vtk_object_manager.GetId(root_obj)
        dep_id = self.vtk_object_manager.GetId(dep_obj)
        self.vtk_object_manager.UnRegisterObject(dep_id)
        if root_id in self._widgets:
            self._widgets[root_id].discard(dep_id)

    def get_all_ids(self, root_id: int) -> list[int]:
        if root_id in self._widgets:
            return [root_id, *self._widgets[root_id]]
        return [root_id]

    def update(
        self,
        push_camera: bool = False,
        obj_to_update: Iterable[vtkObjectBase] | None = None,
        **_: object,
    ) -> None:
        self._push_camera = push_camera

        if obj_to_update is None:
            self.vtk_object_manager.UpdateStatesFromObjects()
        else:
            ids = [self.vtk_object_manager.GetId(obj) for obj in obj_to_update]
            self.vtk_object_manager.UpdateStatesFromObjects(ids)

        if self._debug_state:
            self.vtk_object_manager.Export(f"snapshot-{self._debug_state_counter}")
            self._debug_state_counter += 1

        # Handle subscription push
        remove_from_subscriptions: list[int] = []
        for obj_id, count in self._subscriptions.items():
            if count == 0:
                remove_from_subscriptions.append(obj_id)
            elif count > 0:
                status = self.get_status(obj_id)
                for state_id, mtime in status.get("ids", []):
                    if mtime > self._last_publish_states.get(state_id, 0):
                        self._last_publish_states[state_id] = mtime
                        self.publish(
                            "vtklocal.subscriptions",
                            dict(
                                type="state",
                                id=state_id,
                                mtime=mtime,
                                content=self.get_state(state_id),
                            ),
                        )
                for hash in status.get("hashes", []):
                    if hash not in self._last_publish_hash:
                        self._last_publish_hash.add(hash)
                        self.publish(
                            "vtklocal.subscriptions",
                            dict(type="blob", hash=hash, content=self.get_hash(hash)),
                        )

        for id_to_gc in remove_from_subscriptions:
            self._subscriptions.pop(id_to_gc)

    @property
    def active_ids(self) -> Sequence[int]:
        return self.vtk_object_manager.GetAllDependencies(0)

    @export_rpc("vtklocal.subscribe.update")
    def update_subscription(self, obj_id: int, delta: int) -> None:
        if obj_id in self._subscriptions:
            self._subscriptions[obj_id] += delta
        elif delta > 0:
            self._subscriptions[obj_id] = delta

        if delta > 0:
            self._last_publish_states.clear()
            self._last_publish_hash.clear()

        # Keep track of widgets as well
        if obj_id in self._widgets:
            for w_id in self._widgets[obj_id]:
                self.update_subscription(w_id, delta)

    @export_rpc("vtklocal.get.state")
    def get_state(self, obj_id: int) -> str:
        return self.vtk_object_manager.GetState(obj_id)

    @export_rpc("vtklocal.get.hash")
    def get_hash(self, hash: str) -> object:
        return self.addAttachment(memoryview(self.vtk_object_manager.GetBlob(hash)))

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

    @export_rpc("vtklocal.get.status")
    def get_status(self, obj_id: int) -> ObjectStatus:
        ids: Sequence[int] = self.vtk_object_manager.GetAllDependencies(obj_id)

        # Add widgets ids without duplicate
        ids_width_deps = list(ids)
        if obj_id in self._widgets:
            for dep_id in self._widgets[obj_id]:
                ids_width_deps += list(
                    self.vtk_object_manager.GetAllDependencies(dep_id)
                )
        ids = list(set(ids_width_deps))

        hashes = self.vtk_object_manager.GetBlobHashes(ids)
        renderWindow = self.vtk_object_manager.GetObjectAtId(obj_id)
        ids_mtime = [map_id_mtime(self.vtk_object_manager, v) for v in ids]
        ignore_ids: list[int] = []
        cameras: list[int] = []
        force_push: list[int] = []
        # An id that is not a live render window still answers, with no
        # interactor and no cameras.
        interactor: int | None = None
        if renderWindow:
            interactor = self.vtk_object_manager.GetId(renderWindow.interactor)
            renderers = renderWindow.GetRenderers()
            for renderer in renderers:
                activeCamera = renderer.GetActiveCamera()
                cid = self.vtk_object_manager.GetId(activeCamera)
                if not self._push_camera:
                    ignore_ids.append(cid)
                else:
                    force_push.append(cid)
                cameras.append(cid)
        return {
            "ids": ids_mtime,
            "hashes": hashes,
            "ignore_ids": ignore_ids,
            "cameras": cameras,
            "force_push": force_push,
            "interactor": interactor,
        }

    def dump_data(self, output_file: str | Path, wasm_ids: Sequence[int]) -> None:
        """
        Create file (zip) with WASM data
        """
        output_file = Path(output_file)
        output_file.parent.mkdir(parents=True, exist_ok=True)

        # Extract ids to save
        all_ids: set[int] = set()
        for vtk_id in wasm_ids:
            all_ids.update(self.vtk_object_manager.GetAllDependencies(vtk_id))

        # Extract hash to save
        hashes = self.vtk_object_manager.GetBlobHashes(list(all_ids))

        with zipfile.ZipFile(output_file, "w", ZIP_COMPRESSION) as zipf:
            # Write info
            zipf.writestr(
                "vtk-wasm.json",
                json.dumps(
                    {
                        "vtk": vtkVersion.GetVTKVersion(),
                        "ids": wasm_ids,
                    }
                ),
            )
            # Write states
            for vtk_id in all_ids:
                zipf.writestr(
                    f"states/{vtk_id}",
                    self.vtk_object_manager.GetState(vtk_id),
                )

            # Write blobs
            for hash in hashes:
                zipf.writestr(
                    f"blobs/{hash}",
                    memoryview(self.vtk_object_manager.GetBlob(hash)),
                )


class ObjectManagerHelper:
    def __init__(self, trame_server: ProtocolHostServer) -> None:
        self.trame_server = trame_server
        self.root_protocol: LinkProtocolRoot | None = None
        self.api = ObjectManagerAPI()
        self.trame_server.add_protocol_to_configure(self.configure_protocol)

    def configure_protocol(self, protocol: LinkProtocolRoot) -> None:
        self.root_protocol = protocol
        self.root_protocol.registerLinkProtocol(self.api)
