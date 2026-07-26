"""Scene factories for the push-sync oracle harness.

Each factory builds a real VTK render window registered with an
``ObjectManagerAPI`` and returns it wrapped in :class:`OracleScene`. The handles
dict carries any actors / datasets / sources the test mutates.

Mutators that change array values use :func:`set_float_array_values`. Tests
should call ``Modified()`` on whatever container they mutate so dirty observers
trigger.
"""

from dataclasses import dataclass, field
from typing import Any

# Importing the OpenGL2 backend registers the object-factory overrides that
# vtkRenderWindow() resolves to. VTK 9.6 no longer pulls it in behind
# vtkRenderingCore, so without this the scene factories build a backend-less
# render window and Render() segfaults whenever this module is the first one
# a test session imports.
from vtkmodules.vtkRenderingOpenGL2 import vtkOpenGLRenderer  # noqa: F401

from trame_vtklocal.module.protocol import ObjectManagerAPI


@dataclass
class OracleScene:
    """One oracle scene: real VTK objects + the API that owns them."""

    name: str
    api: Any
    render_window: Any
    render_window_id: int
    handles: dict[str, Any] = field(default_factory=dict)


class _ObjectManagerApiNoAttachments:
    """Minimal API stand-in that skips attachment serialization.

    Exposes no ``addAttachment`` so publishers keep raw bytes in payloads —
    tests inspect blob content directly. Blob GC delegates to the real
    ``ObjectManagerAPI`` so targeted ``UnRegisterBlob`` behavior is exercised.
    """

    def __init__(self):
        self._api = ObjectManagerAPI()
        self.vtk_object_manager = self._api.vtk_object_manager
        self._registered_push_views = {}

    def register_push_view(self, rw_id, publisher):
        self._registered_push_views[int(rw_id)] = publisher

    def unregister_push_view(self, rw_id):
        self._registered_push_views.pop(int(rw_id), None)

    def update_push_view_refs(self, rw_id, live_refs, refs_leaving):
        return self._api.update_push_view_refs(rw_id, live_refs, refs_leaving)

    def flush_stale_blobs(self):
        return self._api.flush_stale_blobs()


def set_float_array_values(vtk_array, values):
    vtk_array.SetNumberOfTuples(len(values))
    for index, tuple_values in enumerate(values):
        for component, value in enumerate(tuple_values):
            vtk_array.SetComponent(index, component, value)
    vtk_array.Modified()


def make_float_array(name, components, values):
    from vtkmodules.vtkCommonCore import vtkFloatArray

    array = vtkFloatArray()
    array.SetName(name)
    array.SetNumberOfComponents(components)
    set_float_array_values(array, values)
    return array


def make_quad_polydata():
    from vtkmodules.vtkCommonCore import vtkPoints
    from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData

    points = vtkPoints()
    for point in [
        (0.0, 0.0, 0.0),
        (1.0, 0.0, 0.0),
        (1.0, 1.0, 0.0),
        (0.0, 1.0, 0.0),
    ]:
        points.InsertNextPoint(*point)

    polys = vtkCellArray()
    polys.InsertNextCell(4)
    for point_id in range(4):
        polys.InsertCellPoint(point_id)

    tcoords = make_float_array(
        "TextureCoordinates",
        2,
        [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)],
    )
    homography = make_float_array(
        "HomographyInverse",
        16,
        [
            (
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 0.0, 1.0,
            )
        ],
    )

    polydata = vtkPolyData()
    polydata.SetPoints(points)
    polydata.SetPolys(polys)
    polydata.GetPointData().SetTCoords(tcoords)
    polydata.GetFieldData().AddArray(homography)
    return polydata, points, tcoords, homography


def make_line_polydata():
    from vtkmodules.vtkCommonCore import vtkPoints
    from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData

    points = vtkPoints()
    for point in [(0.0, 0.0, 0.0), (1.0, 1.0, 0.0), (2.0, 0.5, 0.0)]:
        points.InsertNextPoint(*point)

    lines = vtkCellArray()
    lines.InsertNextCell(3)
    for point_id in range(3):
        lines.InsertCellPoint(point_id)

    polydata = vtkPolyData()
    polydata.SetPoints(points)
    polydata.SetLines(lines)
    return polydata, points


def add_actor(renderer, polydata, visible=True):
    from vtkmodules.vtkRenderingCore import vtkActor, vtkPolyDataMapper

    mapper = vtkPolyDataMapper()
    mapper.SetInputData(polydata)
    actor = vtkActor()
    actor.SetMapper(mapper)
    actor.SetVisibility(visible)
    renderer.AddActor(actor)
    return actor, mapper


def _register_and_warmup(api, render_window):
    render_window.SetOffScreenRendering(1)
    render_window_id = api.vtk_object_manager.RegisterObject(render_window)
    render_window.Render()
    api.vtk_object_manager.UpdateStatesFromObjects()
    return render_window_id


def populate_basic(api, render_window):
    """Populate ``render_window`` with the ``basic`` scene contents.

    The e2e oracle uses this to add scene objects to a widget-owned render
    window without rebuilding it. The Python oracle keeps using
    :func:`make_basic_scene` which wraps populate with rw creation +
    register-and-warmup.
    """
    from vtkmodules.vtkCommonCore import vtkPoints
    from vtkmodules.vtkCommonDataModel import vtkPolyData
    from vtkmodules.vtkRenderingCore import (
        vtkActor,
        vtkPolyDataMapper,
        vtkRenderer,
    )

    renderer = vtkRenderer()
    render_window.AddRenderer(renderer)

    points = vtkPoints()
    points.InsertNextPoint(0.0, 0.0, 0.0)
    points.InsertNextPoint(1.0, 0.0, 0.0)
    polydata = vtkPolyData()
    polydata.SetPoints(points)

    mapper = vtkPolyDataMapper()
    mapper.SetInputData(polydata)
    actor = vtkActor()
    actor.SetMapper(mapper)
    renderer.AddActor(actor)

    return {
        "renderer": renderer,
        "actor": actor,
        "mapper": mapper,
        "polydata": polydata,
        "points": points,
    }


def make_basic_scene(name="basic"):
    """Real VTK scene: one polydata with two points, one actor, one renderer."""
    from vtkmodules.vtkRenderingCore import vtkRenderWindow

    api = _ObjectManagerApiNoAttachments()
    rw = vtkRenderWindow()
    handles = populate_basic(api, rw)
    rw_id = _register_and_warmup(api, rw)
    return OracleScene(
        name=name,
        api=api,
        render_window=rw,
        render_window_id=rw_id,
        handles=handles,
    )


def populate_quad(api, render_window):
    from vtkmodules.vtkRenderingCore import vtkRenderer

    renderer = vtkRenderer()
    render_window.AddRenderer(renderer)

    polydata, points, tcoords, homography = make_quad_polydata()
    actor, mapper = add_actor(renderer, polydata)

    return {
        "renderer": renderer,
        "actor": actor,
        "mapper": mapper,
        "polydata": polydata,
        "points": points,
        "tcoords": tcoords,
        "homography": homography,
    }


def make_quad_scene(name="quad"):
    """Polydata with point/cell topology, tcoords, and a field-data array."""
    from vtkmodules.vtkRenderingCore import vtkRenderWindow

    api = _ObjectManagerApiNoAttachments()
    rw = vtkRenderWindow()
    handles = populate_quad(api, rw)
    rw_id = _register_and_warmup(api, rw)
    return OracleScene(
        name=name,
        api=api,
        render_window=rw,
        render_window_id=rw_id,
        handles=handles,
    )


def populate_map_drape(api, render_window):
    from vtkmodules.vtkRenderingCore import vtkRenderer

    renderer = vtkRenderer()
    render_window.AddRenderer(renderer)

    footprint, footprint_points, footprint_tcoords, homography = make_quad_polydata()
    frustum, frustum_points = make_line_polydata()
    connection, connection_points = make_line_polydata()
    trail, trail_points = make_line_polydata()

    footprint_actor, _ = add_actor(renderer, footprint, visible=True)
    frustum_actor, _ = add_actor(renderer, frustum, visible=False)
    connection_actor, _ = add_actor(renderer, connection, visible=True)
    trail_actor, _ = add_actor(renderer, trail, visible=True)

    return {
        "renderer": renderer,
        "actors": [
            footprint_actor,
            frustum_actor,
            connection_actor,
            trail_actor,
        ],
        "footprint": footprint,
        "footprint_points": footprint_points,
        "footprint_tcoords": footprint_tcoords,
        "homography": homography,
        "frustum": frustum,
        "frustum_points": frustum_points,
        "connection": connection,
        "connection_points": connection_points,
        "trail": trail,
        "trail_points": trail_points,
    }


def make_map_drape_scene(name="map_drape"):
    """A four-actor scene close to what a downstream map-drape app pushes per frame."""
    from vtkmodules.vtkRenderingCore import vtkRenderWindow

    api = _ObjectManagerApiNoAttachments()
    rw = vtkRenderWindow()
    handles = populate_map_drape(api, rw)
    rw_id = _register_and_warmup(api, rw)
    return OracleScene(
        name=name,
        api=api,
        render_window=rw,
        render_window_id=rw_id,
        handles=handles,
    )


def populate_scalars(api, render_window):
    from vtkmodules.vtkRenderingCore import vtkRenderer

    renderer = vtkRenderer()
    render_window.AddRenderer(renderer)

    polydata, points, _tcoords, _homography = make_quad_polydata()
    point_scalars = make_float_array("PointScalars", 1, [(0.0,), (0.5,), (1.0,), (0.5,)])
    cell_scalars = make_float_array("CellScalars", 1, [(0.25,)])
    polydata.GetPointData().SetScalars(point_scalars)
    polydata.GetCellData().SetScalars(cell_scalars)

    actor, mapper = add_actor(renderer, polydata)

    return {
        "renderer": renderer,
        "actor": actor,
        "mapper": mapper,
        "polydata": polydata,
        "points": points,
        "point_scalars": point_scalars,
        "cell_scalars": cell_scalars,
    }


def make_scalars_scene(name="scalars"):
    """Quad polydata with point-data and cell-data scalar arrays."""
    from vtkmodules.vtkRenderingCore import vtkRenderWindow

    api = _ObjectManagerApiNoAttachments()
    rw = vtkRenderWindow()
    handles = populate_scalars(api, rw)
    rw_id = _register_and_warmup(api, rw)
    return OracleScene(
        name=name,
        api=api,
        render_window=rw,
        render_window_id=rw_id,
        handles=handles,
    )


def populate_polyline(api, render_window):
    from vtkmodules.vtkRenderingCore import vtkRenderer

    renderer = vtkRenderer()
    render_window.AddRenderer(renderer)

    polydata, points = make_line_polydata()
    actor, mapper = add_actor(renderer, polydata)

    return {
        "renderer": renderer,
        "actor": actor,
        "mapper": mapper,
        "polydata": polydata,
        "points": points,
    }


def make_polyline_scene(name="polyline"):
    """Lines polydata, easy to swap the cell array for verts/lines/polys/strips."""
    from vtkmodules.vtkRenderingCore import vtkRenderWindow

    api = _ObjectManagerApiNoAttachments()
    rw = vtkRenderWindow()
    handles = populate_polyline(api, rw)
    rw_id = _register_and_warmup(api, rw)
    return OracleScene(
        name=name,
        api=api,
        render_window=rw,
        render_window_id=rw_id,
        handles=handles,
    )


def populate_pipeline_cone(api, render_window):
    from vtkmodules.vtkFiltersSources import vtkConeSource
    from vtkmodules.vtkRenderingCore import (
        vtkActor,
        vtkPolyDataMapper,
        vtkRenderer,
    )

    renderer = vtkRenderer()
    render_window.AddRenderer(renderer)

    source = vtkConeSource()
    source.SetResolution(6)
    mapper = vtkPolyDataMapper()
    mapper.SetInputConnection(source.GetOutputPort())
    actor = vtkActor()
    actor.SetMapper(mapper)
    renderer.AddActor(actor)

    return {
        "renderer": renderer,
        "source": source,
        "mapper": mapper,
        "actor": actor,
    }


def make_pipeline_cone_scene(name="pipeline_cone"):
    """Mapper fed by a vtkConeSource via SetInputConnection (single-stage pipeline)."""
    from vtkmodules.vtkRenderingCore import vtkRenderWindow

    api = _ObjectManagerApiNoAttachments()
    rw = vtkRenderWindow()
    handles = populate_pipeline_cone(api, rw)
    rw_id = _register_and_warmup(api, rw)
    return OracleScene(
        name=name,
        api=api,
        render_window=rw,
        render_window_id=rw_id,
        handles=handles,
    )


def populate_two_stage_pipeline(api, render_window):
    from vtkmodules.vtkFiltersCore import vtkTriangleFilter
    from vtkmodules.vtkFiltersSources import vtkSphereSource
    from vtkmodules.vtkRenderingCore import (
        vtkActor,
        vtkPolyDataMapper,
        vtkRenderer,
    )

    renderer = vtkRenderer()
    render_window.AddRenderer(renderer)

    source = vtkSphereSource()
    source.SetThetaResolution(6)
    source.SetPhiResolution(6)
    triangle = vtkTriangleFilter()
    triangle.SetInputConnection(source.GetOutputPort())
    mapper = vtkPolyDataMapper()
    mapper.SetInputConnection(triangle.GetOutputPort())
    actor = vtkActor()
    actor.SetMapper(mapper)
    renderer.AddActor(actor)

    return {
        "renderer": renderer,
        "source": source,
        "filter": triangle,
        "mapper": mapper,
        "actor": actor,
    }


def make_two_stage_pipeline_scene(name="two_stage_pipeline"):
    """Source -> filter -> mapper. Mutating either stage must patch the dataset."""
    from vtkmodules.vtkRenderingCore import vtkRenderWindow

    api = _ObjectManagerApiNoAttachments()
    rw = vtkRenderWindow()
    handles = populate_two_stage_pipeline(api, rw)
    rw_id = _register_and_warmup(api, rw)
    return OracleScene(
        name=name,
        api=api,
        render_window=rw,
        render_window_id=rw_id,
        handles=handles,
    )


# Registry mapping scene name -> (populate_callable, mutator_for_step) so the
# e2e test app and Python oracle can dispatch by name without duplicating
# factory mappings.
SCENE_POPULATORS = {
    "basic": populate_basic,
    "quad": populate_quad,
    "map_drape": populate_map_drape,
    "scalars": populate_scalars,
    "polyline": populate_polyline,
    "pipeline_cone": populate_pipeline_cone,
    "two_stage_pipeline": populate_two_stage_pipeline,
}


def mutate_map_drape_frame(scene: OracleScene, frame_index: int):
    handles = scene.handles
    offset = frame_index * 0.1
    for index in range(4):
        x = float(index % 2) + offset
        y = float(index // 2) + offset * 0.5
        handles["footprint_points"].SetPoint(index, x, y, 0.0)
    handles["footprint_points"].Modified()

    set_float_array_values(
        handles["footprint_tcoords"],
        [
            (0.0 + offset, 0.0),
            (1.0 + offset, 0.0),
            (1.0 + offset, 1.0),
            (0.0 + offset, 1.0),
        ],
    )
    set_float_array_values(
        handles["homography"],
        [
            (
                1.0, 0.0, offset, 0.0,
                0.0, 1.0, offset * 0.5, 0.0,
                0.0, 0.0, 1.0, 0.0,
                offset, offset * 0.5, 0.0, 1.0,
            )
        ],
    )

    for index in range(3):
        handles["frustum_points"].SetPoint(
            index, offset + index, offset, index * 0.25
        )
        handles["connection_points"].SetPoint(index, offset, index + offset, 0.0)
        handles["trail_points"].SetPoint(
            index, index * 0.5, offset + index * 0.1, 0.0
        )
    for key in ["frustum_points", "connection_points", "trail_points"]:
        handles[key].Modified()

    handles["actors"][0].SetVisibility(True)
    handles["actors"][1].SetVisibility(frame_index % 2 == 0)
    handles["actors"][2].SetVisibility(True)
    handles["actors"][3].SetVisibility(frame_index % 3 != 0)
    for key in ["footprint", "frustum", "connection", "trail"]:
        handles[key].Modified()
