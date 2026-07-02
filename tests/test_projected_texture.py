"""Translation coverage for projected-texture mappers."""

import pytest

from trame_vtklocal.module import projected_texture as ptx
from trame_vtklocal.module.protocol import ObjectManagerAPI
from trame_vtklocal.module.vtkjs_translator import translate_scene


def _make_scene():
    # The OpenGL2 backend registers the object-factory overrides
    # (vtkShaderProperty & co.) the serialization manager dereferences;
    # without it UpdateStatesFromObjects segfaults. No Render() is needed.
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
    points.InsertNextPoint(1.0, 1.0, 0.0)
    points.InsertNextPoint(0.0, 1.0, 0.0)
    polys = vtkCellArray()
    polys.InsertNextCell(4, [0, 1, 2, 3])
    polydata = vtkPolyData()
    polydata.SetPoints(points)
    polydata.SetPolys(polys)

    mapper = vtkPolyDataMapper()
    mapper.SetInputData(polydata)
    actor = vtkActor()
    actor.SetMapper(mapper)
    renderer.AddActor(actor)

    render_window_id = api.vtk_object_manager.RegisterObject(rw)
    api.vtk_object_manager.UpdateStatesFromObjects()
    return api, rw, mapper, render_window_id


def _translate(api, rw, render_window_id):
    api.vtk_object_manager.UpdateStatesFromObjects()
    return translate_scene(api.vtk_object_manager, render_window_id)


def _find_nodes(state, node_type):
    found = []

    def visit(node):
        if not isinstance(node, dict):
            return
        if node.get("type") == node_type:
            found.append(node)
        for dep in node.get("dependencies") or []:
            visit(dep)

    visit(state)
    return found


def test_marked_mapper_translates_with_type_and_props():
    api, rw, mapper, render_window_id = _make_scene()

    baseline = _translate(api, rw, render_window_id)
    assert _find_nodes(baseline, ptx.PROJECTED_TEXTURE_TYPE) == []

    ptx.mark_projected_texture(mapper, "video", mode=ptx.MODE_HOMOGRAPHY)
    state = _translate(api, rw, render_window_id)

    (node,) = _find_nodes(state, ptx.PROJECTED_TEXTURE_TYPE)
    assert node["properties"]["textureKey"] == "video"
    assert node["properties"]["mode"] == "homography"
    assert "homography" not in node["properties"]


def test_matrix_updates_ride_the_mapper_state():
    api, rw, mapper, render_window_id = _make_scene()
    ptx.mark_projected_texture(
        mapper, "video", mode=ptx.MODE_WORLD_TO_CLIP
    )

    mtime_before = mapper.GetMTime()
    matrix = [float(i) for i in range(16)]
    ptx.set_projected_texture_matrix(mapper, world_to_clip=matrix)
    # The matrix rides the mapper's serialized state: the MTime bump is what
    # makes the push sync emit a delta for this mapper.
    assert mapper.GetMTime() > mtime_before

    state = _translate(api, rw, render_window_id)
    (node,) = _find_nodes(state, ptx.PROJECTED_TEXTURE_TYPE)
    assert node["properties"]["worldToClip"] == matrix
    assert node["properties"]["mode"] == "worldToClip"

    ptx.set_projected_texture_matrix(
        mapper, homography=[1, 0, 0, 0, 1, 0, 0, 0, 1]
    )
    state = _translate(api, rw, render_window_id)
    (node,) = _find_nodes(state, ptx.PROJECTED_TEXTURE_TYPE)
    assert node["properties"]["homography"] == [
        1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0,
    ]
    # Remarking (e.g. a mode flip) keeps previously set matrices.
    ptx.mark_projected_texture(mapper, "video", mode=ptx.MODE_HOMOGRAPHY)
    assert ptx.projected_texture_config(mapper)["homography"] is not None


def test_clear_restores_plain_mapper_translation():
    api, rw, mapper, render_window_id = _make_scene()
    ptx.mark_projected_texture(mapper, "video")

    ptx.clear_projected_texture(mapper)
    state = _translate(api, rw, render_window_id)

    assert _find_nodes(state, ptx.PROJECTED_TEXTURE_TYPE) == []
    assert ptx.projected_texture_config(mapper) is None


def test_validation_errors():
    _, _, mapper, _ = _make_scene()

    with pytest.raises(ValueError):
        ptx.mark_projected_texture(mapper, "video", mode="bogus")
    with pytest.raises(ValueError):
        ptx.mark_projected_texture(mapper, "")
    with pytest.raises(ValueError):
        ptx.set_projected_texture_matrix(mapper, homography=[1, 2, 3])

    ptx.mark_projected_texture(mapper, "video")
    with pytest.raises(ValueError):
        ptx.set_projected_texture_matrix(mapper, homography=[1, 2, 3])
    with pytest.raises(ValueError):
        ptx.set_projected_texture_matrix(mapper, world_to_clip=[1] * 15)
