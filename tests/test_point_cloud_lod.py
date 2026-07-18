"""Translation coverage for point-cloud LOD anchor mappers."""

import pytest

from trame_vtklocal.module import point_cloud_lod as pcl
from trame_vtklocal.module.protocol import ObjectManagerAPI
from trame_vtklocal.module.node_translator import translate_scene

CONFIG = dict(
    asset_id="cloud-1",
    revision="abc123",
    endpoint="/pointcloud/cloud-1/abc123",
    root_cube={"center": [10.0, 20.0, 30.0], "halfSize": 250.0},
    root_spacing=2.5,
    point_count=9_128_231,
)


def _make_scene():
    # The OpenGL2 backend registers the object-factory overrides the
    # serialization manager dereferences; no Render() is needed.
    import vtkmodules.vtkRenderingOpenGL2  # noqa: F401
    from vtkmodules.vtkCommonDataModel import vtkPolyData
    from vtkmodules.vtkRenderingCore import (
        vtkActor,
        vtkPointGaussianMapper,
        vtkRenderer,
        vtkRenderWindow,
    )

    api = ObjectManagerAPI()
    rw = vtkRenderWindow()
    rw.SetOffScreenRendering(1)
    renderer = vtkRenderer()
    rw.AddRenderer(renderer)

    # The anchor carries an EMPTY dataset: the cloud streams over HTTP.
    mapper = vtkPointGaussianMapper()
    mapper.SetInputData(vtkPolyData())
    actor = vtkActor()
    actor.SetMapper(mapper)
    renderer.AddActor(actor)

    render_window_id = api.vtk_object_manager.RegisterObject(rw)
    api.vtk_object_manager.UpdateStatesFromObjects()
    return api, rw, mapper, render_window_id


def _translate(api, rw, render_window_id):
    api.vtk_object_manager.UpdateStatesFromObjects()
    return translate_scene(api.vtk_object_manager, render_window_id)


def _find_nodes(nodes, node_type):
    return [node for node in nodes.values() if node.get("type") == node_type]


def test_marked_mapper_translates_with_type_and_block():
    api, rw, mapper, render_window_id = _make_scene()

    baseline = _translate(api, rw, render_window_id)
    assert _find_nodes(baseline, pcl.POINT_CLOUD_LOD_TYPE) == []

    pcl.mark_point_cloud_lod(mapper, **CONFIG)
    state = _translate(api, rw, render_window_id)

    (node,) = _find_nodes(state, pcl.POINT_CLOUD_LOD_TYPE)
    block = node["blocks"][pcl.POINT_CLOUD_LOD_BLOCK]
    assert block["assetId"] == "cloud-1"
    assert block["revision"] == "abc123"
    assert block["endpoint"] == "/pointcloud/cloud-1/abc123"
    assert block["rootCube"] == {"center": [10.0, 20.0, 30.0], "halfSize": 250.0}
    assert block["rootSpacing"] == 2.5
    assert block["pointCount"] == 9_128_231
    assert block["hasRgb"] is True
    assert block["pointBudget"] == pcl.DEFAULT_POINT_BUDGET
    # Adaptive quality is off by default and carries no tuning fields.
    assert block["adaptive"] is False
    assert "minBudget" not in block
    assert "stationaryTargetMs" not in block
    assert "interactionTargetMs" not in block
    # Config props ride the block, never the mapper props.
    assert "assetId" not in node.get("props", {})


def test_adaptive_config_reaches_the_wire():
    api, rw, mapper, render_window_id = _make_scene()
    pcl.mark_point_cloud_lod(
        mapper,
        **CONFIG,
        adaptive=True,
        min_budget=250_000,
        stationary_target_ms=16.0,
        interaction_target_ms=33.0,
    )
    state = _translate(api, rw, render_window_id)

    (node,) = _find_nodes(state, pcl.POINT_CLOUD_LOD_TYPE)
    block = node["blocks"][pcl.POINT_CLOUD_LOD_BLOCK]
    assert block["adaptive"] is True
    # pointBudget stays the ceiling (the user quality control).
    assert block["pointBudget"] == pcl.DEFAULT_POINT_BUDGET
    assert block["minBudget"] == 250_000
    assert block["stationaryTargetMs"] == 16.0
    assert block["interactionTargetMs"] == 33.0


def test_unmarked_point_gaussian_mapper_is_unaffected():
    api, rw, _mapper, render_window_id = _make_scene()
    state = _translate(api, rw, render_window_id)
    (node,) = _find_nodes(state, "vtkPointGaussianMapper")
    assert "blocks" not in node or pcl.POINT_CLOUD_LOD_BLOCK not in node.get(
        "blocks", {}
    )


def test_config_update_bumps_mtime_and_reaches_the_wire():
    api, rw, mapper, render_window_id = _make_scene()
    pcl.mark_point_cloud_lod(mapper, **CONFIG)

    mtime_before = mapper.GetMTime()
    pcl.mark_point_cloud_lod(mapper, **{**CONFIG, "revision": "def456"})
    # The MTime bump is what makes the push sync emit a delta for this node.
    assert mapper.GetMTime() > mtime_before

    state = _translate(api, rw, render_window_id)
    (node,) = _find_nodes(state, pcl.POINT_CLOUD_LOD_TYPE)
    assert node["blocks"][pcl.POINT_CLOUD_LOD_BLOCK]["revision"] == "def456"


def test_anchor_polydata_publishes_no_point_or_topology_blobs():
    api, rw, mapper, render_window_id = _make_scene()
    pcl.mark_point_cloud_lod(mapper, **CONFIG)
    state = _translate(api, rw, render_window_id)

    polydata_nodes = _find_nodes(state, "vtkPolyData")
    assert polydata_nodes, "anchor polydata should still translate"
    for node in polydata_nodes:
        arrays = node.get("arrays", {})
        assert not arrays.get("points")
        for topology in ("verts", "lines", "polys", "strips"):
            assert not arrays.get(topology)


def test_clear_restores_plain_mapper_translation():
    api, rw, mapper, render_window_id = _make_scene()
    pcl.mark_point_cloud_lod(mapper, **CONFIG)

    pcl.clear_point_cloud_lod(mapper)
    state = _translate(api, rw, render_window_id)

    assert _find_nodes(state, pcl.POINT_CLOUD_LOD_TYPE) == []
    assert pcl.point_cloud_lod_config(mapper) is None


def test_validation_errors():
    _, _, mapper, _ = _make_scene()

    with pytest.raises(ValueError):
        pcl.mark_point_cloud_lod(mapper, **{**CONFIG, "asset_id": ""})
    with pytest.raises(ValueError):
        pcl.mark_point_cloud_lod(mapper, **{**CONFIG, "revision": ""})
    with pytest.raises(ValueError):
        pcl.mark_point_cloud_lod(mapper, **{**CONFIG, "endpoint": "/pointcloud/a/rev/"})
    with pytest.raises(ValueError):
        pcl.mark_point_cloud_lod(
            mapper, **{**CONFIG, "root_cube": {"center": [0, 0], "halfSize": 1}}
        )
    with pytest.raises(ValueError):
        pcl.mark_point_cloud_lod(mapper, **{**CONFIG, "root_spacing": 0})
    with pytest.raises(ValueError):
        pcl.mark_point_cloud_lod(mapper, **{**CONFIG, "point_budget": 0})
    with pytest.raises(ValueError):
        pcl.mark_point_cloud_lod(
            mapper, **{**CONFIG, "adaptive": True, "min_budget": 0}
        )
    with pytest.raises(ValueError):
        pcl.mark_point_cloud_lod(
            mapper, **{**CONFIG, "adaptive": True, "stationary_target_ms": 0}
        )
    with pytest.raises(ValueError):
        pcl.mark_point_cloud_lod(
            mapper, **{**CONFIG, "adaptive": True, "interaction_target_ms": -1}
        )
