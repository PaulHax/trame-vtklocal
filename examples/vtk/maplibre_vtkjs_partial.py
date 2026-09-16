"""TSW feature exerciser: shared map context, streamed assets and frame updates.

Run: python examples/vtk/maplibre_vtkjs_partial.py --server
See tsw_demo/README.md for controls and headless browser checks.
"""

import argparse
import asyncio
import os
from contextlib import ExitStack
from pathlib import Path
import tempfile

from trame.app import get_server
from trame.ui.html import DivLayout
from trame.widgets import html, client

from trame_vtklocal.widgets import VtkJsLocalView, VtkJsSharedView
from tsw_demo.fixtures import write_assets
from tsw_demo.scene import DemoScene
from tsw_demo.interaction import drag_point


class FeatureDemo:
    def __init__(self, vendor_dir=None):
        self.server = get_server(client_type="vue3")
        self.state = self.server.state
        self.assets = tempfile.TemporaryDirectory(prefix="trame-tsw-demo-")
        self.scene = DemoScene(write_assets(Path(self.assets.name)))
        self.play_task = None
        self.views = []
        self.state.update(
            {"frame": 0, "generation": 0, "playing": False, "pointer": "No pick yet"}
        )
        module = {
            "serve": {
                "tsw-demo": str(Path(__file__).with_name("tsw_demo")),
                "tsw-assets": self.assets.name,
            },
            "scripts": [
                "https://unpkg.com/maplibre-gl@5.16.0/dist/maplibre-gl.js",
                "https://unpkg.com/gl-matrix@3.4.3/gl-matrix-min.js",
                "tsw-demo/host.js",
            ],
            "styles": ["https://unpkg.com/maplibre-gl@5.16.0/dist/maplibre-gl.css"],
        }
        if vendor_dir:
            module["serve"]["tsw-vendor"] = str(Path(vendor_dir).resolve())
            module["scripts"][:2] = [
                "tsw-vendor/maplibre-gl.js",
                "tsw-vendor/gl-matrix-min.js",
            ]
            module["styles"] = ["tsw-vendor/maplibre-gl.css"]
        self.server.enable_module(module)
        self.server.trigger("demo.action")(self.action)
        self.server.trigger("demo.ready")(self.ready)
        self.server.controller.on_server_ready.add(
            lambda **_: print("SERVER_PORT:", self.server.port, flush=True)
        )
        self.server.controller.on_server_exited.add(self.close)
        with DivLayout(self.server) as layout:
            layout.root.style = "height:100vh;display:flex;flex-direction:column"
            client.Style("""
                body { margin:0; font:14px system-ui; background:#18212d; color:#eee; }
                button { margin:4px; padding:7px 10px; cursor:pointer; }
                #controls { padding:8px; background:#263345; }
                #map { flex:1; min-height:0; }
                #inspector { position:absolute; right:12px; top:145px;
                    width:300px; height:235px; background:#101820; border:1px solid #789; }
                #status { position:absolute; left:12px; bottom:12px; background:#18212ddd;
                    padding:8px; white-space:pre; pointer-events:none; }
            """)
            with html.Div(id="controls"):
                html.Strong("TSW feature exerciser — synthetic data")
                html.Span("  Frame {{ frame }} · replacement {{ generation }}")
                with html.Div():
                    for label, action in [
                        ("Step", "step"),
                        ("Play / pause", "play"),
                        ("Replace dependencies", "replace"),
                        ("Remove / re-add", "membership"),
                        ("Opacity", "opacity"),
                        ("Correction transform", "correction"),
                        ("Recover", "recover"),
                        ("Reset cameras", "camera"),
                    ]:
                        html.Button(
                            label,
                            click=lambda name=action: self.action(name),
                            id=f"action-{action}",
                        )
                    html.Button(
                        "Reload map style", click="window.tswDemo.reloadStyle()"
                    )
                    html.Button("Arm cloud pick", click="window.tswDemo.armCloudPick()")
                html.Small(
                    "Drag red landmarks. Gold: direct cloud; cyan: HTTP cloud; "
                    "orange: streamed mesh. Two numbered planes share a video texture."
                )
                html.Div("{{ pointer }}", id="pointer-status")
            html.Div(id="map")
            with html.Div(id="inspector"):
                local = VtkJsLocalView(
                    self.scene.windows[1],
                    ref="demoLocal",
                    style="width:100%;height:100%",
                    pointer_event=(self.pointer_event, "[$event, 1]"),
                )
            shared = VtkJsSharedView(
                self.scene.windows[0],
                ref="demoMap",
                style="display:none",
                pointer_event=(self.pointer_event, "[$event, 0]"),
            )
            self.views = [shared, local]
            html.Div("Starting…", id="status")

    def close(self, **_):
        if self.play_task:
            self.play_task.cancel()
        for view in self.views:
            view.close()
        self.assets.cleanup()

    def payload(self):
        return {"frame": self.scene.frame, "generation": self.scene.generation}

    def ready(self):
        for view in self.views:
            view.send_command("demo.frame", self.payload(), retain=True)
            view.set_pointer_context(self.payload())

    def publish(self, mutation):
        with ExitStack() as stack:
            for view in self.views:
                stack.enter_context(view.transaction())
            mutation()
            for view in self.views:
                view.send_command("demo.frame", self.payload(), retain=True)
                view.set_pointer_context(self.payload())
        # Match TSW's post-transaction flush: this should be a no-op.
        for view in self.views:
            view.sync()
        self.state.frame = self.scene.frame
        self.state.generation = self.scene.generation
        self.state.flush()

    def action(self, action):
        actions = {
            "step": self.scene.advance,
            "replace": self.scene.replace,
            "membership": self.scene.toggle_membership,
            "opacity": self.scene.toggle_opacity,
            "correction": self.scene.correct,
        }
        if action in actions:
            self.publish(actions[action])
        elif action == "recover":
            for view in self.views:
                view.recover()
        elif action == "camera":
            self.views[1].set_camera()
            self.views[0].send_command(
                "demo.camera", {"bearing": 0, "pitch": 45}, retain=True
            )
        elif action == "play":
            self.state.playing = not self.state.playing
            if self.state.playing and self.play_task is None:
                self.play_task = asyncio.create_task(self.animate())
        else:
            raise ValueError(f"Unknown action: {action}")
        return self.payload()

    async def animate(self):
        try:
            while self.state.playing:
                self.action("step")
                await asyncio.sleep(0.1)
        finally:
            self.play_task = None

    def pointer_event(self, event, view_index):
        if not isinstance(event, dict):
            return
        pick = event.get("pick") or {}
        self.state.pointer = f"{event.get('type')}: {pick.get('pointId', 'background')}"
        solve = event.get("cloud_solve")
        if solve:
            self.state.pointer += f" · cloud {solve.get('status')}"
        if event.get("type") == "target.drag.start":
            self.state.playing = False
        world = drag_point(event)
        if (
            world is not None
            and pick.get("tags", {}).get("generation") == self.scene.generation
        ):
            view = self.views[view_index]
            if view.event_is_current(event, pick.get("nodeId")):
                index = ["left", "middle", "right"].index(pick["pointId"])
                # Like TSW, pickable glyph centers live directly in scene space.
                local = world

                def commit_drag():
                    self.scene.glyph_data.GetPoints().SetPoint(index, *local)
                    self.scene.glyph_data.GetPoints().Modified()

                self.publish(commit_drag)
        self.state.flush()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument(
        "--vendor-dir",
        default=os.environ.get("TRAME_TSW_DEMO_VENDOR"),
        help="Optional local MapLibre 5.16.0 and gl-matrix 3.4.3 distribution files",
    )
    args, _ = parser.parse_known_args()
    FeatureDemo(args.vendor_dir).server.start()
