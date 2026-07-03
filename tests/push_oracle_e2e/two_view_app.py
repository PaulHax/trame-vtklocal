"""Two-view trame test app for the push-sync v2 end-to-end oracle.

Hosts ``VtkJsSharedView`` and ``VtkJsLocalView`` under a single wslink
client, each with its own render window and its own ``ScenePublisher``. The
two-view smoke suite uses this to catch cross-view interference (shared GL
context, RAF, module-level state) that would not surface in the
one-app-per-view matrix.

The trigger surface mirrors the single-view app but takes a ``view`` kwarg
(``"shared"`` or ``"local"``) so each call dispatches to the correct widget.
"""

from __future__ import annotations

import sys
from pathlib import Path
from urllib.parse import quote as url_quote

from trame.app import get_server
from trame.ui.html import DivLayout
from trame.widgets import client, html
from trame_client.utils.testing import enable_testing

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tests.push_oracle.scenes import OracleScene, SCENE_POPULATORS  # noqa: E402
from tests.push_oracle.steps import known_scenes, lookup_step  # noqa: E402
from tests.push_oracle_e2e.app import (  # noqa: E402
    SHARED_INIT_JS,
    _clear_render_window,
    _read_page_setup_js,
    shadow_payload,
)


class TwoViewOracleApp:
    def __init__(self, *, server=None):
        self.server = enable_testing(get_server(server), "oracle_ready")
        self._widgets: dict[str, object] = {}
        self._render_windows: dict[str, object] = {}
        self._current_scene: dict[str, str] = {}
        self._current_handles: dict[str, dict] = {}
        self._current_oracle_scene: dict[str, OracleScene] = {}

        self._setup_render_windows()
        self._build_ui()
        self._register_triggers()

    def _setup_render_windows(self):
        import vtk

        for name in ("shared", "local"):
            rw = vtk.vtkRenderWindow()
            rw.SetSize(400, 300)
            rw.OffScreenRenderingOn()
            self._render_windows[name] = rw

    def _build_ui(self):
        from trame_vtklocal.widgets import VtkJsLocalView, VtkJsSharedView

        page_setup_js = _read_page_setup_js()
        scripts = [
            f"data:text/javascript,{url_quote(page_setup_js)}",
            f"data:text/javascript,{url_quote(SHARED_INIT_JS)}",
        ]
        self.server.enable_module({"scripts": scripts})

        with DivLayout(self.server):
            client.Style("body { margin: 0; }")
            html.Canvas(
                id="shared-canvas",
                width=400,
                height=300,
                style="position: absolute; left: 0; top: 0; width: 400px; height: 300px;",
            )
            self._widgets["shared"] = VtkJsSharedView(
                self._render_windows["shared"],
                ref="vtkView",
                on_ready="window.initSharedContext?.()",
            )
            self._widgets["local"] = VtkJsLocalView(
                self._render_windows["local"],
                ref="vtkViewLocal",
            )

    def _register_triggers(self):
        server = self.server

        @server.trigger("oracle.reset")
        def reset(view, scene_name):
            return self.reset(view, scene_name)

        @server.trigger("oracle.run_step")
        def run_step(view, step_name):
            return self.run_step(view, step_name)

        @server.trigger("oracle.shadow")
        def shadow(view):
            return self.shadow(view)

    def _publisher(self, view: str):
        return self._widgets[view]._publisher

    def reset(self, view: str, scene_name: str):
        if view not in self._widgets:
            raise ValueError(f"unknown view {view!r}")
        if scene_name not in known_scenes():
            raise ValueError(f"unknown scene {scene_name!r}")

        widget = self._widgets[view]
        rw = self._render_windows[view]

        _clear_render_window(rw)
        handles = SCENE_POPULATORS[scene_name](widget.api, rw)
        widget.sync()

        self._current_scene[view] = scene_name
        self._current_handles[view] = handles
        self._current_oracle_scene[view] = OracleScene(
            name=scene_name,
            api=widget.api,
            render_window=rw,
            render_window_id=widget._window_id,
            handles=handles,
        )

        return {
            "rw_id": int(widget._window_id),
            "scene_name": scene_name,
            "baseline_seq": int(self._publisher(view).store.seq),
            "needs_reload": True,
            "view": view,
        }

    def run_step(self, view: str, step_name: str):
        widget = self._widgets[view]
        if view not in self._current_scene:
            raise RuntimeError(
                f"oracle.reset must be called for view {view!r} first"
            )
        step = lookup_step(self._current_scene[view], step_name)
        step.mutate(self._current_oracle_scene[view])
        widget.sync()
        return {"seq": int(self._publisher(view).store.seq), "view": view}

    def shadow(self, view: str):
        return shadow_payload(self._publisher(view))


def main():
    TwoViewOracleApp().server.start()


if __name__ == "__main__":
    main()
