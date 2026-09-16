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
from trame.ui.vuetify3 import SinglePageLayout
from trame.widgets import html, client, vuetify3

from trame_vtklocal.widgets import VtkJsLocalView, VtkJsSharedView
from .fixtures import write_assets
from .scene import DemoScene
from .interaction import drag_point
from .help import help_dialog


class FeatureDemo:
    def __init__(self, vendor_dir=None):
        self.server = get_server(client_type="vue3")
        self.state = self.server.state
        self.assets = tempfile.TemporaryDirectory(prefix="trame-tsw-demo-")
        self.scene = DemoScene(write_assets(Path(self.assets.name)))
        self.play_task = None
        self.views = []
        self.state.update(
            {
                "frame": 0,
                "generation": 0,
                "playing": False,
                "pointer": "No pick yet",
                "follow_sphere": False,
                "orbit_speed": 1.0,
            }
        )
        module = {
            "serve": {
                "tsw-demo": str(Path(__file__).parent),
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
        self.server.trigger("demo.clear_pick")(self.clear_pick)
        self.server.trigger("demo.basemap_selected")(self.basemap_selected)
        self.server.controller.on_server_ready.add(
            lambda **_: print("SERVER_PORT:", self.server.port, flush=True)
        )
        self.server.controller.on_server_exited.add(self.close)
        with SinglePageLayout(self.server) as layout:
            layout.title.set_text("MapLibre + VTK.js")
            with layout.toolbar:
                vuetify3.VSelect(
                    v_model=("basemap_choice", "positron"),
                    id="basemap",
                    items=(
                        "[{title:'Light · OpenFreeMap', value:'positron'}, "
                        "{title:'Dark · OpenFreeMap', value:'dark'}, "
                        "{title:'Blank · offline', value:'blank'}]",
                    ),
                    label="Basemap",
                    density="compact",
                    hide_details=True,
                    style="max-width:190px;min-width:160px",
                    classes="mr-4",
                    update_modelValue="window.tswDemo?.setBasemap($event)",
                )
                vuetify3.VSwitch(
                    v_model=("follow_sphere",),
                    label="Follow sphere",
                    hide_details=True,
                    density="compact",
                    color="primary",
                    classes="mr-4",
                )
                vuetify3.VBtn(
                    "{{ playing ? 'Pause' : 'Play' }}",
                    click=lambda: self.action("play"),
                    color="primary",
                    variant="tonal",
                    classes="mr-3",
                )
                html.Span("Speed", classes="mr-2")
                vuetify3.VSlider(
                    v_model=("orbit_speed",),
                    min=0.1,
                    max=3,
                    step=0.1,
                    hide_details=True,
                    density="compact",
                    thumb_label=True,
                    style="max-width:140px;min-width:80px",
                    classes="mr-3",
                )
                vuetify3.VBtn(
                    "Help / What am I seeing?",
                    variant="text",
                    size="small",
                    click="window.document.getElementById('demo-help').showModal()",
                )
            layout.content.style = "display:flex;flex-direction:column;min-height:0"
            with layout.content:
                self.build_content()

    def build_content(self):
        client.Style("""
            html { overflow-y:hidden !important; }
            #demo-help { max-width:640px; max-height:80vh; overflow:auto;
                background:#f8fafc; color:#172033; border:0; border-radius:10px; padding:24px; margin:auto; }
            #demo-help::backdrop { background:#0009; }
            #demo-help p, #demo-help li, #demo-help dd { line-height:1.5; }
            #demo-help h2, #demo-help h3 { margin:12px 0; }
            #demo-help ul { padding-left:24px; }
            #demo-help dt { font-weight:700; margin-top:12px; }
            #demo-help dd { margin:4px 0 0; }
            #demo-help button { padding:6px 12px; border:1px solid #bbb; border-radius:4px; }
            #cloud-pick-mode { color:#006c79; min-height:20px; }
            #controls { padding:8px 16px; background:#fafafa; border-bottom:1px solid #ddd; }
            #map { position:absolute; inset:0; }
            #inspector { position:absolute; right:12px; top:12px;
                width:300px; height:235px; background:#101820; border:1px solid #789;
                border-radius:6px; overflow:hidden; }
            #status { position:absolute; left:12px; bottom:28px; background:#18212ddd;
                color:white; border-radius:6px; padding:8px; white-space:pre; pointer-events:none; }
        """)
        with html.Div(id="controls"):
            with html.Div(classes="d-flex flex-wrap align-center ga-1"):
                for label, action in [
                    ("Step", "step"),
                    ("Replace dependencies", "replace"),
                    ("Remove / re-add", "membership"),
                    ("Opacity", "opacity"),
                    ("Correction transform", "correction"),
                    ("Recover", "recover"),
                    ("Reset cameras", "camera"),
                ]:
                    vuetify3.VBtn(
                        label,
                        click=lambda name=action: self.action(name),
                        id=f"action-{action}",
                        variant="text",
                        size="small",
                    )
                vuetify3.VBtn(
                    "Reload map style",
                    click="window.tswDemo.reloadStyle()",
                    variant="text",
                    size="small",
                )
                vuetify3.VBtn(
                    "Pick cloud point",
                    id="cloud-pick-toggle",
                    click="window.tswDemo.armCloudPick()",
                    variant="tonal",
                    color="primary",
                    size="small",
                )
            html.Div("", id="cloud-pick-mode", classes="text-caption")
            html.Div(
                "Synthetic TSW scene · Frame {{ frame }} · replacement {{ generation }}",
                classes="text-caption text-medium-emphasis",
            )
            html.Div("{{ pointer }}", id="pointer-status", classes="text-caption")
        help_dialog()
        with html.Div(style="position:relative;flex:1;min-height:0"):
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

    def basemap_selected(self, name):
        self.state.basemap_choice = name
        self.state.flush()

    def clear_pick(self):
        self.publish(lambda: self.scene.show_pick(None))
        self.state.pointer = "No pick yet"
        self.state.flush()

    def payload(self):
        return {"frame": self.scene.frame, "generation": self.scene.generation}

    def ready(self):
        for view in self.views:
            view.send_command("demo.frame", self.payload(), retain=True)
            view.set_pointer_context(self.payload())

    def publish(self, mutation, *, follow=False):
        with ExitStack() as stack:
            for view in self.views:
                stack.enter_context(view.transaction())
            mutation()
            if follow and self.state.follow_sphere:
                self.views[0].send_command(
                    "demo.follow",
                    {"position": self.scene.orbit_position()},
                )
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

            def mutate():
                if action in ("replace", "membership", "correction"):
                    self.scene.show_pick(None)
                    self.state.pointer = "No pick yet"
                actions[action]()

            self.publish(mutate, follow=action == "step")
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
                await asyncio.sleep(0.1 / max(0.1, float(self.state.orbit_speed)))
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
            world_pick = solve.get("world") if solve.get("status") == "hit" else None
            self.publish(lambda: self.scene.show_pick(world_pick))
            if world_pick:
                self.state.pointer += (
                    " at (" + ", ".join(f"{v:.2f}" for v in solve["world"]) + ")"
                )
                self.state.pointer += (
                    f" · supporting vertex {solve.get('distance_px', 0):.1f} px away"
                )
        elif event.get("type") in ("target.click", "background.click"):
            self.publish(lambda: self.scene.show_pick(None))
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


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument(
        "--vendor-dir",
        default=os.environ.get("TRAME_TSW_DEMO_VENDOR"),
        help="Optional local MapLibre 5.16.0 and gl-matrix 3.4.3 distribution files",
    )
    args, _ = parser.parse_known_args()
    FeatureDemo(args.vendor_dir).server.start()
