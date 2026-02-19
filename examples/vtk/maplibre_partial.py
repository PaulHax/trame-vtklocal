"""
MapLibre + VTK.js with Partial Updates

Demonstrates efficient partial array updates for orbit trail rendering.
Uses raw lines (no TubeFilter) to enable partial updates.
"""

import math
import asyncio
import time
from urllib.parse import quote as url_quote

from trame.app import get_server
from trame.widgets import html, vuetify3
from trame.ui.vuetify3 import SinglePageLayout

from trame_vtklocal.widgets import VtkJsSharedView

from vtkmodules.vtkFiltersSources import vtkConeSource, vtkSphereSource
from vtkmodules.vtkRenderingCore import (
    vtkRenderer,
    vtkRenderWindow,
    vtkPolyDataMapper,
    vtkActor,
)
from vtkmodules.vtkCommonCore import vtkPoints
from vtkmodules.vtkCommonDataModel import vtkPolyData, vtkCellArray
from vtkmodules.vtkFiltersCore import vtkTubeFilter
import vtkmodules.vtkRenderingOpenGL2  # noqa


def lng_lat_to_mercator(lng, lat, alt=0):
    """Convert lng/lat/alt to MapLibre Mercator coordinates (0-1 range)."""
    x = (lng + 180) / 360
    sin_lat = math.sin(math.radians(lat))
    y = 0.5 - 0.25 * math.log((1 + sin_lat) / (1 - sin_lat)) / math.pi
    meters_per_unit = math.cos(math.radians(lat)) * 2 * math.pi * 6378137
    scale = 1 / meters_per_unit
    z = alt * scale
    return x, y, z, scale


server = get_server()
server.client_type = "vue3"
state, ctrl = server.state, server.controller

state.sync_mode = "partial"  # "full" or "partial"
state.trame__title = "MapLibre + VTK.js (Partial Updates)"
state.orbit_speed = 1.0
state.animation_paused = True
state.update_count = 0
state.avg_update_ms = 0

CITIES = [
    {"name": "New York", "lng": -74.006, "lat": 40.7128, "color": (1.0, 0.5, 0.0)},
    {"name": "Chicago", "lng": -87.6298, "lat": 41.8781, "color": (0.5, 1.0, 0.0)},
    {"name": "Denver", "lng": -104.9903, "lat": 39.7392, "color": (0.0, 0.5, 1.0)},
]

renderer = vtkRenderer()
renderer.SetBackground(0, 0, 0)
renderer.SetBackgroundAlpha(0)

renderWindow = vtkRenderWindow()
renderWindow.AddRenderer(renderer)
renderWindow.OffScreenRenderingOn()

cone_actors = []
cone_base_scales = []

for city in CITIES:
    x, y, z, scale = lng_lat_to_mercator(city["lng"], city["lat"])
    cone_scale = scale * 100000

    cone_source = vtkConeSource()
    cone_source.SetHeight(1.0)
    cone_source.SetRadius(0.5)
    cone_source.SetDirection(0, 0, 1)
    mapper = vtkPolyDataMapper()
    mapper.SetInputConnection(cone_source.GetOutputPort())
    actor = vtkActor()
    actor.SetMapper(mapper)
    actor.GetProperty().SetColor(*city["color"])
    actor.SetPosition(x, y, cone_scale * 0.5)
    actor.SetScale(cone_scale, cone_scale, cone_scale)
    renderer.AddActor(actor)
    cone_actors.append(actor)
    cone_base_scales.append(cone_scale)

ORBIT_CENTER = [
    (CITIES[0]["lng"] + CITIES[2]["lng"]) / 2,
    (CITIES[0]["lat"] + CITIES[2]["lat"]) / 2,
]
ORBIT_RADIUS = 8
ORBIT_ZOOM = 8

center_x, center_y, _, center_scale = lng_lat_to_mercator(
    ORBIT_CENTER[0], ORBIT_CENTER[1]
)
sphere_source = vtkSphereSource()
sphere_source.SetRadius(0.5)
sphere_source.SetThetaResolution(32)
sphere_source.SetPhiResolution(32)
center_mapper = vtkPolyDataMapper()
center_mapper.SetInputConnection(sphere_source.GetOutputPort())
center_actor = vtkActor()
center_actor.SetMapper(center_mapper)
center_actor.GetProperty().SetColor(1.0, 0.5, 0.0)
center_actor.GetProperty().SetAmbient(1.0)
center_actor.GetProperty().SetDiffuse(0.0)
center_actor.SetScale(center_scale * 50000, center_scale * 50000, center_scale * 50000)
renderer.AddActor(center_actor)

# Trail setup - dynamic topology (ring buffer)
MAX_TRAIL_POINTS = 60
trail_points = vtkPoints()
trail_lines = vtkCellArray()
trail_polydata = vtkPolyData()
trail_polydata.SetPoints(trail_points)
trail_polydata.SetLines(trail_lines)

# Pre-allocate points array but don't set positions yet
trail_points.SetNumberOfPoints(MAX_TRAIL_POINTS)
for i in range(MAX_TRAIL_POINTS):
    trail_points.SetPoint(i, 0, 0, 0)

# Lines will be rebuilt dynamically based on current point count

# TubeFilter for thick trail (like original example)
trail_tube = vtkTubeFilter()
trail_tube.SetInputData(trail_polydata)
trail_tube.SetNumberOfSides(8)
trail_tube.CappingOn()
_, _, _, initial_scale = lng_lat_to_mercator(ORBIT_CENTER[0], ORBIT_CENTER[1])
trail_tube.SetRadius(initial_scale * 50000 * 0.25)

trail_mapper = vtkPolyDataMapper()
trail_mapper.SetInputConnection(trail_tube.GetOutputPort())

trail_actor = vtkActor()
trail_actor.SetMapper(trail_mapper)
trail_actor.GetProperty().SetColor(1.0, 0.3, 0.0)
trail_actor.GetProperty().SetAmbient(1.0)
trail_actor.GetProperty().SetDiffuse(0.0)
renderer.AddActor(trail_actor)

trail_state = {
    "write_idx": 0,
    "count": 0,
    "last_cell_config": None,
    "scale_factor": None,
}

renderer.ResetCamera()
renderWindow.Render()

update_times = []
animation_task = None


def update_trail(lng, lat, scale):
    """Add a point to the orbit trail using ring buffer with dynamic topology."""
    x, y, _, _ = lng_lat_to_mercator(lng, lat)
    z_height = scale * 0.3

    # Update tube radius if scale changed significantly
    if trail_state["scale_factor"] is None or abs(trail_state["scale_factor"] - scale) > scale * 0.1:
        trail_state["scale_factor"] = scale
        trail_tube.SetRadius(scale * 0.25)

    write_idx = trail_state["write_idx"]
    trail_points.SetPoint(write_idx, x, y, z_height)

    trail_state["write_idx"] = (write_idx + 1) % MAX_TRAIL_POINTS
    if trail_state["count"] < MAX_TRAIL_POINTS:
        trail_state["count"] += 1

    count = trail_state["count"]
    if count < 2:
        return write_idx

    # Rebuild line topology to connect points in ring buffer order
    start_idx = (trail_state["write_idx"] - count + MAX_TRAIL_POINTS) % MAX_TRAIL_POINTS
    cell_config = (count, start_idx)

    if trail_state["last_cell_config"] != cell_config:
        trail_state["last_cell_config"] = cell_config
        trail_lines.Reset()
        trail_lines.InsertNextCell(count)
        for i in range(count):
            idx = (start_idx + i) % MAX_TRAIL_POINTS
            trail_lines.InsertCellPoint(idx)

    trail_points.Modified()
    trail_polydata.Modified()
    trail_tube.Update()
    trail_mapper.Update()

    return write_idx


async def animate():
    """Animate orbit marker and trail."""
    animation_time = 0.0
    last_time = time.time()
    frame_count = 0

    # Initial full sync
    ctrl.view_update()
    state.flush()
    await asyncio.sleep(0.3)

    while True:
        await asyncio.sleep(0)

        current_time = time.time()
        if not state.animation_paused:
            animation_time += (current_time - last_time) * state.orbit_speed
        last_time = current_time
        frame_count += 1

        # Update cone scales
        scale_factor = 1.0 + 0.3 * math.sin(animation_time * 4)
        for actor, base_scale in zip(cone_actors, cone_base_scales):
            current_scale = base_scale * scale_factor
            x, y, z = actor.GetPosition()
            actor.SetScale(current_scale, current_scale, current_scale)
            actor.SetPosition(x, y, current_scale * 0.5)

        # Update orbit position
        base_orbit_speed = 2 * math.pi / 20
        angle = animation_time * base_orbit_speed
        orbit_lng = ORBIT_CENTER[0] + ORBIT_RADIUS * math.cos(angle)
        orbit_lat = ORBIT_CENTER[1] + ORBIT_RADIUS * math.sin(angle) * 0.5

        marker_x, marker_y, _, marker_scale = lng_lat_to_mercator(orbit_lng, orbit_lat)
        marker_size = marker_scale * 50000
        center_actor.SetPosition(marker_x, marker_y, marker_size * 0.5)
        center_actor.SetScale(marker_size, marker_size, marker_size)

        # Update trail
        updated_idx = update_trail(orbit_lng, orbit_lat, marker_size)

        start_time = time.perf_counter()

        orbit_camera = {
            "orbitCamera": {
                "center": [orbit_lng, orbit_lat],
                "zoom": ORBIT_ZOOM,
                "bearing": 0,
                "pitch": 0,
            }
        }

        # Trail has dynamic topology - always need full sync
        # (properties_only mode is useful when mesh is static)
        ctrl.view_update(extra=orbit_camera)

        elapsed = (time.perf_counter() - start_time) * 1000
        update_times.append(elapsed)
        if len(update_times) > 60:
            update_times.pop(0)

        state.update_count += 1
        if len(update_times) > 0:
            state.avg_update_ms = sum(update_times) / len(update_times)

        state.flush()
        server.js_call("mapController", "triggerRepaint")
        await asyncio.sleep(1 / 30)


@server.trigger("start_animation")
def start_animation():
    global animation_task
    if animation_task is None:
        animation_task = asyncio.create_task(animate())


maplibre_module = {
    "scripts": ["https://unpkg.com/maplibre-gl@5.16.0/dist/maplibre-gl.js"],
    "styles": ["https://unpkg.com/maplibre-gl@5.16.0/dist/maplibre-gl.css"],
}
server.enable_module(maplibre_module)

INIT_SCRIPT_JS = """
(function() {
    let initialized = false;
    let map = null;
    let vtkView = null;
    let vtkLayerConfig = null;
    let pendingOrbitCamera = null;

    window.onVtkViewStateChange = (state) => {
        if (state?.extra?.orbitCamera) {
            pendingOrbitCamera = state.extra.orbitCamera;
        }
    };

    window.trame = window.trame || {};
    window.trame.refs = window.trame.refs || {};
    window.trame.refs.mapController = {
        triggerRepaint() {
            if (map) map.triggerRepaint();
        }
    };

    window.initMapLibreVTK = async function() {
        if (initialized) return;

        const vtkViewRef = window.trame?.refs?.['vtkView'];
        vtkView = vtkViewRef?.initializeForSharedContext ? vtkViewRef :
                  vtkViewRef?.$.exposed ? vtkViewRef.$.exposed :
                  vtkViewRef?.$.setupState;

        if (!vtkView?.initializeForSharedContext || !window.maplibregl) {
            setTimeout(window.initMapLibreVTK, 100);
            return;
        }

        initialized = true;

        map = new maplibregl.Map({
            container: 'map-container',
            style: 'https://tiles.openfreemap.org/styles/positron',
            center: [-90, 40],
            zoom: 4,
            antialias: true
        });

        await new Promise(resolve => map.on('load', resolve));

        vtkView.onRenderRequested(() => {
            map.triggerRepaint();
        });

        map.fitBounds([[-104.9903, 39.7392], [-74.006, 41.8781]], { padding: 100 });

        vtkLayerConfig = {
            id: 'vtk-layer',
            type: 'custom',
            renderingMode: '3d',
            onAdd: function(mapInstance, gl) {
                const canvas = mapInstance.getCanvas();
                vtkView.initializeForSharedContext(canvas, gl, {
                    syncStateAtRender: true,
                    onResyncRequired: () => {
                        window.trame.trigger('vtk_request_resync');
                    }
                });
            },
            render: function(gl, args) {
                vtkView.renderShared({ skipRender: true });

                if (pendingOrbitCamera) {
                    map.jumpTo({
                        center: pendingOrbitCamera.center,
                        zoom: pendingOrbitCamera.zoom,
                        bearing: pendingOrbitCamera.bearing,
                        pitch: pendingOrbitCamera.pitch,
                    });
                    pendingOrbitCamera = null;
                }

                const projData = map.transform.getProjectionDataForCustomLayer?.() || args.defaultProjectionData;
                const projMatrix = projData.mainMatrix;

                const renderer = vtkView.getRenderer();
                if (!renderer) return;

                const camera = renderer.getActiveCamera();
                const identity = new Float64Array([
                    1, 0, 0, 0,
                    0, 1, 0, 0,
                    0, 0, 1, 0,
                    0, 0, 0, 1
                ]);
                camera.setViewMatrix(identity);
                camera.setProjectionMatrix(projMatrix);
                camera.modified();

                const rw = vtkView.getRenderWindow();
                if (rw) {
                    const views = rw.getViews();
                    if (views.length > 0 && views[0].renderShared) {
                        views[0].renderShared({});
                    }
                }
            }
        };

        map.addLayer(vtkLayerConfig);
        window.trame.trigger('start_animation');
    };

    if (document.readyState === 'complete') {
        setTimeout(window.initMapLibreVTK, 100);
    } else {
        window.addEventListener('load', () => setTimeout(window.initMapLibreVTK, 100));
    }
})();
"""

server.enable_module({"scripts": [f"data:text/javascript,{url_quote(INIT_SCRIPT_JS)}"]})
server.enable_module({"styles": ["data:text/css,html { overflow-y: hidden !important; }"]})

with SinglePageLayout(server) as layout:
    layout.title.set_text("MapLibre + VTK.js (Partial Updates)")

    with layout.toolbar:
        vuetify3.VSelect(
            v_model=("sync_mode",),
            items=(
                "[{title: 'Partial Update', value: 'partial'}, "
                "{title: 'Full Sync', value: 'full'}]",
            ),
            label="Mode",
            density="compact",
            hide_details=True,
            style="max-width: 150px;",
            classes="mr-2",
        )
        vuetify3.VDivider(vertical=True, classes="mx-2")
        vuetify3.VBtn(
            "{{ animation_paused ? 'Play' : 'Pause' }}",
            click="animation_paused = !animation_paused",
            variant="text",
            size="small",
        )
        html.Span("Speed:", classes="ml-2 mr-2")
        vuetify3.VSlider(
            v_model=("orbit_speed",),
            min=0,
            max=3,
            step=0.1,
            hide_details=True,
            density="compact",
            style="max-width: 120px;",
            thumb_label=True,
        )
        vuetify3.VSpacer()
        html.Span(
            "{{ sync_mode === 'partial' ? 'Partial' : 'Full' }}: "
            "{{ avg_update_ms.toFixed(2) }}ms avg",
            style="font-family: monospace; color: #666;",
        )

    with layout.content:
        with html.Div(
            style="position: relative; width: 100%; height: 100%; overflow: hidden;",
        ):
            html.Div(
                id="map-container",
                style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;",
            )

            view = VtkJsSharedView(
                renderWindow,
                ref="vtkView",
                style="display: none;",
                on_ready="window.initMapLibreVTK && window.initMapLibreVTK()",
                view_state_change="window.onVtkViewStateChange && window.onVtkViewStateChange($event)",
            )
            ctrl.view_update = view.update
            ctrl.view_resync = view.request_resync
            ctrl.mark_modified = view.mark_modified


@server.trigger("vtk_request_resync")
def on_vtk_request_resync():
    ctrl.view_resync()


if __name__ == "__main__":
    server.start()
