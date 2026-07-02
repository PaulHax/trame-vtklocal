"""Translator regressions for vtk.js scene generation."""

from trame_vtklocal.module.distance_to_camera import (
    bypass_distance_to_camera_for_serialization,
)
from trame_vtklocal.module.protocol import ObjectManagerAPI
from trame_vtklocal.module.vtkjs_translator import translate_object, translate_scene

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


def find_calls(state, method_name):
    """Recursively find all calls matching method_name in state tree."""
    found = []
    if "calls" in state:
        for call in state["calls"]:
            if call[0] == method_name:
                found.append(call)
    for dep in state.get("dependencies", []):
        found.extend(find_calls(dep, method_name))
    return found


def find_node_by_id(state, node_id):
    """Recursively find the translated node for the given vtk object id."""
    if state.get("id") == str(node_id):
        return state
    for dep in state.get("dependencies", []):
        found = find_node_by_id(dep, node_id)
        if found:
            return found
    return None


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


def test_remove_actor_emits_removal_call():
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

    tracker = {}

    # First translate — should have addViewProp, no removeViewProp
    state1 = translate_scene(om, rw_id, tracker)
    adds = find_calls(state1, "addViewProp")
    removes = find_calls(state1, "removeViewProp")
    assert len(adds) == 2
    assert len(removes) == 0

    # Remove one actor
    renderer.RemoveActor(actor1)
    rw.Render()
    om.UpdateStatesFromObjects()

    # Second translate — removeViewProp for removed, no redundant adds
    state2 = translate_scene(om, rw_id, tracker)
    adds2 = find_calls(state2, "addViewProp")
    removes2 = find_calls(state2, "removeViewProp")
    assert len(adds2) == 0, "actor2 was already sent, should not re-add"
    assert len(removes2) == 1

    # Third translate — steady state, no calls at all
    rw.Render()
    om.UpdateStatesFromObjects()
    state3 = translate_scene(om, rw_id, tracker)
    adds3 = find_calls(state3, "addViewProp")
    removes3 = find_calls(state3, "removeViewProp")
    assert len(adds3) == 0
    assert len(removes3) == 0


def test_no_removal_without_tracker():
    rw = vtkRenderWindow()
    rw.SetOffScreenRendering(1)
    renderer = vtkRenderer()
    rw.AddRenderer(renderer)

    actor = make_actor()
    renderer.AddActor(actor)

    om = get_object_manager()
    rw_id = om.RegisterObject(rw)
    rw.Render()
    om.UpdateStatesFromObjects()

    # First translate without tracker
    translate_scene(om, rw_id, None)

    # Remove actor
    renderer.RemoveActor(actor)
    rw.Render()
    om.UpdateStatesFromObjects()

    # Second translate — no tracker means no removal calls
    state = translate_scene(om, rw_id, None)
    removes = find_calls(state, "removeViewProp")
    assert len(removes) == 0


def test_tracker_resets_on_clear():
    rw = vtkRenderWindow()
    rw.SetOffScreenRendering(1)
    renderer = vtkRenderer()
    rw.AddRenderer(renderer)

    actor = make_actor()
    renderer.AddActor(actor)

    om = get_object_manager()
    rw_id = om.RegisterObject(rw)
    rw.Render()
    om.UpdateStatesFromObjects()

    tracker = {}
    translate_scene(om, rw_id, tracker)

    # Remove actor
    renderer.RemoveActor(actor)
    rw.Render()
    om.UpdateStatesFromObjects()

    # Clear tracker (simulates request_resync)
    tracker.clear()

    # After clear, no removal calls — client is rebuilding from scratch
    state = translate_scene(om, rw_id, tracker)
    removes = find_calls(state, "removeViewProp")
    assert len(removes) == 0


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

    state = translate_scene(om, rw_id, {})
    mapper_node = find_node_by_id(state, om.GetId(mapper))

    assert mapper_node is not None
    assert mapper_node["type"] == "vtkGlyph3DMapper"

    centers_id = str(om.GetId(centers))
    source_id = str(om.GetId(source))
    dep_ids = {dep["id"] for dep in mapper_node.get("dependencies", [])}
    assert centers_id in dep_ids
    assert source_id in dep_ids

    calls = mapper_node.get("calls", [])
    assert ["setInputData", [f"instance:${{{centers_id}}}"]] in calls
    assert ["setInputData", [f"instance:${{{source_id}}}", 1]] in calls


def test_glyph_mapper_records_distance_to_camera_input():
    rw = vtkRenderWindow()
    rw.SetOffScreenRendering(1)
    renderer = vtkRenderer()
    rw.AddRenderer(renderer)

    centers_points = vtkPoints()
    centers_points.InsertNextPoint(-0.5, 0.0, 0.0)
    centers_points.InsertNextPoint(0.5, 0.0, 0.0)
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

    om = get_object_manager()
    rw_id = om.RegisterObject(rw)
    om.UpdateStatesFromObjects()

    state = translate_scene(om, rw_id, {})
    mapper_node = find_node_by_id(state, om.GetId(mapper))
    centers_id = str(om.GetId(centers))
    source_id = str(om.GetId(source))

    assert mapper_node is not None
    assert mapper_node["type"] == "vtkGlyph3DMapper"
    assert mapper_node["properties"]["scaleArray"] == "DistanceToCamera"
    assert mapper_node["properties"]["scaleMode"] == 1
    assert mapper_node["distanceToCamera"] == {
        "arrayName": "DistanceToCamera",
        "screenSize": 36.0,
        "inputDataObjectId": centers_id,
    }

    dep_ids = {dep["id"] for dep in mapper_node.get("dependencies", [])}
    assert centers_id in dep_ids
    assert source_id in dep_ids

    calls = mapper_node.get("calls", [])
    assert ["setInputData", [f"instance:${{{centers_id}}}"]] in calls
    assert ["setInputData", [f"instance:${{{source_id}}}", 1]] in calls


def test_distance_to_camera_serialization_bypasses_server_filter(capfd):
    rw = vtkRenderWindow()
    rw.SetOffScreenRendering(1)
    renderer = vtkRenderer()
    rw.AddRenderer(renderer)

    centers_points = vtkPoints()
    centers_points.InsertNextPoint(-0.5, 0.0, 0.0)
    centers_points.InsertNextPoint(0.5, 0.0, 0.0)
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
    capfd.readouterr()

    om = get_object_manager()
    rw_id = om.RegisterObject(rw)
    with bypass_distance_to_camera_for_serialization(rw):
        rw.Render()
        om.UpdateStatesFromObjects()

    captured = capfd.readouterr()
    assert "Renderer must be non-nullptr" not in captured.err
    assert mapper.GetInputAlgorithm().GetClassName() == "vtkDistanceToCamera"

    state = translate_scene(om, rw_id, {})
    mapper_node = find_node_by_id(state, om.GetId(mapper))
    centers_id = str(om.GetId(centers))

    assert mapper_node["distanceToCamera"] == {
        "arrayName": "DistanceToCamera",
        "screenSize": 36.0,
        "inputDataObjectId": centers_id,
    }


def test_distance_to_camera_translation_uses_snapshot_while_bypassed(capfd):
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
    capfd.readouterr()

    om = get_object_manager()
    rw_id = om.RegisterObject(rw)
    with bypass_distance_to_camera_for_serialization(rw):
        rw.Render()
        om.UpdateStatesFromObjects()
        state = translate_scene(om, rw_id, {})
        mapper_node = find_node_by_id(state, om.GetId(mapper))
        object_node = translate_object(om, om.GetId(mapper))

    captured = capfd.readouterr()
    centers_id = str(om.GetId(centers))
    expected = {
        "arrayName": "DistanceToCamera",
        "screenSize": 36.0,
        "inputDataObjectId": centers_id,
    }

    assert "Renderer must be non-nullptr" not in captured.err
    assert mapper_node["distanceToCamera"] == expected
    assert object_node["distanceToCamera"] == expected
    assert mapper.GetInputAlgorithm().GetClassName() == "vtkDistanceToCamera"


def test_protocol_update_bypasses_distance_to_camera_for_registered_push_views(capfd):
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

    actor = vtkActor()
    actor.SetMapper(mapper)
    renderer.AddActor(actor)
    renderer.ResetCamera()

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
