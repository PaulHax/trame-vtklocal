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
cone.SetDirection(0, 0, 1)
mapper = vtkPolyDataMapper()
mapper.SetInputConnection(cone.GetOutputPort())
actor = vtkActor()
actor.SetMapper(mapper)
actor.GetProperty().SetColor(0.0, 0.5, 1.0)
actor.SetPosition(x, y, cone_scale * 0.5)
actor.SetScale(cone_scale, cone_scale, cone_scale)
renderer.AddActor(actor)
render_window.Render()

# Server setup
server = get_server()
server.client_type = "vue3"
ctrl = server.controller

server.enable_module({
    "scripts": ["https://unpkg.com/maplibre-gl@5.16.0/dist/maplibre-gl.js"],
    "styles": ["https://unpkg.com/maplibre-gl@5.16.0/dist/maplibre-gl.css"],
})

JS_INIT = """
(function() {
    let mapInitialized = false;
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

        const map = new maplibregl.Map({
            container: 'map-container',
            style: 'https://tiles.openfreemap.org/styles/positron',
            center: [-104.9903, 39.7392],
            zoom: 6,
            antialias: true
        });

        await new Promise(r => map.on('load', r));
        vtkView.onRenderRequested(() => map.triggerRepaint());

        map.addLayer({
            id: 'vtk-layer',
            type: 'custom',
            renderingMode: '3d',
            onAdd(m, gl) {
                vtkView.initializeForSharedContext(m.getCanvas(), gl, {
                    syncStateAtRender: true,
                    onResyncRequired: () => window.trame.trigger('resync')
                });
            },
            render(gl, args) {
                vtkView.renderShared({ skipRender: true });
                const renderer = vtkView.getRenderer();
                if (!renderer) return;

                const proj = map.transform.getProjectionDataForCustomLayer?.() || args.defaultProjectionData;
                const cam = renderer.getActiveCamera();
                cam.setViewMatrix(new Float64Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]));
                cam.setProjectionMatrix(proj.mainMatrix);
                cam.modified();

                const views = vtkView.getRenderWindow()?.getViews();
                if (views?.[0]?.renderShared) views[0].renderShared({});
            }
        });

        window.trame.trigger('sync');
        map.on('style.load', () => {
            map.removeLayer('vtk-layer').catch(() => {});
            map.addLayer(this);
        });
    };
})();
"""

server.enable_module({"scripts": [f"data:text/javascript,{url_quote(JS_INIT)}"]})


@server.trigger("sync")
def sync():
    ctrl.view_update(inline_arrays=True)


@server.trigger("resync")
def resync():
    ctrl.view_resync()


with DivLayout(server):
    html.Div(id="map-container", style="position: absolute; inset: 0;")
    view = VtkJsSharedView(
        render_window,
        ref="vtkView",
        style="display: none;",
        on_ready="window.initMapVTK?.()",
    )
    ctrl.view_update = view.update
    ctrl.view_resync = view.request_resync

server.start()
