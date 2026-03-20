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

state.trame__title = "MapLibre + VTK.js (Partial Updates)"
state.orbit_speed = 1.0
state.animation_paused = False
state.update_count = 0
state.avg_update_ms = 0
state.camera_mode = "orbit"

CITIES = [
    {"name": "New York", "lng": -74.006, "lat": 40.7128, "color": (1.0, 0.5, 0.0)},
    {"name": "Chicago", "lng": -87.6298, "lat": 41.8781, "color": (0.5, 1.0, 0.0)},
    {"name": "Denver", "lng": -104.9903, "lat": 39.7392, "color": (0.0, 0.5, 1.0)},
]

def set_map_camera(center, zoom, bearing=0, pitch=0, animate=True, duration=1000):
    server.js_call(
        "mapController",
        "setCamera",
        {"center": center, "zoom": zoom, "bearing": bearing, "pitch": pitch,
         "animate": animate, "duration": duration},
    )


def fit_map_bounds(bounds, padding=100, animate=True):
    server.js_call("mapController", "fitBounds", bounds, padding, animate)


def focus_city(city_name):
    city = next((c for c in CITIES if c["name"] == city_name), None)
    if city:
        set_map_camera(center=[city["lng"], city["lat"]], zoom=8)


def fit_all_cities():
    bounds = [
        [min(c["lng"] for c in CITIES), min(c["lat"] for c in CITIES)],
        [max(c["lng"] for c in CITIES), max(c["lat"] for c in CITIES)],
    ]
    fit_map_bounds(bounds, padding=100)


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
    cone_source.SetRadius(0.3)
    cone_source.SetResolution(12)
    cone_source.SetDirection(0, 0, -1)
    cone_source.CappingOn()
    mapper = vtkPolyDataMapper()
    mapper.SetInputConnection(cone_source.GetOutputPort())
    actor = vtkActor()
    actor.SetMapper(mapper)
    actor.GetProperty().SetColor(*city["color"])
    actor.GetProperty().SetAmbient(0.4)
    actor.GetProperty().SetDiffuse(0.6)
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

# Trail setup - raw line with fixed topology for partial updates
MAX_TRAIL_POINTS = 60
trail_points = vtkPoints()
trail_lines = vtkCellArray()
trail_polydata = vtkPolyData()
trail_polydata.SetPoints(trail_points)
trail_polydata.SetLines(trail_lines)

# Pre-allocate all points at the origin
trail_points.SetNumberOfPoints(MAX_TRAIL_POINTS)
for i in range(MAX_TRAIL_POINTS):
    trail_points.SetPoint(i, 0, 0, 0)

# Fixed polyline connecting all points (hidden ones overlap at leading edge)
trail_lines.InsertNextCell(MAX_TRAIL_POINTS)
for i in range(MAX_TRAIL_POINTS):
    trail_lines.InsertCellPoint(i)

trail_mapper = vtkPolyDataMapper()
trail_mapper.SetInputData(trail_polydata)

trail_actor = vtkActor()
trail_actor.SetMapper(trail_mapper)
trail_actor.GetProperty().SetColor(1.0, 0.3, 0.0)
trail_actor.GetProperty().SetAmbient(1.0)
trail_actor.GetProperty().SetDiffuse(0.0)
trail_actor.GetProperty().SetLineWidth(3)
renderer.AddActor(trail_actor)

visible_trail_count = 0

renderer.ResetCamera()
renderWindow.Render()

update_times = []
animation_task = None


def update_trail(lng, lat, scale):
    """Add a point to the orbit trail. Returns (x, y, z, point_index)."""
    global visible_trail_count
    x, y, _, _ = lng_lat_to_mercator(lng, lat)
    z_height = scale * 0.3

    if visible_trail_count < MAX_TRAIL_POINTS:
        # Growing phase: reveal next point
        idx = visible_trail_count
        trail_points.SetPoint(idx, x, y, z_height)
        # Collapse remaining hidden points onto leading edge
        for i in range(idx + 1, MAX_TRAIL_POINTS):
            trail_points.SetPoint(i, x, y, z_height)
        visible_trail_count += 1
    else:
        # Sliding window: shift all points left, add new at end
        for i in range(MAX_TRAIL_POINTS - 1):
            trail_points.SetPoint(i, *trail_points.GetPoint(i + 1))
        trail_points.SetPoint(MAX_TRAIL_POINTS - 1, x, y, z_height)

    trail_points.Modified()
    trail_polydata.Modified()
    return x, y, z_height


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
        tx, ty, tz = update_trail(orbit_lng, orbit_lat, marker_size)

        start_time = time.perf_counter()

        if state.camera_mode == "orbit":
            ctrl.view_update(
                extra={
                    "orbitCamera": {
                        "center": [orbit_lng, orbit_lat],
                        "zoom": ORBIT_ZOOM,
                        "bearing": 0,
                        "pitch": 0,
                    }
                },
            )
        else:
            ctrl.view_update()

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
    "scripts": [
        "https://unpkg.com/maplibre-gl@5.16.0/dist/maplibre-gl.js",
        "https://unpkg.com/gl-matrix@3.4.3/gl-matrix-min.js",
    ],
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
    let viewLight = null;
    const { mat4, vec3 } = glMatrix;

    const MAPLIBRE_NORTH_UP = [0, -1, 0];
    function computeViewUp(transform) {
        const rot = mat4.create();
        const up = vec3.fromValues(...MAPLIBRE_NORTH_UP);
        mat4.rotateZ(rot, rot, transform.bearingInRadians);
        mat4.rotateX(rot, rot, -transform.pitchInRadians);
        mat4.rotateZ(rot, rot, transform.rollInRadians);
        vec3.transformMat4(up, up, rot);
        vec3.normalize(up, up);
        return up;
    }

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

    window.trame = window.trame || {};
    window.trame.refs = window.trame.refs || {};
    window.trame.refs.mapController = {
        triggerRepaint() {
            if (map) map.triggerRepaint();
        },
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
                renderer.setAutomaticLightCreation(false);
                if (!viewLight) {
                    renderer.removeAllLights();
                    viewLight = renderer.makeLight();
                    viewLight.setLightTypeToSceneLight();
                    viewLight.setPositional(false);
                    renderer.addLight(viewLight);
                } else if (!renderer.hasLight(viewLight)) {
                    renderer.removeAllLights();
                    renderer.addLight(viewLight);
                }

                const cameraLngLat = map.transform.getCameraLngLat();
                const cameraAltitude = map.transform.getCameraAltitude();
                const cameraMercator = maplibregl.MercatorCoordinate.fromLngLat(
                    cameraLngLat,
                    cameraAltitude
                );
                const targetMercator = maplibregl.MercatorCoordinate.fromLngLat(
                    map.getCenter(),
                    typeof map.getCameraTargetElevation === 'function'
                        ? map.getCameraTargetElevation()
                        : 0
                );
                viewLight.setPosition(
                    cameraMercator.x,
                    cameraMercator.y,
                    cameraMercator.z
                );
                viewLight.setFocalPoint(
                    targetMercator.x,
                    targetMercator.y,
                    targetMercator.z
                );

                const viewUp = computeViewUp(map.transform);
                const viewMatrix = new Float64Array(16);
                mat4.lookAt(viewMatrix,
                    [cameraMercator.x, cameraMercator.y, cameraMercator.z],
                    [targetMercator.x, targetMercator.y, targetMercator.z],
                    viewUp
                );
                const inverseView = new Float64Array(16);
                const projectionMatrix = new Float64Array(16);
                mat4.invert(inverseView, viewMatrix);
                mat4.multiply(projectionMatrix, projMatrix, inverseView);

                camera.setViewMatrix(viewMatrix);
                camera.setProjectionMatrix(projectionMatrix);
                camera.modified();

                const rw = vtkView.getRenderWindow();
                if (rw) {
                    const views = rw.getViews();
                    if (views.length > 0 && views[0].renderShared) {
                        const previousFrontFace = gl.getParameter(gl.FRONT_FACE);
                        gl.frontFace(gl.CW);
                        try {
                            views[0].renderShared({});
                        } finally {
                            gl.frontFace(previousFrontFace);
                        }
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
            "Push: {{ avg_update_ms.toFixed(2) }}ms",
            style="font-family: monospace; color: #666; min-width: 140px; text-align: right; display: inline-block;",
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


if __name__ == "__main__":
    server.start()
