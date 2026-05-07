"""Two-view trame test app for the push-sync end-to-end oracle.

Hosts ``VtkJsSharedView`` and ``VtkJsLocalView`` under a single wslink
client, each with its own render window. The two-view smoke suite uses
this to catch cross-view interference (shared GL context, RAF, module-level
state) and per-view ``drop_client`` purging that would not surface in the
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

from tests.push_oracle.harness import take_shadow_snapshot  # noqa: E402
from tests.push_oracle.scenes import OracleScene, SCENE_POPULATORS  # noqa: E402
from tests.push_oracle.steps import known_scenes, lookup_step  # noqa: E402
from tests.push_oracle_e2e.app import (  # noqa: E402
    PAGE_SETUP_PATH,
    SHARED_INIT_JS,
    ProtocolPublishWrapper,
    _clear_render_window,
    _inline_array_bytes,
    _read_page_setup_js,
    _shadow_to_json,
)


class TwoViewOracleApp:
    def __init__(self, *, server=None):
        self.server = enable_testing(get_server(server), "oracle_ready")
        self._widgets: dict[str, object] = {}
        self._render_windows: dict[str, object] = {}
        self._current_scene: dict[str, str] = {}
        self._current_handles: dict[str, dict] = {}
        self._current_oracle_scene: dict[str, OracleScene] = {}
        self._publish_wrapper: ProtocolPublishWrapper | None = None
        self._fallback_records: dict[str, list[dict]] = {
            "shared": [],
            "local": [],
        }

        self._setup_render_windows()
        self._build_ui()
        self._wrap_fallback_recorders()
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

    def _wrap_fallback_recorders(self):
        for view, widget in self._widgets.items():
            push_sync = widget._push_sync
            if push_sync is None:
                continue
            original = push_sync._publish_full_fallback
            records = self._fallback_records[view]

            def _make_recorder(orig, recs):
                def record(client_id, seq, *args, **kwargs):
                    reason = kwargs.get("reason")
                    if reason is None and len(args) >= 2:
                        reason = args[1]
                    recs.append({"client_id": client_id, "reason": reason})
                    return orig(client_id, seq, *args, **kwargs)

                return record

            push_sync._publish_full_fallback = _make_recorder(original, records)

    def _ensure_publish_wrapper(self):
        if self._publish_wrapper is not None:
            return
        protocol = self.server.protocol
        if protocol is None:
            return
        self._publish_wrapper = ProtocolPublishWrapper(protocol)

    def _register_triggers(self):
        server = self.server

        @server.trigger("oracle.identify_client")
        def identify_client():
            api = self._widgets["local"].api
            return {"client_id": api.get_active_client_id()}

        @server.trigger("oracle.reset")
        def reset(view, scene_name):
            return self.reset(view, scene_name)

        @server.trigger("oracle.run_step")
        def run_step(view, step_name, publish="update", extra=None):
            return self.run_step(view, step_name, publish, extra)

        @server.trigger("oracle.shadow")
        def shadow(view):
            return self.shadow(view)

        @server.trigger("oracle.client_state")
        def client_state(view, client_id):
            return self.client_state(view, client_id)

        @server.trigger("oracle.drop_client")
        def drop_client(view, client_id):
            return self.drop_client(view, client_id)

    def reset(self, view: str, scene_name: str):
        if view not in self._widgets:
            raise ValueError(f"unknown view {view!r}")
        if scene_name not in known_scenes():
            raise ValueError(f"unknown scene {scene_name!r}")

        widget = self._widgets[view]
        rw = self._render_windows[view]
        push_sync = widget._push_sync
        api = widget.api

        _clear_render_window(rw)
        api.vtk_object_manager.UpdateStatesFromObjects()

        populate = SCENE_POPULATORS[scene_name]
        handles = populate(api, rw)
        rw.Render()
        api.vtk_object_manager.UpdateStatesFromObjects()

        self._current_scene[view] = scene_name
        self._current_handles[view] = handles
        self._current_oracle_scene[view] = OracleScene(
            name=scene_name,
            api=api,
            render_window=rw,
            render_window_id=widget._window_id,
            handles=handles,
        )

        self._fallback_records[view].clear()
        for client_id in list(push_sync._view_clients):
            push_sync.drop_client(client_id)
        push_sync._sequence += 1

        return {
            "rw_id": int(widget._window_id),
            "scene_name": scene_name,
            "baseline_seq": int(push_sync._sequence),
            "needs_reload": True,
            "view": view,
        }

    def run_step(self, view: str, step_name: str, publish="update", extra=None):
        widget = self._widgets[view]
        push_sync = widget._push_sync
        if view not in self._current_scene:
            raise RuntimeError(
                f"oracle.reset must be called for view {view!r} first"
            )
        step = lookup_step(self._current_scene[view], step_name)

        self._fallback_records[view].clear()
        step.mutate(self._current_oracle_scene[view])
        action = publish or step.publish
        if action == "update":
            push_sync.update(extra=extra or step.extra)
        elif action == "flush":
            push_sync.flush(extra=extra or step.extra)
        else:
            raise ValueError(f"unknown publish action {action!r}")

        return {
            "seq": int(push_sync._sequence),
            "fallback_records": list(self._fallback_records[view]),
            "view": view,
        }

    def shadow(self, view: str):
        from tests.push_oracle.normalize import make_resolver
        from trame_vtklocal.widgets.push_sync import _state_for_ledger

        widget = self._widgets[view]
        push_sync = widget._push_sync
        snap = take_shadow_snapshot(push_sync)
        ledger_state = _state_for_ledger(snap)
        resolver = make_resolver(push_sync, push_sync._api.vtk_object_manager)
        _inline_array_bytes(ledger_state, resolver)
        return _shadow_to_json(ledger_state)

    def client_state(self, view: str, client_id: str):
        from copy import deepcopy

        push_sync = self._widgets[view]._push_sync
        ledger = push_sync._client_states.get(client_id)
        if ledger is None:
            return None
        return _shadow_to_json(deepcopy(ledger))

    def drop_client(self, view: str, client_id: str):
        self._widgets[view]._push_sync.drop_client(client_id)
        return {"client_id": client_id, "view": view}


def main():
    TwoViewOracleApp().server.start()


if __name__ == "__main__":
    main()
