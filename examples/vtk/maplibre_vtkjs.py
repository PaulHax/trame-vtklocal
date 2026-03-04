"""
MapLibre + VTK.js Shared Context Example (trame-vtklocal)

This example demonstrates how to use VtkJsSharedView with an external WebGL context
shared with MapLibre GL JS. VTK renders 3D cones at geographic city locations.

This uses trame-vtklocal's vtk.js rendering mode (not WASM).
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

state.sync_mode = True
state.camera_mode = "orbit"
state.basemap = "openfreemap_positron"
state.trame__title = "MapLibre + VTK.js (trame-vtklocal)"
state.orbit_speed = 1.0
state.animation_paused = True

CITIES = [
    {"name": "New York", "lng": -74.006, "lat": 40.7128, "color": (1.0, 0.5, 0.0)},
    {"name": "Chicago", "lng": -87.6298, "lat": 41.8781, "color": (0.5, 1.0, 0.0)},
    {"name": "Denver", "lng": -104.9903, "lat": 39.7392, "color": (0.0, 0.5, 1.0)},
]


def set_map_camera(center, zoom, bearing=0, pitch=0, animate=True, duration=1000):
    """Set MapLibre camera position from Python."""
    server.js_call(
        "mapController",
        "setCamera",
        {
            "center": center,
            "zoom": zoom,
            "bearing": bearing,
            "pitch": pitch,
            "animate": animate,
            "duration": duration,
        },
    )


def fit_map_bounds(bounds, padding=100, animate=True):
    """Fit map to bounds. bounds = [[west, south], [east, north]]"""
    server.js_call("mapController", "fitBounds", bounds, padding, animate)


@server.trigger("map_camera_response")
def on_map_camera_response(camera):
    """Called by JS when camera is requested."""
    print(
        f"Map camera: center={camera['center']}, zoom={camera['zoom']:.2f}, "
        f"bearing={camera['bearing']:.1f}, pitch={camera['pitch']:.1f}",
        flush=True,
    )


def get_map_camera():
    """Request current camera from JS (response via trigger)."""
    server.js_call("mapController", "getCamera")


def focus_city(city_name):
    city = next((c for c in CITIES if c["name"] == city_name), None)
    if city:
        set_map_camera(
            center=[city["lng"], city["lat"]],
            zoom=8,
            bearing=0,
            pitch=0,
        )
        print(f"Flying to {city_name}", flush=True)


def fit_all_cities():
    bounds = [
        [min(c["lng"] for c in CITIES), min(c["lat"] for c in CITIES)],
        [max(c["lng"] for c in CITIES), max(c["lat"] for c in CITIES)],
    ]
    fit_map_bounds(bounds, padding=100)
    print("Fitting all cities", flush=True)


def print_camera():
    get_map_camera()


@state.change("camera_mode")
def on_camera_mode_change(camera_mode, **kwargs):
    if camera_mode == "new_york":
        focus_city("New York")
    elif camera_mode == "chicago":
        focus_city("Chicago")
    elif camera_mode == "denver":
        focus_city("Denver")
    elif camera_mode == "fit_all":
        fit_all_cities()


@state.change("basemap")
def on_basemap_change(basemap, **kwargs):
    print(f"Switching basemap to: {basemap}", flush=True)
    server.js_call("mapController", "setBasemap", basemap)


# VTK setup
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

renderer.ResetCamera()
renderWindow.Render()

animation_task = None

ORBIT_CENTER = [
    (CITIES[0]["lng"] + CITIES[2]["lng"]) / 2,
    (CITIES[0]["lat"] + CITIES[2]["lat"]) / 2,
]
ORBIT_RADIUS = 8
ORBIT_ZOOM = 8
ORBIT_PITCH = 0

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

MAX_TRAIL_POINTS = 60
trail_points = vtkPoints()
trail_lines = vtkCellArray()
trail_polydata = vtkPolyData()
trail_polydata.SetPoints(trail_points)
trail_polydata.SetLines(trail_lines)

trail_points.SetNumberOfPoints(MAX_TRAIL_POINTS)
for i in range(MAX_TRAIL_POINTS):
    trail_points.SetPoint(i, 0, 0, 0)

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
    "scale_factor": None,
    "write_idx": 0,
    "count": 0,
    "last_cell_config": None,
}


def update_trail(lng, lat, scale):
    """Add a point to the orbit trail using ring buffer (O(1) per frame)."""
    x, y, z, _ = lng_lat_to_mercator(lng, lat)
    z_height = scale * 0.3

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
        return

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


async def animate_cones():
    """Animate cone scales and orbit camera to show sync difference."""
    animation_time = 0.0
    last_time = time.time()
    while True:
        await asyncio.sleep(0)

        current_time = time.time()
        if not state.animation_paused:
            animation_time += (current_time - last_time) * state.orbit_speed
        last_time = current_time

        scale_factor = 1.0 + 0.3 * math.sin(animation_time * 4)
        for actor, base_scale in zip(cone_actors, cone_base_scales):
            current_scale = base_scale * scale_factor
            x, y, z = actor.GetPosition()
            actor.SetScale(current_scale, current_scale, current_scale)
            actor.SetPosition(x, y, current_scale * 0.5)

        base_orbit_speed = 2 * math.pi / 20
        angle = animation_time * base_orbit_speed
        orbit_lng = ORBIT_CENTER[0] + ORBIT_RADIUS * math.cos(angle)
        orbit_lat = ORBIT_CENTER[1] + ORBIT_RADIUS * math.sin(angle) * 0.5

        marker_x, marker_y, _, marker_scale = lng_lat_to_mercator(orbit_lng, orbit_lat)
        marker_size = marker_scale * 50000
        center_actor.SetPosition(marker_x, marker_y, marker_size * 0.5)
        center_actor.SetScale(marker_size, marker_size, marker_size)
        update_trail(orbit_lng, orbit_lat, marker_size)

        if state.camera_mode == "orbit":
            ctrl.view_update(
                extra={
                    "orbitCamera": {
                        "center": [orbit_lng, orbit_lat],
                        "zoom": ORBIT_ZOOM,
                        "bearing": 0,
                        "pitch": ORBIT_PITCH,
                    }
                },
            )
        else:
            ctrl.view_update()

        server.js_call("mapController", "triggerRepaint")
        await asyncio.sleep(1 / 30)


@server.trigger("start_animation")
def start_animation():
    global animation_task
    if animation_task is None:
        animation_task = asyncio.create_task(animate_cones())


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
    let ignoreOrbitCameraUntil = 0;

    const BASEMAPS = {
        openfreemap_positron: 'https://tiles.openfreemap.org/styles/positron',
        osm: {
            version: 8,
            sources: {
                basemap: {
                    type: 'raster',
                    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                    tileSize: 256,
                    attribution: '© OpenStreetMap contributors'
                }
            },
            layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }]
        },
        carto_light: {
            version: 8,
            sources: {
                basemap: {
                    type: 'raster',
                    tiles: ['https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'],
                    tileSize: 256,
                    attribution: '© CARTO'
                }
            },
            layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }]
        },
        carto_dark: {
            version: 8,
            sources: {
                basemap: {
                    type: 'raster',
                    tiles: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],
                    tileSize: 256,
                    attribution: '© CARTO'
                }
            },
            layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }]
        },
    };

    window.onVtkViewStateChange = (state) => {
        if (state?.extra?.orbitCamera) {
            if (Date.now() < ignoreOrbitCameraUntil) {
                pendingOrbitCamera = null;
                return;
            }
            pendingOrbitCamera = state.extra.orbitCamera;
        } else {
            pendingOrbitCamera = null;
        }
    };

    const urlParams = new URLSearchParams(window.location.search);
    const syncMode = urlParams.get('sync') !== 'false';

    window.trame = window.trame || {};
    window.trame.refs = window.trame.refs || {};
    window.trame.refs.mapController = {
        setCamera({ center, zoom, bearing = 0, pitch = 0, animate = true, duration = 1000 }) {
            if (!map) return;
            pendingOrbitCamera = null;
            ignoreOrbitCameraUntil = Date.now() + (animate ? duration : 100);
            const options = { center, zoom, bearing, pitch };
            if (animate) {
                map.flyTo({ ...options, duration });
            } else {
                map.jumpTo(options);
            }
        },
        fitBounds(bounds, padding = 100, animate = true) {
            if (!map) return;
            pendingOrbitCamera = null;
            ignoreOrbitCameraUntil = Date.now() + (animate ? 1000 : 100);
            map.fitBounds(bounds, { padding, animate });
        },
        getCamera() {
            if (!map) return;
            const center = map.getCenter();
            const camera = {
                center: [center.lng, center.lat],
                zoom: map.getZoom(),
                bearing: map.getBearing(),
                pitch: map.getPitch()
            };
            window.trame.trigger('map_camera_response', [camera]);
        },
        triggerRepaint() {
            if (map) map.triggerRepaint();
        },
        toggleSyncMode() {
            const newMode = !syncMode;
            const url = new URL(window.location);
            url.searchParams.set('sync', newMode);
            window.location.href = url.toString();
        },
        getSyncMode() {
            return syncMode;
        },
        setBasemap(basemapId) {
            if (!map) return;
            const style = BASEMAPS[basemapId];
            if (!style) {
                console.warn('Unknown basemap:', basemapId);
                return;
            }
            console.log('Setting basemap to:', basemapId);
            map.setStyle(style);
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
            style: BASEMAPS.openfreemap_positron,
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
            id: 'vtk-cones',
            type: 'custom',
            renderingMode: '3d',
            onAdd: function(mapInstance, gl) {
                console.log('VTK layer onAdd called');
                const canvas = mapInstance.getCanvas();
                const options = syncMode ? { syncStateAtRender: true } : {};
                vtkView.initializeForSharedContext(canvas, gl, options);
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

        map.on('style.load', () => {
            console.log('style.load event fired');
            if (vtkLayerConfig) {
                try {
                    if (map.getLayer('vtk-cones')) {
                        map.removeLayer('vtk-cones');
                    }
                } catch (e) {}
                console.log('Re-adding VTK layer');
                map.addLayer(vtkLayerConfig);
            }
        });

        document.title = syncMode ?
            'MapLibre + VTK.js (SYNC mode)' :
            'MapLibre + VTK.js (ASYNC mode)';

        window.trame.trigger('start_animation');
    };

    // Auto-start when page is ready
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
    layout.title.set_text("MapLibre + VTK.js Geo Cones")

    with layout.toolbar:
        vuetify3.VSelect(
            v_model=("basemap",),
            items=(
                "[{title: 'OpenFreeMap Positron', value: 'openfreemap_positron'}, "
                "{title: 'OpenStreetMap', value: 'osm'}, "
                "{title: 'CARTO Light', value: 'carto_light'}, "
                "{title: 'CARTO Dark', value: 'carto_dark'}]",
            ),
            label="Basemap",
            density="compact",
            hide_details=True,
            style="max-width: 150px;",
            classes="mr-2",
        )
        vuetify3.VDivider(vertical=True, classes="mx-2")
        with vuetify3.VBtnToggle(
            v_model=("camera_mode",),
            mandatory=True,
            density="compact",
            color="primary",
        ):
            vuetify3.VBtn("Orbit", value="orbit", size="small")
            vuetify3.VBtn("New York", value="new_york", size="small")
            vuetify3.VBtn("Chicago", value="chicago", size="small")
            vuetify3.VBtn("Denver", value="denver", size="small")
            vuetify3.VBtn("Fit All", value="fit_all", size="small")
        vuetify3.VDivider(vertical=True, classes="mx-2")
        vuetify3.VBtn("Print Camera", click=print_camera, variant="text", size="small")
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


import sys

if "--sync=false" in sys.argv or "--async" in sys.argv:
    state.sync_mode = False
    print("Starting in ASYNC mode")
else:
    state.sync_mode = True
    print("Starting in SYNC mode (default)")

print("Use ?sync=false in URL or 'Toggle Mode' button to switch")

server.start()
