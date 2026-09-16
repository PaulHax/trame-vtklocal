"""In-page guide for the synthetic scene."""

from trame.widgets import html


def help_dialog():
    with html.Dialog(id="demo-help"):
        html.Button(
            "Close help",
            style="float:right",
            click="window.document.getElementById('demo-help').close()",
        )
        html.H2("Explore the TSW demo", id="demo-help-title")
        html.P(
            "Start with Step, then Replace dependencies, then Step again. "
            "Both views should keep changing together. Everything shown is synthetic: "
            "the objects are placed near New York for context, not surveyed there."
        )
        html.H3("What you see")
        with html.Ul():
            for text in [
                "Gold points: a direct point cloud. One point moves each frame.",
                "Cyan points: a cloud loaded over HTTP, using the streaming renderer.",
                "Orange triangle: a streamed, textured 3D Tiles mesh.",
                "Green cone: a live VTK pipeline and transform.",
                "Blue sphere and trail: the orbiting marker. Play animates it; "
                "Follow sphere moves the map camera with it.",
                "Red dots: landmarks that stay the same size on screen. Drag one in either view; "
                "the other view receives the confirmed edit. Dragging pauses playback.",
                "Numbered planes: two ways to project the same synthetic video frame. "
                "Geometry waits for matching pixels; the bottom status numbers should agree.",
                "Inset: an independent camera looking at the same objects. "
                "The main view shares its canvas and camera with MapLibre.",
            ]:
                html.Li(text)
        html.H3("Cloud picking")
        html.P(
            "Pick cloud point turns on a persistent mode for the main map. "
            "Click the cyan cloud to find a 3D point along the cursor ray. "
            "A white marker in both views shows the returned 3D position. "
            "The search tries 10, 20, then 100 CSS-pixel radii and uses the frontmost "
            "vertex in the smallest nonempty radius to choose depth. The marker lies on "
            "the cursor ray at that depth; it is not snapped to that vertex. "
            "The reported pixel distance is to the supporting vertex, not to the marker. "
            "This deliberately permits hits outside the visible cloud. Misses and scene "
            "corrections clear the marker. "
            "It does not add or move a landmark or perform registration; it demonstrates "
            "the depth-picking input that TSW uses for registration. "
            "Stop cloud picking returns to ordinary clicks. Landmark dragging still works."
        )
        html.H3("Controls")
        with html.Dl():
            for label, description in [
                (
                    "Basemap",
                    "Light map is the default, with a dark map and a blank offline option. "
                    "Online maps use OpenFreeMap; their attribution remains on the map.",
                ),
                (
                    "Step / Play",
                    "Advance one frame or animate at roughly ten frames per second. "
                    "The speed slider scales playback; Follow sphere tracks the blue marker.",
                ),
                (
                    "Replace dependencies",
                    "Replace points, a property, a transform and a pipeline "
                    "connection. Step afterward to check that their later edits still arrive.",
                ),
                (
                    "Remove / re-add",
                    "Detach or restore both clouds, the mesh and the cone. "
                    "The landmarks and video planes remain.",
                ),
                (
                    "Opacity",
                    "Toggle the clouds and mesh between opaque and translucent.",
                ),
                (
                    "Correction transform",
                    "Move the streamed cloud and mesh one scene unit north "
                    "per click, as a simple registration correction.",
                ),
                (
                    "Recover",
                    "Scan server modification times for changes whose notifications were "
                    "missed. Usually nothing changes: normal edits already publish automatically.",
                ),
                (
                    "Reset cameras",
                    "Restore the inset camera and the main map's north-up bearing "
                    "and 45° pitch. The map's current center and zoom remain.",
                ),
                (
                    "Reload map style",
                    "Reload the selected basemap and reattach the VTK layer. "
                    "The scene and its shared WebGL context should survive.",
                ),
                (
                    "Map navigation",
                    "Drag the background to pan; scroll to zoom. "
                    "Right-drag or Ctrl-drag to rotate/tilt. The inset has its own camera.",
                ),
                (
                    "Reload the page",
                    "Reconnect and restore the current scene and numbered texture.",
                ),
            ]:
                html.Dt(label)
                html.Dd(description)
        html.P(
            "This small scene checks behavior, not large-data performance or real video decoding."
        )
