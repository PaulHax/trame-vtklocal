from __future__ import annotations

from collections.abc import Mapping
from contextlib import AbstractContextManager
from typing import TYPE_CHECKING, Literal, TypedDict, TypeVar, Union

from trame_client.widgets.core import AbstractElement

from trame_vtklocal import module

if TYPE_CHECKING:
    from vtkmodules.vtkRenderingCore import vtkRenderWindow
    from vtkmodules.vtkSerializationManager import vtkObjectManager

    from trame_vtklocal.module.protocol import ObjectManagerAPI
    from trame_vtklocal.widgets.publisher import ScenePublisher


Tiles3DTexturePolicy = Literal["auto", "native", "rgba"]
Tiles3DQualityPolicy = Literal["adaptive", "fixed"]

TILES3D_TEXTURE_POLICIES: frozenset[str] = frozenset({"auto", "native", "rgba"})
TILES3D_QUALITY_POLICIES: frozenset[str] = frozenset({"adaptive", "fixed"})

_PolicyT = TypeVar("_PolicyT", bound=str)


class CameraParams(TypedDict):
    position: list[float]
    focalPoint: list[float]
    viewUp: list[float]
    viewAngle: float
    parallelProjection: bool
    parallelScale: float
    clippingRange: list[float]


def _validate_policy(name: str, value: _PolicyT, choices: frozenset[str]) -> _PolicyT:
    if value not in choices:
        raise ValueError(f"{name} must be one of {sorted(choices)}, got {value!r}")
    return value


# trame_client ships no type information, so its base class is untyped here.
class HtmlElement(AbstractElement):  # type: ignore[misc, no-any-unimported]
    def __init__(
        self, _elem_name: str, children: object = None, **kwargs: object
    ) -> None:
        super().__init__(_elem_name, children, **kwargs)
        if self.server:
            kwargs.pop("trame_server", None)
            self.server.enable_module(module, **kwargs)


class VtkJsBaseView(HtmlElement):
    _next_id = 0
    _ref_prefix = "_vtkjsview"
    _scene_event_names: list[Union[str, tuple[str, str]]] = [
        "updated",
        "camera",
        ("on_ready", "onReady"),
        ("before_scene_loaded", "beforeSceneLoaded"),
        ("after_scene_loaded", "afterSceneLoaded"),
        ("pointer_event", "pointerEvent"),
    ]

    def __init__(
        self,
        _elem_name: str,
        render_window: vtkRenderWindow,
        tiles3d_texture_policy: Tiles3DTexturePolicy = "auto",
        tiles3d_quality_policy: Tiles3DQualityPolicy = "adaptive",
        streamed_memory_budget_bytes: int | None = None,
        **kwargs: object,
    ) -> None:
        self._tiles3d_texture_policy = _validate_policy(
            "tiles3d_texture_policy",
            tiles3d_texture_policy,
            TILES3D_TEXTURE_POLICIES,
        )
        self._tiles3d_quality_policy = _validate_policy(
            "tiles3d_quality_policy",
            tiles3d_quality_policy,
            TILES3D_QUALITY_POLICIES,
        )
        if streamed_memory_budget_bytes is not None and (
            isinstance(streamed_memory_budget_bytes, bool)
            or not isinstance(streamed_memory_budget_bytes, int)
            or not 0 < streamed_memory_budget_bytes <= 2**53 - 1
        ):
            raise ValueError("streamed_memory_budget_bytes must be a positive safe integer")
        super().__init__(_elem_name, **kwargs)
        if streamed_memory_budget_bytes is not None:
            self._attributes["streamed_memory_budget_bytes"] = (
                f':streamed-memory-budget-bytes="{streamed_memory_budget_bytes}"'
            )

        self._attributes["tiles3d_texture_policy"] = (
            f'tiles3d-texture-policy="{self._tiles3d_texture_policy}"'
        )
        self._attributes["tiles3d_quality_policy"] = (
            f'tiles3d-quality-policy="{self._tiles3d_quality_policy}"'
        )

        ref = kwargs.get("ref")
        if ref is None:
            VtkJsBaseView._next_id += 1
            ref = f"{self._ref_prefix}_{VtkJsBaseView._next_id}"
        self._ref = str(ref)

        self._render_window = render_window
        self._window_id = self.object_manager.RegisterObject(render_window)
        render_window.Render()
        # The object manager is shared across views: serialize this window only.
        self.object_manager.UpdateStatesFromObjects([int(self._window_id)])

        self._publisher: ScenePublisher | None = None
        self._closed = False

        self._attributes["rw_id"] = f':render-window="{self._window_id}"'
        self._attributes["ref"] = f'ref="{self._ref}"'
        self._attributes["view_key"] = f'view-key="{self._ref}"'

    def __del__(self) -> None:
        try:
            self.cleanup()
        except Exception:
            pass

    @property
    def api(self) -> ObjectManagerAPI:
        helper = module.get_helper(self.server)
        if helper is None:
            raise RuntimeError("trame_vtklocal is not enabled on this view's server")
        return helper.api

    @property
    def object_manager(self) -> vtkObjectManager:
        return self.api.vtk_object_manager

    @property
    def ref_name(self) -> str:
        return self._ref

    @property
    def tiles3d_texture_policy(self) -> Tiles3DTexturePolicy:
        return self._tiles3d_texture_policy

    @property
    def tiles3d_quality_policy(self) -> Tiles3DQualityPolicy:
        return self._tiles3d_quality_policy

    def _init_publisher(self) -> None:
        from trame_vtklocal.widgets.publisher import ScenePublisher

        if self._publisher:
            self._publisher.cleanup()
        self._publisher = ScenePublisher(
            self.server,
            self.api,
            self._render_window,
            self._window_id,
        )

    def _configure_push(self) -> None:
        self._event_names += self._scene_event_names
        self._init_publisher()

    # ------------------------------------------------------------------
    # Push sync v2 view API
    # ------------------------------------------------------------------

    def recover(self) -> None:
        """Recover scene edits made without VTK ModifiedEvent notifications."""
        if self._publisher is not None:
            self._publisher.recover()

    def sync(self) -> None:
        """Publish pending scene changes now."""
        if self._publisher:
            self._publisher.sync()

    def transaction(self) -> AbstractContextManager[ScenePublisher]:
        """Batch mutations (and commands) into one commit + broadcast."""
        return self._open_publisher().transaction()

    def send_command(
        self,
        name: str,
        payload: object = None,
        *,
        retain: bool = False,
        render: bool = True,
    ) -> None:
        """Send a named command ordered atomically with pending scene ops.

        ``render=False`` skips the client repaint after the command's
        handlers run — for commands that change nothing visible.
        """
        if self._publisher:
            self._publisher.send_command(name, payload, retain=retain, render=render)

    def _open_publisher(self) -> ScenePublisher:
        if self._publisher is None:
            raise RuntimeError("view is closed")
        return self._publisher

    def event_is_current(
        self, event: object, node_id: str | int | None, strict: bool = True
    ) -> bool:
        """Whether a seq-stamped client event is current for one scene node.

        Array patches count by default (they move the picked points);
        ``strict=False`` counts structural upserts only, for mid-gesture
        events whose own confirmations ride the same channel. ``node_id`` is
        named by the caller — a gesture reports every node its measurement
        depended on, and each is checked in turn; unknown/removed is stale.
        """
        if not self._publisher:
            return False
        return self._publisher.event_is_current(event, node_id, strict=strict)

    # ------------------------------------------------------------------
    # Client-side camera / pointer seams
    # ------------------------------------------------------------------

    def _camera_params(self) -> CameraParams | None:
        renderer = self._render_window.GetRenderers().GetFirstRenderer()
        if not renderer:
            return None
        cam = renderer.GetActiveCamera()
        if not cam:
            return None
        return {
            "position": list(cam.GetPosition()),
            "focalPoint": list(cam.GetFocalPoint()),
            "viewUp": list(cam.GetViewUp()),
            "viewAngle": cam.GetViewAngle(),
            "parallelProjection": bool(cam.GetParallelProjection()),
            "parallelScale": cam.GetParallelScale(),
            "clippingRange": list(cam.GetClippingRange()),
        }

    # The client owns the rendered camera, so these commands are the only
    # camera a resyncing client gets; they are retained unless asked not to be.
    def reset_camera(self, *, retain: bool = True) -> None:
        if retain and self._publisher:
            self._publisher.clear_retained_command("camera.set")
        self.send_command("camera.reset", {}, retain=retain, render=True)

    def set_camera(
        self, params: Mapping[str, object] | None = None, *, retain: bool = True
    ) -> None:
        params = self._camera_params() if params is None else params
        if params is not None:
            if retain and self._publisher:
                self._publisher.clear_retained_command("camera.reset")
            self.send_command("camera.set", params, retain=retain, render=True)

    def set_pointer_context(self, context: object) -> None:
        """Store an opaque blob echoed verbatim in every ``pointer_event``.

        The gesture seam round-trips this back on each emitted event so the
        server can stamp per-render app context (frame id, drawn surface, ...)
        without the fork interpreting it.
        """
        self.server.js_call(self._ref, "setPointerContext", context)

    def set_armed_cloud_pick(self, spec: object) -> None:
        """Send ordered runtime arm state (generation, token, asset_id).

        A null token disarms; a null asset uses normal server-side depth. Every
        pointer event echoes the captured token, including server-depth picks.
        """
        self.server.js_call(self._ref, "setArmedCloudPick", spec)

    def cleanup(self) -> None:
        if getattr(self, "_closed", True):
            return
        publisher = self._publisher
        api = self.api
        object_manager = api.vtk_object_manager
        if publisher is not None:
            update_refs = getattr(api, "update_push_view_refs", None)
            if update_refs is not None:
                update_refs(
                    self._window_id,
                    frozenset(),
                    publisher.store.live_refs(),
                )
            publisher.cleanup()
            self._publisher = None
        object_manager.UnRegisterObject(int(self._window_id))
        object_manager.PruneUnusedObjects()
        object_manager.PruneUnusedStates()
        flush_blobs = getattr(api, "flush_stale_blobs", None)
        if flush_blobs is not None:
            flush_blobs()
        self._closed = True

    def close(self) -> None:
        self.cleanup()
