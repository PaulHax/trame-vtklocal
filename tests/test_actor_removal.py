"""Test that the vtk.js translator emits removal calls for removed actors."""

from trame_vtklocal.module.vtkjs_translator import translate_scene

from vtkmodules.vtkFiltersSources import vtkSphereSource
from vtkmodules.vtkRenderingCore import (
    vtkActor,
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
