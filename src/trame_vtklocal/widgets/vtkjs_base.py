from trame_client.widgets.core import AbstractElement
from trame_vtklocal import module

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
    ]

    def __init__(self, _elem_name, render_window, **kwargs):
        super().__init__(_elem_name, **kwargs)

        self._ref = kwargs.get("ref")
        if self._ref is None:
            VtkJsBaseView._next_id += 1
            self._ref = f"{self._ref_prefix}_{VtkJsBaseView._next_id}"

        self._render_window = render_window
        self._window_id = self.object_manager.RegisterObject(render_window)
        render_window.Render()
        self.object_manager.UpdateStatesFromObjects()

        self._collection_tracker = {}
        self._push_sync = None

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

    def _get_vtkjs_state(self, version_registry=None, collection_tracker=None):
        from trame_vtklocal.module.vtkjs_translator import translate_scene

        self._render_window.Render()
        self.object_manager.UpdateStatesFromObjects()
        tracker = (
            self._collection_tracker
            if collection_tracker is None
            else collection_tracker
        )
        return translate_scene(
            self.object_manager,
            self._window_id,
            tracker,
            version_registry=version_registry,
            rw_id=self._window_id,
        )

    def get_instance_id(self, vtk_object):
        vtk_id = self.object_manager.GetId(vtk_object)
        return str(vtk_id)

    def _init_push_sync(self):
        from trame_vtklocal.widgets.push_sync import PushSync

        self.cleanup()
        self._push_sync = PushSync(
            self.server,
            self._get_vtkjs_state,
            self.get_instance_id,
            self._window_id,
            api=self.api,
        )

    def _configure_sync_mode(self, sync_mode, extra_event_names=None):
        if sync_mode != "push":
            raise ValueError("vtk-js views only support sync_mode='push'")

        self._attributes["sync_mode"] = 'sync-mode="push"'
        self._event_names += ["updated"]
        if extra_event_names:
            self._event_names += list(extra_event_names)
        self._event_names += self._scene_event_names[1:]
        self._init_push_sync()

    def _update_view(self, extra=None):
        self._push_sync.update(extra=extra)

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

    def mark_modified(self, vtk_object, array_path, start=0, count=None, data=None, data_type=None):
        if self._push_sync:
            self._push_sync.mark_modified(vtk_object, array_path, start, count, data, data_type)

    def flush(self, extra=None):
        if self._push_sync:
            self._push_sync.flush(extra)

    def request_resync(self, extra=None):
        if self._push_sync:
            self._collection_tracker.clear()
            self._push_sync.request_resync(extra)

    def cleanup(self):
        if self._push_sync:
            self._push_sync.cleanup()
            self._push_sync = None

    def close(self):
        self.cleanup()
