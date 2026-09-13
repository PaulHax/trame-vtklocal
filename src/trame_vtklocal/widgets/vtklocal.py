from __future__ import annotations

import asyncio
import io
import json
import zipfile
import base64
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, overload
from trame_client.widgets.core import AbstractElement
from vtkmodules.vtkCommonCore import vtkObjectBase

from trame_vtklocal import module

from trame_common.exec.throttle import Throttle

if TYPE_CHECKING:
    from vtkmodules.vtkRenderingCore import vtkRenderer, vtkRenderWindow
    from vtkmodules.vtkSerializationManager import vtkObjectManager

    from trame_vtklocal.host_types import UpdateThrottle
    from trame_vtklocal.module.protocol import ObjectManagerAPI
    from trame_vtklocal.module.vtkjs_translator import VtkRef

try:
    import zlib  # noqa

    ZIP_COMPRESSION = zipfile.ZIP_DEFLATED
except ImportError:
    ZIP_COMPRESSION = zipfile.ZIP_STORED


# trame_client ships no type information, so its base class is untyped here.
class HtmlElement(AbstractElement):  # type: ignore[misc, no-any-unimported]
    def __init__(
        self, _elem_name: str, children: object = None, **kwargs: object
    ) -> None:
        super().__init__(_elem_name, children, **kwargs)
        if self.server:
            # Remove the server reference from kwargs to avoid multiple args with same name.
            kwargs.pop("trame_server", None)
            self.server.enable_module(module, **kwargs)
            module.setup_wasm(self.server, **kwargs)


def encode_blobs(blob_map: Mapping[str, Mapping[str, Iterable[int]]]) -> dict[str, str]:
    result: dict[str, str] = {}
    for key in blob_map:
        result[key] = base64.b64encode(bytes(blob_map[key].get("bytes", []))).decode(
            "utf-8"
        )

    return result


def get_version() -> str:
    from vtkmodules.vtkCommonCore import vtkVersion

    vtk_version = vtkVersion()
    return vtk_version.GetVTKVersion()


def is_vtk_version_newer(major: int, min: int, patch: int) -> bool:
    from vtkmodules.vtkCommonCore import vtkVersion

    vtk_version = vtkVersion()
    if vtk_version.GetVTKMajorVersion() > major:
        return True
    elif vtk_version.GetVTKMajorVersion() == major:
        if vtk_version.GetVTKMinorVersion() > min:
            return True
        elif vtk_version.GetVTKMinorVersion() == min:
            if vtk_version.GetVTKBuildVersion() > patch:
                return True
    return False


class LocalView(HtmlElement):
    """
    LocalView allow to mirror a server side vtkRenderWindow
    on the client side using VTK.wasm.

    Args:
        render_window (vtkRenderWindow):
            Specify the VTK window to mirror
        throttle_rate (number):
            Number of update per second the render_throttle()
            method will actually perform.
        cache_size (number):
            Size of client side cache for geometry and arrays in Bytes.
        eager_sync (bool):
            If enabled, the server will push states rather than waiting
            for the client to request them. Usually improve fast update behavior.
        listeners (dict):
            Dynamic structure describing what to observe and how to map internal
            WASM state to trame state variable.
        use_handler (string):
            Name of a global instance of WASM handler to use. This is useful for
            skipping WASM reinitialization when your vue component is going to be
            mounted/unmounted often. (i.e. used inside VueRouter element)
        config (dict):
            Provide configuration for your wasm runtime.
            {
               rendering: 'webgpu' or 'webgl',
               exec: 'sync' or 'async',
               wasmBaseName: 'vtk',  # base name of the wasm file, will look for `${wasmBaseName}WebAssembly.mjs`
            }
        updated (event):
            Emitted after each completed client side update.
        memory_vtk (event):
            Event which provides the current memory used by vtk object structures.
        memory_arrays (event):
            Event which provides the current memory used by vtk arrays.
        camera (event):
            Event emitted when any camera is changed. The actual state of
            the camera is passed as arg.
        progress (event):
            Event emitted during wasm sync. Payload includes active flag and
            current/total counts for states and blobs.

    """

    _next_id = 0

    def __init__(
        self,
        render_window: vtkRenderWindow,
        throttle_rate: float = 10,
        **kwargs: object,
    ) -> None:
        # Register response callback if not overridden
        kwargs.setdefault("invoke_response", (self._on_invoke_response, "[$event]"))
        self._pending_invoke_result: asyncio.Future[object] | None = None

        super().__init__(
            "vtk-local",
            **kwargs,
        )
        self.__registered_obj: list[vtkObjectBase] = []
        ref = kwargs.get("ref")
        if ref is None:
            LocalView._next_id += 1
            ref = f"_vtklocalview_{LocalView._next_id}"
        self.__ref = str(ref)

        # Must trigger update after registration
        self._render_window = render_window
        self._window_id = self.object_manager.RegisterObject(render_window)
        render_window.Render()
        self.object_manager.UpdateStatesFromObjects()
        if self.api._debug_state:
            self.object_manager.Export(f"snapshot-{self.api._debug_state_counter}")

        self._attributes["rw_id"] = f':render-window="{self._window_id}"'
        self._attributes["ref"] = f'ref="{self.__ref}"'
        self._attr_names += [
            ("use_handler", "useHandler"),
            ("cache_size", "cacheSize"),
            ("eager_sync", "eagerSync"),
            "verbosity",
            ("listeners", ":listeners"),
            ("config", ":config"),
        ]
        self._event_names += [
            "updated",
            "camera",
            ("memory_vtk", "memory-vtk"),
            ("memory_arrays", "memory-arrays"),
            ("invoke_response", "invoke-response"),
            "progress",
        ]

        # Generate throttle update function
        self._update_throttle: UpdateThrottle = Throttle(self.update)
        self._update_throttle.rate = throttle_rate

    def _on_invoke_response(self, response: object) -> None:
        if self._pending_invoke_result is None:
            return
        self._pending_invoke_result.set_result(response)

    @property
    def api(self) -> ObjectManagerAPI:
        """Return API from helper"""
        helper = module.get_helper(self.server)
        if helper is None:
            raise RuntimeError("trame_vtklocal is not enabled on this view's server")
        return helper.api

    @property
    def object_manager(self) -> vtkObjectManager:
        """Return object_manager"""
        return self.api.vtk_object_manager

    def eval(self, state_mapping: Mapping[str, object]) -> None:
        """Evaluate WASM state extract and map it onto trame state variables

        >>> html_view.eval({
        ...    "trame_state_name": {
        ...        "prop_name1": (wasm_id, "PropName"),
        ...        "origin": (wasm_id, "WidgetRepresentation", "origin"),
        ...        "widget_state": widget_id,
        ...    }
        ... }
        """
        self.server.js_call(self.__ref, "evalStateExtract", state_mapping)

    def detach_handler(self) -> None:
        """
        When using `use_handler=` property, you may reach a point where you
        want to free the global WASM handler on the client side.
        This method will remove the global reference so an unmount would release it,
        while a new mount will re-create a new handler.
        """
        self.server.js_call(self.__ref, "detachHandler")

    @property
    def update_throttle(self) -> UpdateThrottle:
        """Throttled update method on which you can update its rate by doing

        >>> html_view.update_throttle.rate = 15  # time per second
        >>> html_view.update_throttle()
        """
        return self._update_throttle

    def update(self, push_camera: bool = False) -> None:
        """Sync view by pushing updates to client"""
        self.api.update(
            push_camera=push_camera,
            obj_to_update=[self._render_window, *self.__registered_obj],
        )
        self.server.js_call(self.__ref, "update")

    def register_vtk_object(self, vtk_instance: vtkObjectBase) -> int:
        """Register external element (i.e. widget) into the scene so it can be managed and return its wasm_id"""
        if vtk_instance not in self.__registered_obj:
            self.api.register_widget(self._render_window, vtk_instance)
            self.__registered_obj.append(vtk_instance)
            self.api.update()

        return self.get_wasm_id(vtk_instance)

    def unregister_vtk_object(self, vtk_instance: vtkObjectBase) -> bool:
        """Unregister external element (i.e. widget) from the scene so it can removed from tracking"""
        if vtk_instance in self.__registered_obj:
            self.api.unregister_widget(self._render_window, vtk_instance)
            self.__registered_obj.remove(vtk_instance)
            return True

        return False

    def unregister_all_vtk_objects(self) -> None:
        """Unregister all external element (i.e. widget) from the scene"""
        for vtk_instance in list(self.__registered_obj):
            self.api.unregister_widget(self._render_window, vtk_instance)
        self.__registered_obj.clear()

    def export(self, format: str = "zip", **kwargs: object) -> bytes | None:
        """Export standalone scene for WASMViewer

        :param format: Can be either be "zip" or "json".
        """
        base_name = str(Path(f"snapshot-{self.api._debug_state_counter}").resolve())
        self.object_manager.Export(base_name)
        states_file = Path(f"{base_name}.states.json")
        blobs_file = Path(f"{base_name}.blobs.json")

        json_structure: dict[str, object] = {
            "version": get_version(),
            "states": json.loads(states_file.read_text()),
            "blobs": encode_blobs(json.loads(blobs_file.read_text())),
        }
        states_file.unlink()
        blobs_file.unlink()

        # write json file to disk
        if format == "json":
            json_out = json.dumps(json_structure)
            return json_out.encode(encoding="UTF-8", errors="strict")
        if format == "zip":
            zip_buffer = io.BytesIO()
            with zipfile.ZipFile(zip_buffer, "a") as zfile:
                zfile.writestr(
                    "index.json",
                    json.dumps(json_structure),
                    compress_type=ZIP_COMPRESSION,
                )

            return zip_buffer.getvalue()
        return None

    def save(
        self, file_name: str | Path, wasm_ids: Sequence[int] | None = None
    ) -> None:
        """Save zip file capturing state and blob data for a given render window"""
        if wasm_ids is None:
            wasm_ids = self.api.get_all_ids(self._window_id)

        self.api.dump_data(file_name, wasm_ids)

    def reset_camera(
        self,
        renderer_or_render_window: vtkRenderer | vtkRenderWindow | None = None,
        **kwargs: object,
    ) -> None:
        """Reset camera by making the call on the client side"""
        from vtkmodules.vtkRenderingCore import vtkRenderWindow

        if renderer_or_render_window is None:
            renderer_or_render_window = self._render_window

        if isinstance(renderer_or_render_window, vtkRenderWindow):
            renderer_or_render_window = (
                renderer_or_render_window.GetRenderers().GetFirstRenderer()
            )
            if renderer_or_render_window is None:
                raise RuntimeError("render window has no renderer to reset")

        if renderer_or_render_window.IsA("vtkRenderer"):
            id_to_reset_camera = self.get_wasm_id(renderer_or_render_window)
            self.server.js_call(self.__ref, "resetCamera", id_to_reset_camera)

    @property
    def ref_name(self) -> str:
        """Return the assigned name as a vue.js ref"""
        return self.__ref

    @overload
    def get_wasm_id(self, vtk_object: vtkObjectBase) -> int: ...

    @overload
    def get_wasm_id(self, vtk_object: object) -> object: ...

    def get_wasm_id(self, vtk_object: object) -> object:
        """Return vtkObject id used within WASM scene manager"""
        if isinstance(vtk_object, vtkObjectBase):
            return self.object_manager.GetId(vtk_object)
        return vtk_object

    @overload
    def get_wasm_obj_id(self, vtk_object: vtkObjectBase) -> VtkRef: ...

    @overload
    def get_wasm_obj_id(self, vtk_object: object) -> object: ...

    def get_wasm_obj_id(self, vtk_object: object) -> object:
        """Return vtkObject {Id: id} used within WASM scene manager"""
        if isinstance(vtk_object, vtkObjectBase):
            return {"Id": self.object_manager.GetId(vtk_object)}
        return vtk_object

    def get_vtk_obj(self, wasm_id: int) -> vtkObjectBase | None:
        """Return corresponding VTK object"""
        vtk_object: vtkObjectBase | None = self.object_manager.GetObjectAtId(wasm_id)
        return vtk_object

    def vtk_update_from_state(self, state_obj: str | dict[str, object]) -> None:
        """Use a state from WASM to update a VTK object"""
        if isinstance(state_obj, dict):
            state_obj = json.dumps(state_obj)

        self.object_manager.UpdateObjectFromState(state_obj)

    async def invoke(
        self,
        vtk_obj: object,
        method: str,
        *args: object,
        unwrap_vtk_object: bool = True,
    ) -> object:
        wasm_id = self.get_wasm_id(vtk_obj)

        if is_vtk_version_newer(9, 5, 100):
            wasm_args: list[object] = list(map(self.get_wasm_obj_id, args))
        else:
            wasm_args = list(map(self.get_wasm_id, args))

        self._pending_invoke_result = asyncio.get_running_loop().create_future()
        self.server.js_call(self.__ref, "invoke", wasm_id, method, wasm_args)
        await self._pending_invoke_result
        result_from_client = self._pending_invoke_result.result()

        # auto unwrap vtk objects
        if (
            unwrap_vtk_object
            and isinstance(result_from_client, dict)
            and "Id" in result_from_client
        ):
            return self.get_vtk_obj(result_from_client["Id"])

        return result_from_client

    def print_scene_manager_information(self) -> None:
        self.server.js_call(self.__ref, "printSceneManagerInformation")


__all__ = [
    "LocalView",
]
