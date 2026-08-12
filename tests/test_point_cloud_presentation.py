"""Direct point-cloud mapper presentation stays separate from streaming."""

import pytest
from vtkmodules.vtkCommonDataModel import vtkPolyData
from vtkmodules.vtkRenderingCore import vtkPointGaussianMapper

from trame_vtklocal.module import point_cloud_presentation as presentation
from trame_vtklocal.module.node_translator import translate_scene
from trame_vtklocal.module.protocol import ObjectManagerAPI


def _scene():
    import vtkmodules.vtkRenderingOpenGL2  # noqa: F401
    from vtkmodules.vtkRenderingCore import vtkActor, vtkRenderer, vtkRenderWindow

    api = ObjectManagerAPI()
    render_window = vtkRenderWindow()
    render_window.SetOffScreenRendering(1)
    renderer = vtkRenderer()
    render_window.AddRenderer(renderer)
    mapper = vtkPointGaussianMapper()
    mapper.SetInputData(vtkPolyData())
    actor = vtkActor()
    actor.SetMapper(mapper)
    renderer.AddActor(actor)
    root_id = api.vtk_object_manager.RegisterObject(render_window)
    return api, mapper, root_id


def _mapper_node(api, root_id):
    api.vtk_object_manager.UpdateStatesFromObjects()
    nodes = translate_scene(api.vtk_object_manager, root_id)
    return next(
        node for node in nodes.values() if node["type"] == "vtkPointGaussianMapper"
    )


def test_direct_presentation_block_keeps_its_wire_contract():
    api, mapper, root_id = _scene()

    config = presentation.mark_point_cloud_presentation(mapper, diameter_css_px=3.5)

    assert config == {"mode": "fixed", "diameterCssPx": 3.5}
    assert _mapper_node(api, root_id)["blocks"]["pointCloudPresentation"] == config


def test_direct_presentation_update_and_clear_bump_mapper_mtime():
    api, mapper, root_id = _scene()
    presentation.mark_point_cloud_presentation(mapper, diameter_css_px=2)
    marked_mtime = mapper.GetMTime()

    presentation.clear_point_cloud_presentation(mapper)

    assert mapper.GetMTime() > marked_mtime
    assert "blocks" not in _mapper_node(api, root_id)
    assert presentation.point_cloud_presentation_config(mapper) is None


@pytest.mark.parametrize("diameter", [0, -1, float("inf"), float("nan")])
def test_direct_presentation_rejects_non_positive_or_non_finite_values(diameter):
    _api, mapper, _root_id = _scene()

    with pytest.raises(ValueError, match="diameter_css_px must be positive and finite"):
        presentation.mark_point_cloud_presentation(mapper, diameter_css_px=diameter)
