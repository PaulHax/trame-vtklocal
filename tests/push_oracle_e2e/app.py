"""Trame test app for the push-sync v2 end-to-end oracle.

Run with::

    python -m tests.push_oracle_e2e.app --view shared --port 8090
    python -m tests.push_oracle_e2e.app --view local --port 8091

The app mounts a single widget (``VtkJsSharedView`` or ``VtkJsLocalView``) at
module scope with a persistent render window. The widget owns its
``ScenePublisher``; the app drives *that* publisher through the widget API.
Scene "reset" means clearing the widget render window's contents and
repopulating via a named factory from ``tests/push_oracle/scenes.py`` — the
publisher's dirty tracking turns that into ordinary scene ops.

Server-side RPC triggers (registered via ``server.trigger``):

- ``oracle.reset(scene_name)`` → clear+populate+sync, return the store seq
- ``oracle.run_step(step_name)`` → mutate + ``view.sync()``, return seq
- ``oracle.shadow()`` → ``store.snapshot()`` plus inlined blob bytes
- ``oracle.request_resync()`` → server-initiated mid-stream resync
- ``oracle.suppress_next_publish(count)`` → drop the next ``count`` outgoing
  ``scene.ops`` broadcasts (test-app protocol wrapper; the websocket stays
  alive so the *next* delivered message exposes the seq gap)

The protocol wrapper lives entirely in this module — the production
``ScenePublisher`` is unchanged.
"""

from __future__ import annotations

import argparse
import base64
import sys
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

from tests.push_oracle.scenes import OracleScene, SCENE_POPULATORS  # noqa: E402
from tests.push_oracle.steps import known_scenes, lookup_step  # noqa: E402


PAGE_SETUP_PATH = Path(__file__).with_name("page_setup.js")
OPS_TOPIC = "scene.ops"


def _b64(payload):
    """Recursively base64-encode any ``bytes`` / ``memoryview`` values."""
    if isinstance(payload, dict):
        return {k: _b64(v) for k, v in payload.items()}
    if isinstance(payload, list):
        return [_b64(v) for v in payload]
    if isinstance(payload, (bytes, bytearray, memoryview)):
        return {"__b64__": base64.b64encode(bytes(payload)).decode("ascii")}
    return payload


def shadow_payload(publisher):
    """The server-truth counterpart of the client dump: snapshot + blob bytes."""
    snapshot = publisher.store.snapshot()
    blobs = {
        ref: publisher._resolve_ref_payload(ref)
        for ref in sorted(publisher.store.live_refs())
    }
    return _b64(
        {
            "root": snapshot["root"],
            "seq": snapshot["seq"],
            "nodes": snapshot["nodes"],
            "blobs": blobs,
        }
    )


class ProtocolPublishWrapper:
    """Wrap a wslink protocol's ``publish`` to drop broadcasts on demand.

    ``oracle.suppress_next_publish(count)`` arms the counter; the next
    ``count`` outgoing ``scene.ops`` broadcasts are skipped, producing a
    clean seq gap while the websocket stays alive.
    """

    def __init__(self, protocol):
        self._protocol = protocol
        self._original_publish = protocol.publish
        self._suppress_remaining = 0
        # monkey-patch in place so publisher broadcasts go through us
        protocol.publish = self._publish

    def _publish(self, topic, payload, *args, **kwargs):
        if topic == OPS_TOPIC and self._suppress_remaining > 0:
            self._suppress_remaining -= 1
            return None
        return self._original_publish(topic, payload, *args, **kwargs)

    def suppress_next(self, count):
        self._suppress_remaining += int(count)

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
        vtkView = ref?.initializeForExternalContext ? ref : ref?.$.exposed || ref;

        if (!vtkView?.initializeForExternalContext) {
            setTimeout(window.initSharedContext, 100);
            return;
        }

        initialized = true;
        const canvas = document.getElementById('shared-canvas');
        const gl = canvas.getContext('webgl2', {
            preserveDrawingBuffer: true,
            antialias: false,
        });
        vtkView.initializeForExternalContext(canvas, gl);
        vtkView.onRenderRequested(function() {
            vtkView.renderExternal({});
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

        self._setup_render_window()
        self._build_ui()
        self._register_triggers()

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

    @property
    def publisher(self):
        return self.view_widget._publisher

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

        @server.trigger("oracle.reset")
        def reset(scene_name):
            return self.reset(scene_name)

        @server.trigger("oracle.run_step")
        def run_step(step_name):
            return self.run_step(step_name)

        @server.trigger("oracle.shadow")
        def shadow():
            return self.shadow()

        @server.trigger("oracle.request_resync")
        def request_resync():
            return self.request_resync()

        @server.trigger("oracle.suppress_next_publish")
        def suppress_next_publish(count=1):
            self._ensure_publish_wrapper()
            if self._publish_wrapper is not None:
                self._publish_wrapper.suppress_next(count)
            return {"count": int(count)}

    # ------------------------------------------------------------------
    # RPC implementations
    # ------------------------------------------------------------------

    def reset(self, scene_name: str):
        if scene_name not in known_scenes():
            raise ValueError(f"unknown scene {scene_name!r}; known: {known_scenes()}")

        api = self.view_widget.api

        _clear_render_window(self.render_window)
        populate = SCENE_POPULATORS[scene_name]
        handles = populate(api, self.render_window)

        # The publisher's collection observers saw the clear+populate; one
        # sync turns it into remove/upsert ops and re-syncs observers over
        # the new subtree.
        self.view_widget.sync()

        self.current_scene = scene_name
        self.current_handles = handles
        self.current_oracle_scene = OracleScene(
            name=scene_name,
            api=api,
            render_window=self.render_window,
            render_window_id=self.view_widget._window_id,
            handles=handles,
        )

        # The runner reloads the page so the browser client starts from a
        # fresh resync against the new scene instead of a cross-scene diff.
        return {
            "rw_id": int(self.view_widget._window_id),
            "scene_name": scene_name,
            "baseline_seq": int(self.publisher.store.seq),
            "needs_reload": True,
        }

    def run_step(self, step_name: str):
        if self.current_scene is None:
            raise RuntimeError("oracle.reset must be called before run_step")
        step = lookup_step(self.current_scene, step_name)
        step.mutate(self.current_oracle_scene)
        self.view_widget.sync()
        return {"seq": int(self.publisher.store.seq)}

    def shadow(self):
        return shadow_payload(self.publisher)

    def request_resync(self):
        self.view_widget.request_resync()
        return {"baseline_seq": int(self.publisher.store.seq)}


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
