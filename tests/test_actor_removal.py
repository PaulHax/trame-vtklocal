"""Structural add/remove and distance-to-camera translation regressions.

Structural changes have no full-sync fallback in push sync v2: an added or
removed actor must round-trip through flat-node translation + the scene
store as plain ``upsert``/``remove`` ops. The distance-to-camera cases guard
the serialization bypass (the server-side filter must never execute
renderer-less) and the glyph-mapper input bridging.
"""

from trame_vtklocal.module.distance_to_camera import (
    bypass_distance_to_camera_for_serialization,
)
from trame_vtklocal.module.node_translator import translate_object, translate_scene
from trame_vtklocal.module.protocol import ObjectManagerAPI
from trame_vtklocal.store import SceneStore

from vtkmodules.vtkCommonCore import vtkPoints
from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData
from vtkmodules.vtkFiltersSources import vtkSphereSource
from vtkmodules.vtkRenderingCore import (
    vtkActor,
    vtkDistanceToCamera,
    vtkGlyph3DMapper,
    vtkPolyDataMapper,
    vtkRenderer,
    vtkRenderWindow,
)
from vtkmodules.vtkRenderingOpenGL2 import vtkOpenGLRenderer  # noqa: F401


def make_actor():
    src = vtkSphereSource()
    src.Update()
    mapper = vtkPolyDataMapper()
    mapper.SetInputConnection(src.GetOutputPort())
    actor = vtkActor()
    actor.SetMapper(mapper)
    return actor


def get_object_manager():
    from vtkmodules.vtkSerializationManager import vtkObjectManager

    om = vtkObjectManager()
    om.Initialize()
    return om


def make_cross_polydata():
    points = vtkPoints()
    lines = vtkCellArray()
    for dx, dy, dz in ((1, 0, 0), (0, 1, 0), (0, 0, 1)):
        a = points.InsertNextPoint(-dx, -dy, -dz)
        b = points.InsertNextPoint(dx, dy, dz)
        lines.InsertNextCell(2)
        lines.InsertCellPoint(a)
        lines.InsertCellPoint(b)

    polydata = vtkPolyData()
    polydata.SetPoints(points)
    polydata.SetLines(lines)
    return polydata


def test_remove_actor_round_trips_as_store_removals():
    rw = vtkRenderWindow()
    rw.SetOffScreenRendering(1)
    renderer = vtkRenderer()
    rw.AddRenderer(renderer)

    actor1 = make_actor()
    actor2 = make_actor()
    renderer.AddActor(actor1)
    renderer.AddActor(actor2)

    om = get_object_manager()
    rw_id = om.RegisterObject(rw)
    rw.Render()
    om.UpdateStatesFromObjects()

    renderer_id = str(om.GetId(renderer))
    actor1_id = str(om.GetId(actor1))
    actor2_id = str(om.GetId(actor2))

    nodes = translate_scene(om, rw_id)
    assert set(nodes[renderer_id]["refs"]["viewProps"]) == {actor1_id, actor2_id}
    store = SceneStore(str(rw_id))
    store.transact().upsert_nodes(nodes).commit()

    renderer.RemoveActor(actor1)
    rw.Render()
    om.UpdateStatesFromObjects()

    after = translate_scene(om, rw_id)
    assert after[renderer_id]["refs"]["viewProps"] == [actor2_id]
    result = store.transact().upsert_nodes(after).commit()

    removed = {op["id"] for op in result["ops"] if op["op"] == "remove"}
    assert actor1_id in removed
    assert actor2_id not in removed
    assert store.snapshot()["nodes"] == after


def test_glyph_mapper_keeps_source_input_on_port_one():
    rw = vtkRenderWindow()
    rw.SetOffScreenRendering(1)
    renderer = vtkRenderer()
    rw.AddRenderer(renderer)

    centers_points = vtkPoints()
    centers_points.InsertNextPoint(-0.5, 0.0, 0.0)
    centers_points.InsertNextPoint(0.5, 0.0, 0.0)
    centers = vtkPolyData()
    centers.SetPoints(centers_points)
    source = make_cross_polydata()

    mapper = vtkGlyph3DMapper()
    mapper.SetInputData(centers)
    mapper.SetSourceData(source)
    mapper.SetScaleFactor(0.2)
    mapper.OrientOff()
    mapper.SetScalarVisibility(False)

    actor = vtkActor()
    actor.SetMapper(mapper)
    renderer.AddActor(actor)
    renderer.ResetCamera()

    om = get_object_manager()
    rw_id = om.RegisterObject(rw)
    rw.Render()
    om.UpdateStatesFromObjects()

    nodes = translate_scene(om, rw_id)
    mapper_node = nodes[str(om.GetId(mapper))]

    assert mapper_node["type"] == "vtkGlyph3DMapper"
    centers_id = str(om.GetId(centers))
    source_id = str(om.GetId(source))
    assert mapper_node["refs"]["inputs"] == [centers_id, source_id]
    assert centers_id in nodes
    assert source_id in nodes


def _make_dtc_glyph_window():
    rw = vtkRenderWindow()
    rw.SetOffScreenRendering(1)
    renderer = vtkRenderer()
    rw.AddRenderer(renderer)

    centers_points = vtkPoints()
    centers_points.InsertNextPoint(-0.5, 0.0, 0.0)
    centers = vtkPolyData()
    centers.SetPoints(centers_points)

    distance_to_camera = vtkDistanceToCamera()
    distance_to_camera.SetInputData(centers)
    distance_to_camera.SetScreenSize(36)

    source = make_cross_polydata()
    mapper = vtkGlyph3DMapper()
    mapper.SetInputConnection(distance_to_camera.GetOutputPort())
    mapper.SetSourceData(source)
    mapper.SetScaleArray("DistanceToCamera")
    mapper.SetScaleModeToScaleByMagnitude()
    mapper.OrientOff()
    mapper.SetScalarVisibility(False)

    actor = vtkActor()
    actor.SetMapper(mapper)
    renderer.AddActor(actor)
    renderer.ResetCamera()
    return rw, mapper, centers


def test_distance_to_camera_serialization_bypasses_server_filter(capfd):
    rw, mapper, centers = _make_dtc_glyph_window()
    capfd.readouterr()

    om = get_object_manager()
    rw_id = om.RegisterObject(rw)
    with bypass_distance_to_camera_for_serialization(rw):
        rw.Render()
        om.UpdateStatesFromObjects()

    captured = capfd.readouterr()
    assert "Renderer must be non-nullptr" not in captured.err
    assert mapper.GetInputAlgorithm().GetClassName() == "vtkDistanceToCamera"

    nodes = translate_scene(om, rw_id)
    mapper_node = nodes[str(om.GetId(mapper))]
    centers_id = str(om.GetId(centers))

    assert mapper_node["blocks"]["distanceToCamera"] == {
        "arrayName": "DistanceToCamera",
        "screenSize": 36.0,
        "inputDataObjectId": centers_id,
    }


def test_distance_to_camera_translation_uses_snapshot_while_bypassed(capfd):
    rw, mapper, centers = _make_dtc_glyph_window()
    capfd.readouterr()

    om = get_object_manager()
    rw_id = om.RegisterObject(rw)
    with bypass_distance_to_camera_for_serialization(rw):
        rw.Render()
        om.UpdateStatesFromObjects()
        nodes = translate_scene(om, rw_id)
        mapper_node = nodes[str(om.GetId(mapper))]
        object_node = translate_object(om, om.GetId(mapper))

    captured = capfd.readouterr()
    centers_id = str(om.GetId(centers))
    expected = {
        "arrayName": "DistanceToCamera",
        "screenSize": 36.0,
        "inputDataObjectId": centers_id,
    }

    assert "Renderer must be non-nullptr" not in captured.err
    assert mapper_node["blocks"]["distanceToCamera"] == expected
    assert object_node["blocks"]["distanceToCamera"] == expected
    assert mapper.GetInputAlgorithm().GetClassName() == "vtkDistanceToCamera"


def test_protocol_update_bypasses_distance_to_camera_for_registered_push_views(capfd):
    rw, mapper, _centers = _make_dtc_glyph_window()

    protocol = ObjectManagerAPI()
    rw_id = protocol.vtk_object_manager.RegisterObject(rw)

    class _PushView:
        _render_window = rw

    protocol._push_views[rw_id] = _PushView()
    capfd.readouterr()

    protocol.update()

    captured = capfd.readouterr()
    assert "Renderer must be non-nullptr" not in captured.err
    assert mapper.GetInputAlgorithm().GetClassName() == "vtkDistanceToCamera"
