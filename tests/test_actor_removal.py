"""Structural add/remove and glyph-mapper translation regressions.

Structural changes have no full-sync fallback in push sync v2: an added or
removed actor must round-trip through flat-node translation + the scene
store as plain ``upsert``/``remove`` ops.
"""

from trame_vtklocal.module.node_translator import translate_scene
from trame_vtklocal.module.screen_size_glyphs import mark_screen_size_glyphs
from trame_vtklocal.store import SceneStore

from vtkmodules.vtkCommonCore import vtkPoints
from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData
from vtkmodules.vtkFiltersSources import vtkSphereSource
from vtkmodules.vtkRenderingCore import (
    vtkActor,
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


def test_screen_size_glyph_mapper_serializes_with_its_block(capfd):
    rw = vtkRenderWindow()
    rw.SetOffScreenRendering(1)
    renderer = vtkRenderer()
    rw.AddRenderer(renderer)

    centers_points = vtkPoints()
    centers_points.InsertNextPoint(-0.5, 0.0, 0.0)
    centers = vtkPolyData()
    centers.SetPoints(centers_points)

    mapper = vtkGlyph3DMapper()
    mapper.SetInputData(centers)
    mapper.SetSourceData(make_cross_polydata())
    mapper.OrientOff()
    mapper.SetScalarVisibility(False)
    mark_screen_size_glyphs(mapper, 36)

    actor = vtkActor()
    actor.SetMapper(mapper)
    renderer.AddActor(actor)
    renderer.ResetCamera()
    capfd.readouterr()

    om = get_object_manager()
    rw_id = om.RegisterObject(rw)
    rw.Render()
    om.UpdateStatesFromObjects()
    nodes = translate_scene(om, rw_id)

    captured = capfd.readouterr()
    assert "ERROR" not in captured.err
    mapper_node = nodes[str(om.GetId(mapper))]
    assert mapper_node["refs"]["inputs"][0] == str(om.GetId(centers))
    assert mapper_node["props"]["scaleArray"] == "DistanceToCamera"
    assert mapper_node["blocks"]["distanceToCamera"] == {
        "arrayName": "DistanceToCamera",
        "screenSize": 36.0,
    }
