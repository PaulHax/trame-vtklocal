"""Minimal MapLibre + VTK.js shared context example."""

import math
from urllib.parse import quote as url_quote
from trame.app import get_server
from trame.widgets import html
from trame.ui.html import DivLayout
from trame_vtklocal.widgets import VtkJsSharedView
from vtkmodules.vtkFiltersSources import vtkConeSource
from vtkmodules.vtkRenderingCore import vtkRenderer, vtkRenderWindow, vtkPolyDataMapper, vtkActor
import vtkmodules.vtkRenderingOpenGL2  # noqa


def lng_lat_to_mercator(lng, lat):
    x = (lng + 180) / 360
    sin_lat = math.sin(math.radians(lat))
    y = 0.5 - 0.25 * math.log((1 + sin_lat) / (1 - sin_lat)) / math.pi
    scale = 1 / (math.cos(math.radians(lat)) * 2 * math.pi * 6378137)
    return x, y, scale


# VTK scene: cone at Denver
renderer = vtkRenderer()
renderer.SetBackground(0, 0, 0)
renderer.SetBackgroundAlpha(0)

render_window = vtkRenderWindow()
render_window.AddRenderer(renderer)
render_window.OffScreenRenderingOn()

x, y, scale = lng_lat_to_mercator(-104.9903, 39.7392)
cone_scale = scale * 100000

cone = vtkConeSource()
cone.SetHeight(1.0)
cone.SetRadius(0.3)
cone.SetResolution(12)
cone.SetDirection(0, 0, -1)
cone.CappingOn()
mapper = vtkPolyDataMapper()
mapper.SetInputConnection(cone.GetOutputPort())
actor = vtkActor()
actor.SetMapper(mapper)
actor.GetProperty().SetColor(0.0, 0.5, 1.0)
actor.GetProperty().SetAmbient(0.4)
actor.GetProperty().SetDiffuse(0.6)
actor.SetPosition(x, y, cone_scale * 0.5)
actor.SetScale(cone_scale, cone_scale, cone_scale)
renderer.AddActor(actor)
render_window.Render()

# Server setup
server = get_server()
server.client_type = "vue3"
ctrl = server.controller

server.enable_module({
    "scripts": [
        "https://unpkg.com/maplibre-gl@5.16.0/dist/maplibre-gl.js",
        "https://unpkg.com/gl-matrix@3.4.3/gl-matrix-min.js",
    ],
    "styles": ["https://unpkg.com/maplibre-gl@5.16.0/dist/maplibre-gl.css"],
})

JS_INIT = """
(function() {
    let mapInitialized = false;
    let viewLight = null;
    let mat4, vec3;

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

    window.initMapVTK = async function() {
        if (mapInitialized) return;

        const vtkViewRef = window.trame?.refs?.vtkView;
        const vtkView = vtkViewRef?.initializeForSharedContext ? vtkViewRef :
                        vtkViewRef?.$.exposed || vtkViewRef;

        if (!vtkView?.initializeForSharedContext || !window.maplibregl) {
            setTimeout(window.initMapVTK, 100);
            return;
        }

        mapInitialized = true;
        ({ mat4, vec3 } = glMatrix);

        const map = new maplibregl.Map({
            container: 'map-container',
            style: 'https://tiles.openfreemap.org/styles/positron',
            center: [-104.9903, 39.7392],
            zoom: 6,
            antialias: true
        });
        window._map = map;

        await new Promise(r => map.on('load', r));
        vtkView.onRenderRequested(() => map.triggerRepaint());

        map.addLayer({
            id: 'vtk-layer',
            type: 'custom',
            renderingMode: '3d',
            onAdd(m, gl) {
                vtkView.initializeForSharedContext(m.getCanvas(), gl, {
                    syncStateAtRender: true,
                });
            },
            render(gl, args) {
                vtkView.applyQueuedStateSync();

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
        });

        window.trame.trigger('sync');
        map.on('style.load', () => {
            map.removeLayer('vtk-layer').catch(() => {});
            map.addLayer(this);
        });
    };

    // Auto-start when trame is ready
    if (document.readyState === 'complete') {
        setTimeout(window.initMapVTK, 100);
    } else {
        window.addEventListener('load', () => setTimeout(window.initMapVTK, 100));
    }
})();
"""

server.enable_module({"scripts": [f"data:text/javascript,{url_quote(JS_INIT)}"]})


def find_camera_in_state(obj, path=""):
    if obj.get("type") == "vtkCamera":
        return {"path": path, "camera": obj}
    for i, dep in enumerate(obj.get("dependencies", [])):
        result = find_camera_in_state(dep, f"{path}.dependencies[{i}]")
        if result:
            return result
    return None

@server.trigger("sync")
def sync():
    import json
    from trame_vtklocal.module.vtkjs_translator import translate_scene
    render_window.Render()
    view.object_manager.UpdateStatesFromObjects()
    state = translate_scene(view.object_manager, view._window_id)
    camera_info = find_camera_in_state(state)
    if camera_info:
        print(f"[Python] Camera found at: {camera_info['path']}")
        print(f"[Python] Camera properties: {json.dumps(camera_info['camera'].get('properties', {}), indent=2)}")
    else:
        print("[Python] No camera found in state")
    ctrl.view_update()


with DivLayout(server):
    html.Div(id="map-container", style="position: absolute; inset: 0;")
    view = VtkJsSharedView(
        render_window,
        ref="vtkView",
        style="display: none;",
        on_ready="window.initMapVTK?.()",
    )
    ctrl.view_update = view.update

server.start()
