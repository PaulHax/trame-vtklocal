from trame_client.widgets.core import AbstractElement
from trame_vtklocal import module
from trame_vtklocal.module.distance_to_camera import (
    bypass_distance_to_camera_for_serialization,
)
from trame_vtklocal.module.camera_authority import validate_camera_authority


class HtmlElement(AbstractElement):
    def __init__(self, _elem_name, children=None, **kwargs):
        super().__init__(_elem_name, children, **kwargs)
        if self.server:
            kwargs.pop("trame_server", None)
            self.server.enable_module(module, **kwargs)


class VtkJsBaseView(HtmlElement):
    _next_id = 0
    _ref_prefix = "_vtkjsview"
    _scene_event_names = [
        "updated",
        "camera",
        ("on_ready", "onReady"),
        ("before_scene_loaded", "beforeSceneLoaded"),
        ("after_scene_loaded", "afterSceneLoaded"),
        ("pointer_event", "pointerEvent"),
    ]

    def __init__(self, _elem_name, render_window, camera_authority="server", **kwargs):
        super().__init__(_elem_name, **kwargs)

        # "server": cameras are normal synced nodes. "client": the client owns
        # the rendered camera — the translator excludes vtkCamera nodes and the
        # renderer's activeCamera slot; the server drives the view via commands
        # and reads camera matrices only from seq-stamped events.
        self._camera_authority = validate_camera_authority(camera_authority)
        self._attributes["camera_authority"] = (
            f'camera-authority="{self._camera_authority}"'
        )

        self._ref = kwargs.get("ref")
        if self._ref is None:
            VtkJsBaseView._next_id += 1
            self._ref = f"{self._ref_prefix}_{VtkJsBaseView._next_id}"

        self._render_window = render_window
        with bypass_distance_to_camera_for_serialization(render_window):
            self._window_id = self.object_manager.RegisterObject(render_window)
            render_window.Render()
            # Scope serialization to this view's window: the object manager is
            # shared across views, and the no-arg overload would also serialize
            # other views' glyph mappers whose vtkDistanceToCamera filters are
            # not bypassed here (they execute renderer-less and error out).
            self.object_manager.UpdateStatesFromObjects([int(self._window_id)])

        self._publisher = None
        self._closed = False

        self._attributes["rw_id"] = f':render-window="{self._window_id}"'
        self._attributes["ref"] = f'ref="{self._ref}"'
        self._attributes["view_key"] = f'view-key="{self._ref}"'

    def __del__(self):
        try:
            self.cleanup()
        except Exception:
            pass

    @property
    def api(self):
        return module.get_helper(self.server).api

    @property
    def object_manager(self):
        return self.api.vtk_object_manager

    @property
    def ref_name(self):
        return self._ref

    def get_instance_id(self, vtk_object):
        vtk_id = self.object_manager.GetId(vtk_object)
        return str(vtk_id)

    @property
    def camera_authority(self):
        return self._camera_authority

    def _init_publisher(self):
        from trame_vtklocal.widgets.publisher import ScenePublisher

        if self._publisher:
            self._publisher.cleanup()
        self._publisher = ScenePublisher(
            self.server,
            self.api,
            self._render_window,
            self._window_id,
            camera_authority=self._camera_authority,
        )

    def _configure_push(self):
        self._event_names += self._scene_event_names
        self._init_publisher()

    # ------------------------------------------------------------------
    # Push sync v2 view API
    # ------------------------------------------------------------------

    def sync(self):
        """Publish pending scene changes now."""
        if self._publisher:
            self._publisher.sync()

    async def settled(self):
        """Wait until every pending scene change has been published."""
        if self._publisher:
            await self._publisher.settled()

    def transaction(self):
        """Batch mutations (and commands) into one commit + broadcast."""
        return self._publisher.transaction()

    def send_command(self, name, payload=None, *, retain=False, render=True):
        """Send a named command ordered atomically with pending scene ops.

        ``render=False`` skips the client repaint after the command's
        handlers run — for commands that change nothing visible.
        """
        if self._publisher:
            self._publisher.send_command(name, payload, retain=retain, render=render)

    def on_client_resync(self, callback):
        """Call ``callback(client_id)`` whenever a client pulls a snapshot."""
        return self._publisher.on_client_resync(callback)

    def request_resync(self):
        """Server-forced resync: every client re-pulls the full snapshot."""
        if self._publisher:
            self._publisher.request_resync()

    def event_is_current(self, event, node_id, strict=True):
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

    def get_renderer(self):
        renderers = self._render_window.GetRenderers()
        if renderers.GetNumberOfItems() > 0:
            return renderers.GetItemAsObject(0)
        return None

    def _camera_params(self):
        renderer = self.get_renderer()
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

    def _retain_camera_commands(self):
        # Retention exists for camera_authority="client", where commands are
        # the only camera a resyncing client gets. In "server" mode the camera
        # is a synced node — the snapshot already carries the current pose, and
        # a retained command would replay a stale one on top of it.
        return self._camera_authority == "client"

    def reset_camera(self, *, retain=None):
        retain = self._retain_camera_commands() if retain is None else retain
        if retain and self._publisher:
            self._publisher.clear_retained_command("camera.set")
        self.send_command("camera.reset", {}, retain=retain, render=True)

    def set_camera(self, params=None, *, retain=None):
        retain = self._retain_camera_commands() if retain is None else retain
        params = self._camera_params() if params is None else params
        if params is not None:
            if retain and self._publisher:
                self._publisher.clear_retained_command("camera.reset")
            self.send_command("camera.set", params, retain=retain, render=True)

    def set_pointer_context(self, context):
        """Store an opaque blob echoed verbatim in every ``pointer_event``.

        The gesture seam round-trips this back on each emitted event so the
        server can stamp per-render app context (frame id, drawn surface, ...)
        without the fork interpreting it.
        """
        self.server.js_call(self._ref, "setPointerContext", context)

    def set_armed_cloud_pick(self, asset_id):
        """Arm (or disarm with ``None``) the view's click-time cloud target.

        While armed, click gestures solve their ``cloud_solve`` against this
        streamed-cloud asset id — background clicks included, and overriding
        any glyph's ``depth_asset_id`` tag under the cursor. ``None`` restores
        tag-based enrichment. The solve arrives synchronously in the gesture
        payload.
        """
        self.server.js_call(self._ref, "setArmedCloudPick", asset_id)

    def cleanup(self):
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

    def close(self):
        self.cleanup()
