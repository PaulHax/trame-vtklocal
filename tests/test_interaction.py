"""Translation coverage for pickable-marked mappers."""

import pytest

from trame_vtklocal.module import interaction as pick
from trame_vtklocal.module.protocol import ObjectManagerAPI
from trame_vtklocal.module.node_translator import translate_scene


def _make_scene():
    # The OpenGL2 backend registers the object-factory overrides the
    # serialization manager dereferences; without it UpdateStatesFromObjects
    # segfaults. No Render() is needed.
    import vtkmodules.vtkRenderingOpenGL2  # noqa: F401
    from vtkmodules.vtkCommonCore import vtkPoints
    from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData
    from vtkmodules.vtkRenderingCore import (
        vtkActor,
        vtkPolyDataMapper,
        vtkRenderer,
        vtkRenderWindow,
    )

    api = ObjectManagerAPI()
    rw = vtkRenderWindow()
    rw.SetOffScreenRendering(1)
    renderer = vtkRenderer()
    rw.AddRenderer(renderer)

    points = vtkPoints()
    points.InsertNextPoint(0.0, 0.0, 0.0)
    points.InsertNextPoint(1.0, 0.0, 0.0)
    verts = vtkCellArray()
    verts.InsertNextCell(1, [0])
    verts.InsertNextCell(1, [1])
    polydata = vtkPolyData()
    polydata.SetPoints(points)
    polydata.SetVerts(verts)

    mapper = vtkPolyDataMapper()
    mapper.SetInputData(polydata)
    actor = vtkActor()
    actor.SetMapper(mapper)
    renderer.AddActor(actor)

    render_window_id = api.vtk_object_manager.RegisterObject(rw)
    api.vtk_object_manager.UpdateStatesFromObjects()
    return api, rw, mapper, render_window_id


def _translate(api, render_window_id):
    api.vtk_object_manager.UpdateStatesFromObjects()
    return translate_scene(api.vtk_object_manager, render_window_id)


def _find_pickable_nodes(nodes):
    return [
        node
        for node in nodes.values()
        if (node.get("blocks") or {}).get(pick.PICKABLE_STATE_KEY) is not None
    ]


def test_marked_mapper_stamps_the_pickable_block():
    api, _rw, mapper, render_window_id = _make_scene()

    baseline = _translate(api, render_window_id)
    assert _find_pickable_nodes(baseline) == []

    pick.make_pickable(
        mapper,
        tags={"owner_id": "landmarks", "target_revision": 7},
        ids=["a", "b"],
        grab_px=36.0,
        priority=2,
    )
    state = _translate(api, render_window_id)

    (node,) = _find_pickable_nodes(state)
    block = node["blocks"][pick.PICKABLE_STATE_KEY]
    # tags and ids round-trip verbatim; the fork never interprets them.
    assert block["tags"] == {"owner_id": "landmarks", "target_revision": 7}
    assert block["ids"] == ["a", "b"]
    assert block["grabPx"] == 36.0
    assert block["priority"] == 2
    assert block["preview"] is None


def test_pickable_preview_configuration_round_trips():
    api, _rw, mapper, render_window_id = _make_scene()
    plane = {"origin": [0, 0, 2], "normal": [0, 0, 1]}
    pick.make_pickable(
        mapper,
        grab_px=12,
        preview="plane",
        plane=plane,
    )

    (node,) = _find_pickable_nodes(_translate(api, render_window_id))
    block = node["blocks"][pick.PICKABLE_STATE_KEY]
    assert block["preview"] == "plane"
    assert block["plane"] == plane


def test_retag_bumps_mtime_and_reaches_the_state():
    api, _rw, mapper, render_window_id = _make_scene()
    pick.make_pickable(mapper, tags={"rev": 1}, grab_px=10.0)

    state = _translate(api, render_window_id)
    (node,) = _find_pickable_nodes(state)
    assert node["blocks"][pick.PICKABLE_STATE_KEY]["tags"] == {"rev": 1}

    # Re-marking with new tags bumps the mapper MTime — that is what makes the
    # push sync emit a delta (a patch op) for this mapper.
    mtime_before = mapper.GetMTime()
    pick.make_pickable(mapper, tags={"rev": 2}, grab_px=10.0)
    assert mapper.GetMTime() > mtime_before

    state = _translate(api, render_window_id)
    (node,) = _find_pickable_nodes(state)
    # Whole config is replaced, not merged.
    block = node["blocks"][pick.PICKABLE_STATE_KEY]
    assert block["tags"] == {"rev": 2}
    assert block["ids"] is None


def test_retag_with_unchanged_config_is_a_no_op():
    _api, _rw, mapper, _id = _make_scene()
    pick.make_pickable(
        mapper, tags={"owner_id": "landmarks"}, ids=["a", "b"], grab_px=36.0
    )

    # Callers re-tag on every update (e.g. once per drag move); an identical
    # config must not bump the MTime, or every move re-serializes the mapper.
    mtime_before = mapper.GetMTime()
    returned = pick.make_pickable(
        mapper, tags={"owner_id": "landmarks"}, ids=["a", "b"], grab_px=36.0
    )
    assert mapper.GetMTime() == mtime_before
    assert returned == pick.pickable_config(mapper)


def test_clear_restores_plain_mapper_translation():
    api, _rw, mapper, render_window_id = _make_scene()
    pick.make_pickable(mapper, grab_px=10.0)

    pick.clear_pickable(mapper)
    state = _translate(api, render_window_id)

    assert _find_pickable_nodes(state) == []
    assert pick.pickable_config(mapper) is None


def test_config_is_copied_not_shared():
    _api, _rw, mapper, _id = _make_scene()
    tags = {"rev": 1}
    ids = ["a"]
    pick.make_pickable(mapper, tags=tags, ids=ids, grab_px=10.0)

    # Mutating the caller's inputs must not reach the stored config.
    tags["rev"] = 99
    ids.append("b")
    stored = pick.pickable_config(mapper)
    assert stored["tags"] == {"rev": 1}
    assert stored["ids"] == ["a"]

    # And mutating the returned copy must not reach the stored config either.
    stored["tags"]["rev"] = 42
    assert pick.pickable_config(mapper)["tags"] == {"rev": 1}


def test_validation_errors():
    _api, _rw, mapper, _id = _make_scene()

    with pytest.raises(ValueError):
        pick.make_pickable(mapper, grab_px=None)
    with pytest.raises(ValueError):
        pick.make_pickable(mapper, grab_px=0)
    with pytest.raises(ValueError):
        pick.make_pickable(mapper, grab_px=-5)
    with pytest.raises(ValueError):
        pick.make_pickable(mapper, grab_px=float("nan"))
    with pytest.raises(ValueError, match="preview"):
        pick.make_pickable(mapper, grab_px=1, preview="depth")
    with pytest.raises(ValueError, match="requires a plane"):
        pick.make_pickable(mapper, grab_px=1, preview="plane")
