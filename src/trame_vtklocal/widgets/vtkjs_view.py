"""
VtkJsLocalView widget for rendering VTK scenes using vtk.js in the browser.

This provides an alternative to the WASM-based LocalView by using vtk.js
(JavaScript implementation of VTK) for client-side rendering.
"""

from trame_client.widgets.core import AbstractElement
from trame_vtklocal import module


class HtmlElement(AbstractElement):
    def __init__(self, _elem_name, children=None, **kwargs):
        super().__init__(_elem_name, children, **kwargs)
        if self.server:
            kwargs.pop("trame_server", None)
            self.server.enable_module(module, **kwargs)


class VtkJsLocalView(HtmlElement):
    """
    VtkJsLocalView renders a server-side vtkRenderWindow using vtk.js
    in the browser. This uses the JavaScript implementation of VTK
    rather than WebAssembly.

    Args:
        render_window (vtkRenderWindow):
            The VTK render window to mirror on the client.
        interactor_settings (list):
            Optional settings for the interactor style.
        updated (event):
            Emitted after each completed client-side update.
        camera (event):
            Event emitted when the camera changes.

    Example:
        >>> from trame_vtklocal.widgets.vtkjs_view import VtkJsLocalView
        >>> view = VtkJsLocalView(render_window)
        >>> view.update()  # Push updates to client
    """

    _next_id = 0

    def __init__(self, render_window, **kwargs):
        super().__init__("vtk-js-local", **kwargs)

        self.__ref = kwargs.get("ref")
        if self.__ref is None:
            VtkJsLocalView._next_id += 1
            self.__ref = f"_vtkjslocalview_{VtkJsLocalView._next_id}"

        self._render_window = render_window
        self._window_id = self.object_manager.RegisterObject(render_window)
        render_window.Render()
        self.object_manager.UpdateStatesFromObjects()

        self._attributes["rw_id"] = f':render-window="{self._window_id}"'
        self._attributes["ref"] = f'ref="{self.__ref}"'
        self._attr_names += [
            ("interactor_settings", "interactorSettings"),
        ]
        self._event_names += [
            "updated",
            "camera",
        ]

    @property
    def api(self):
        """Return API from helper."""
        return module.get_helper(self.server).api

    @property
    def object_manager(self):
        """Return object_manager."""
        return self.api.vtk_object_manager

    @property
    def ref_name(self):
        """Return the assigned name as a vue.js ref."""
        return self.__ref

    def update(self):
        """Push updates to client by triggering a state refresh."""
        self._render_window.Render()
        self.api.update()
        self.server.js_call(self.__ref, "update")

    def render(self):
        """Trigger a render on the client side."""
        self.server.js_call(self.__ref, "render")

    def resize(self):
        """Trigger a resize on the client side."""
        self.server.js_call(self.__ref, "resize")

    def get_wasm_id(self, vtk_object):
        """Return vtkObject id used within the object manager."""
        if hasattr(vtk_object, "IsA"):
            return self.object_manager.GetId(vtk_object)
        return vtk_object


__all__ = ["VtkJsLocalView"]
