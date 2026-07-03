from trame_client.widgets.core import AbstractElement
from trame_vtklocal import module
from trame_vtklocal.module.distance_to_camera import (
    bypass_distance_to_camera_for_serialization,
)

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
        ("view_state_extra", "viewStateExtra"),
        ("on_ready", "onReady"),
        ("before_scene_loaded", "beforeSceneLoaded"),
        ("after_scene_loaded", "afterSceneLoaded"),
        ("pointer_event", "pointerEvent"),
    ]

    def __init__(self, _elem_name, render_window, **kwargs):
        super().__init__(_elem_name, **kwargs)

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

        self._attributes["rw_id"] = f':render-window="{self._window_id}"'
        self._attributes["ref"] = f'ref="{self._ref}"'

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

    def _init_publisher(self):
        from trame_vtklocal.widgets.publisher import ScenePublisher

        self.cleanup()
        self._publisher = ScenePublisher(
            self.server,
            self.api,
            self._render_window,
            self._window_id,
        )

    def _configure_sync_mode(self, sync_mode, extra_event_names=None):
        if sync_mode != "push":
            raise ValueError("vtk-js views only support sync_mode='push'")

        self._attributes["sync_mode"] = 'sync-mode="push"'
        self._event_names += ["updated"]
        if extra_event_names:
            self._event_names += list(extra_event_names)
        self._event_names += self._scene_event_names[1:]
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

    def send_command(self, name, payload=None):
        """Send a named command ordered atomically with pending scene ops."""
        if self._publisher:
            self._publisher.send_command(name, payload)

    def on_client_resync(self, callback):
        """Call ``callback(client_id)`` whenever a client pulls a snapshot."""
        return self._publisher.on_client_resync(callback)

    def request_resync(self):
        """Server-forced resync: every client re-pulls the full snapshot."""
        if self._publisher:
            self._publisher.request_resync()

    def update(self):
        """Alias for :meth:`sync`."""
        self.sync()

    # ------------------------------------------------------------------
    # Client-side camera / pointer seams
    # ------------------------------------------------------------------

    def get_renderer(self):
        renderers = self._render_window.GetRenderers()
        if renderers.GetNumberOfItems() > 0:
            return renderers.GetItemAsObject(0)
        return None

    def _push_camera(self):
        renderer = self.get_renderer()
        if not renderer:
            return
        cam = renderer.GetActiveCamera()
        if not cam:
            return
        self.set_camera(
            {
                "position": list(cam.GetPosition()),
                "focalPoint": list(cam.GetFocalPoint()),
                "viewUp": list(cam.GetViewUp()),
                "viewAngle": cam.GetViewAngle(),
                "parallelProjection": bool(cam.GetParallelProjection()),
                "parallelScale": cam.GetParallelScale(),
                "clippingRange": list(cam.GetClippingRange()),
            }
        )

    def reset_camera(self):
        self.server.js_call(self._ref, "resetCamera")

    def set_camera(self, params):
        self.server.js_call(self._ref, "setCamera", params)

    def set_pointer_context(self, context):
        """Store an opaque blob echoed verbatim in every ``pointer_event``.

        The gesture seam round-trips this back on each emitted event so the
        server can stamp per-render app context (frame id, drawn surface, ...)
        without the fork interpreting it.
        """
        self.server.js_call(self._ref, "setPointerContext", context)

    def cleanup(self):
        if self._publisher:
            self._publisher.cleanup()
            self._publisher = None

    def close(self):
        self.cleanup()
