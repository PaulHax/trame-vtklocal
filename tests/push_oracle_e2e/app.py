"""Trame test app for the push-sync end-to-end oracle.

Run with::

    python -m tests.push_oracle_e2e.app --view shared --port 8090
    python -m tests.push_oracle_e2e.app --view local --port 8091

The app mounts a single widget (``VtkJsSharedView`` or ``VtkJsLocalView``) at
module scope with a persistent render window. The widget owns its
``_push_sync``; the app uses *that* push_sync — it does not construct a
second one. Scene "reset" means clearing the widget render window's
contents and repopulating via a named factory from
``tests/push_oracle/scenes.py``.

Server-side RPC triggers (registered via ``server.trigger``):

- ``oracle.identify_client()`` → return active wslink client id
- ``oracle.reset(scene_name)`` → clear+populate, request_resync, return seq
- ``oracle.run_step(step_name, publish, extra)`` → mutate, update/flush, seq
- ``oracle.shadow()`` → take_shadow_snapshot, return JSON-able dict
- ``oracle.client_state(client_id)`` → return ledger for that client
- ``oracle.drop_client(client_id)`` → proxy push_sync.drop_client
- ``oracle.request_resync()`` → server-initiated mid-stream resync
- ``oracle.suppress_next_publish(client_id, count)`` → drop next ``count``
  outgoing messages destined for this client (test-app protocol wrapper;
  websocket stays alive for the gap-recovery path)

The protocol wrapper lives entirely in this module — production
``PushSync`` is unchanged.
"""

from __future__ import annotations

import argparse
import base64
import sys
from copy import deepcopy
from pathlib import Path
from urllib.parse import quote as url_quote

from trame.app import get_server
from trame.ui.html import DivLayout
from trame.widgets import client, html
from trame_client.utils.testing import enable_testing

# Allow `python -m tests.push_oracle_e2e.app` from the repo root.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tests.push_oracle.harness import take_shadow_snapshot  # noqa: E402
from tests.push_oracle.scenes import SCENE_POPULATORS  # noqa: E402
from tests.push_oracle.steps import known_scenes, lookup_step  # noqa: E402


PAGE_SETUP_PATH = Path(__file__).with_name("page_setup.js")


def _b64(payload):
    """Recursively base64-encode any ``bytes`` / ``memoryview`` ``content``."""
    if isinstance(payload, dict):
        return {k: _b64(v) for k, v in payload.items()}
    if isinstance(payload, list):
        return [_b64(v) for v in payload]
    if isinstance(payload, (bytes, bytearray)):
        return {"__b64__": base64.b64encode(bytes(payload)).decode("ascii")}
    if isinstance(payload, memoryview):
        return {"__b64__": base64.b64encode(bytes(payload)).decode("ascii")}
    return payload


def _shadow_to_json(shadow_dict):
    return _b64(shadow_dict)


def _is_array_descriptor(value):
    return (
        isinstance(value, dict)
        and "hash" in value
        and "dataType" in value
    )


def _inline_array_bytes(node, resolver):
    """Walk ``node`` and stamp each array descriptor with inline ``content``
    bytes (resolved via ``v:`` / ``cell:`` / blob registry on the server)."""
    if isinstance(node, dict):
        if _is_array_descriptor(node):
            content = resolver(node)
            if content is not None and "content" not in node:
                node["content"] = bytes(content)
            return
        for value in node.values():
            _inline_array_bytes(value, resolver)
    elif isinstance(node, list):
        for item in node:
            _inline_array_bytes(item, resolver)


class ProtocolPublishWrapper:
    """Wrap a wslink protocol's ``publish`` to drop messages on demand.

    ``oracle.suppress_next_publish(client_id, count)`` increments the
    suppression counter for that client; the next ``count`` outgoing publish
    calls destined for that client are skipped, producing a clean seq gap
    visible to ``createPushSync`` while the websocket stays alive. The
    websocket *is* still up — the messages just never get pushed onto it.
    """

    def __init__(self, protocol):
        self._protocol = protocol
        self._original_publish = protocol.publish
        self._suppress_remaining: dict[str, int] = {}
        # monkey-patch in place so push_sync.publish calls go through us
        protocol.publish = self._publish

    def _publish(self, topic, payload, client_id=None, **kwargs):
        if client_id is not None and self._suppress_remaining.get(client_id, 0) > 0:
            self._suppress_remaining[client_id] -= 1
            return None
        return self._original_publish(topic, payload, client_id=client_id, **kwargs)

    def suppress_next(self, client_id: str, count: int):
        self._suppress_remaining[client_id] = (
            self._suppress_remaining.get(client_id, 0) + int(count)
        )

    def restore(self):
        self._protocol.publish = self._original_publish


def _clear_render_window(render_window):
    renderers = render_window.GetRenderers()
    while renderers.GetNumberOfItems() > 0:
        renderer = renderers.GetItemAsObject(0)
        renderer.RemoveAllViewProps()
        render_window.RemoveRenderer(renderer)


def _read_page_setup_js() -> str:
    if PAGE_SETUP_PATH.exists():
        return PAGE_SETUP_PATH.read_text(encoding="utf-8")
    return "// page_setup.js not yet available"


SHARED_INIT_JS = r"""
(function() {
    let vtkView = null;
    let initialized = false;

    window.initSharedContext = function() {
        if (initialized) return;

        const ref = window.trame?.refs?.vtkView;
        vtkView = ref?.initializeForSharedContext ? ref : ref?.$.exposed || ref;

        if (!vtkView?.initializeForSharedContext) {
            setTimeout(window.initSharedContext, 100);
            return;
        }

        initialized = true;
        const canvas = document.getElementById('shared-canvas');
        const gl = canvas.getContext('webgl2', {
            preserveDrawingBuffer: true,
            antialias: false,
        });
        vtkView.initializeForSharedContext(canvas, gl);
        vtkView.onRenderRequested(function() {
            vtkView.renderShared({});
        });
    };

    if (document.readyState === 'complete') {
        setTimeout(window.initSharedContext, 50);
    } else {
        window.addEventListener('load', function() {
            setTimeout(window.initSharedContext, 50);
        });
    }
})();
"""


class OracleApp:
    def __init__(self, *, server=None, view: str = "local"):
        if view not in ("shared", "local"):
            raise ValueError(f"unknown view {view!r}; expected shared or local")
        self.view = view
        self.server = enable_testing(get_server(server), "oracle_ready")
        self.current_scene: str | None = None
        self.current_handles: dict | None = None
        self._publish_wrapper: ProtocolPublishWrapper | None = None
        self._fallback_records: list[dict] = []

        self._setup_render_window()
        self._build_ui()
        self._register_triggers()

        # Hook fallback recording on the widget's push_sync. We can't do this
        # until widget mounting kicks _init_push_sync.
        self._wrap_fallback_recorder()

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------

    def _setup_render_window(self):
        import vtk

        rw = vtk.vtkRenderWindow()
        rw.SetSize(400, 300)
        rw.OffScreenRenderingOn()
        self.render_window = rw

    def _build_ui(self):
        page_setup_js = _read_page_setup_js()
        scripts = [f"data:text/javascript,{url_quote(page_setup_js)}"]
        if self.view == "shared":
            scripts.append(f"data:text/javascript,{url_quote(SHARED_INIT_JS)}")
        self.server.enable_module({"scripts": scripts})

        if self.view == "shared":
            from trame_vtklocal.widgets import VtkJsSharedView

            with DivLayout(self.server):
                client.Style("body { margin: 0; }")
                html.Canvas(
                    id="shared-canvas",
                    width=400,
                    height=300,
                    style="position: absolute; left: 0; top: 0; width: 400px; height: 300px;",
                )
                self.view_widget = VtkJsSharedView(
                    self.render_window,
                    ref="vtkView",
                    on_ready="window.initSharedContext?.()",
                )
        else:
            from trame_vtklocal.widgets import VtkJsLocalView

            with DivLayout(self.server):
                client.Style("body { margin: 0; }")
                self.view_widget = VtkJsLocalView(
                    self.render_window,
                    ref="vtkView",
                )

    def _wrap_fallback_recorder(self):
        push_sync = self.view_widget._push_sync
        if push_sync is None:
            return
        original = push_sync._publish_full_fallback
        records = self._fallback_records

        def record(client_id, seq, *args, **kwargs):
            reason = kwargs.get("reason")
            if reason is None and len(args) >= 2:
                reason = args[1]
            records.append({"client_id": client_id, "reason": reason})
            return original(client_id, seq, *args, **kwargs)

        push_sync._publish_full_fallback = record

    def _ensure_publish_wrapper(self):
        if self._publish_wrapper is not None:
            return
        protocol = self.server.protocol
        if protocol is None:
            return
        self._publish_wrapper = ProtocolPublishWrapper(protocol)

    # ------------------------------------------------------------------
    # RPC triggers
    # ------------------------------------------------------------------

    def _register_triggers(self):
        server = self.server

        @server.trigger("oracle.identify_client")
        def identify_client():
            return {"client_id": self._active_client_id()}

        @server.trigger("oracle.reset")
        def reset(scene_name):
            return self.reset(scene_name)

        @server.trigger("oracle.run_step")
        def run_step(step_name, publish="update", extra=None):
            return self.run_step(step_name, publish, extra)

        @server.trigger("oracle.shadow")
        def shadow():
            return self.shadow()

        @server.trigger("oracle.client_state")
        def client_state(client_id):
            return self.client_state(client_id)

        @server.trigger("oracle.drop_client")
        def drop_client(client_id):
            return self.drop_client(client_id)

        @server.trigger("oracle.request_resync")
        def request_resync():
            return self.request_resync()

        @server.trigger("oracle.suppress_next_publish")
        def suppress_next_publish(client_id, count=1):
            self._ensure_publish_wrapper()
            if self._publish_wrapper is not None:
                self._publish_wrapper.suppress_next(client_id, count)
            return {"client_id": client_id, "count": int(count)}

    # ------------------------------------------------------------------
    # RPC implementations
    # ------------------------------------------------------------------

    def _active_client_id(self):
        api = self.view_widget.api
        return api.get_active_client_id()

    def reset(self, scene_name: str):
        if scene_name not in known_scenes():
            raise ValueError(
                f"unknown scene {scene_name!r}; known: {known_scenes()}"
            )

        push_sync = self.view_widget._push_sync
        api = self.view_widget.api

        _clear_render_window(self.render_window)
        # Refresh the object-manager view of the (now empty) render window so
        # subsequent populate calls don't see ghost dependencies.
        api.vtk_object_manager.UpdateStatesFromObjects()

        populate = SCENE_POPULATORS[scene_name]
        from tests.push_oracle.scenes import OracleScene

        handles = populate(api, self.render_window)
        self.render_window.Render()
        api.vtk_object_manager.UpdateStatesFromObjects()

        self.current_scene = scene_name
        self.current_handles = handles
        # Build a thin OracleScene so step mutators can use it unchanged.
        self.current_oracle_scene = OracleScene(
            name=scene_name,
            api=api,
            render_window=self.render_window,
            render_window_id=self.view_widget._window_id,
            handles=handles,
        )

        self._fallback_records.clear()
        # Drop every currently-attached client so the runner's page reload
        # comes back as a fresh client and resyncs from the new scene state
        # instead of incrementally applying after the prior scene's state.
        for client_id in list(push_sync._view_clients):
            push_sync.drop_client(client_id)
        # Bump the authoritative seq so the next published full state has a
        # higher seq than anything an existing client could have observed.
        # request_resync would do this AND publish; we skip the publish.
        push_sync._sequence += 1

        return {
            "rw_id": int(self.view_widget._window_id),
            "scene_name": scene_name,
            "baseline_seq": int(push_sync._sequence),
            "needs_reload": True,
        }

    def run_step(self, step_name: str, publish: str = "update", extra=None):
        if self.current_scene is None:
            raise RuntimeError("oracle.reset must be called before run_step")
        push_sync = self.view_widget._push_sync
        step = lookup_step(self.current_scene, step_name)

        self._fallback_records.clear()
        step.mutate(self.current_oracle_scene)

        action = publish or step.publish
        if action == "update":
            push_sync.update(extra=extra or step.extra)
        elif action == "flush":
            push_sync.flush(extra=extra or step.extra)
        else:
            raise ValueError(f"unknown publish action {action!r}")

        return {
            "seq": int(push_sync._sequence),
            "fallback_records": list(self._fallback_records),
        }

    def shadow(self):
        from tests.push_oracle.normalize import make_resolver
        from trame_vtklocal.widgets.push_sync import _state_for_ledger

        push_sync = self.view_widget._push_sync
        snap = take_shadow_snapshot(push_sync)
        ledger_state = _state_for_ledger(snap)
        # Resolve every array descriptor's bytes inline so the JS-side
        # comparator can use a single resolver.
        resolver = make_resolver(push_sync, push_sync._api.vtk_object_manager)
        _inline_array_bytes(ledger_state, resolver)
        return _shadow_to_json(ledger_state)

    def client_state(self, client_id: str):
        push_sync = self.view_widget._push_sync
        ledger = push_sync._client_states.get(client_id)
        if ledger is None:
            return None
        return _shadow_to_json(deepcopy(ledger))

    def drop_client(self, client_id: str):
        self.view_widget._push_sync.drop_client(client_id)
        return {"client_id": client_id}

    def request_resync(self):
        push_sync = self.view_widget._push_sync
        push_sync.request_resync()
        return {"baseline_seq": int(push_sync._sequence)}


def main():
    # ``--view`` is the only flag we own; ``--server`` / ``--host`` / ``--port``
    # are handled by the trame server CLI when ``server.start()`` is called.
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--view", choices=["shared", "local"], default="local")
    args, _ = parser.parse_known_args()

    app = OracleApp(view=args.view)
    app.server.start()


if __name__ == "__main__":
    main()
