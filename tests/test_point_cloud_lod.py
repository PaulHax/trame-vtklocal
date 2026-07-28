"""Translation coverage for point-cloud LOD anchor mappers."""

import pytest

from trame_vtklocal.module import point_cloud_lod as pcl
from trame_vtklocal.module.protocol import ObjectManagerAPI
from trame_vtklocal.module.node_translator import translate_scene

CONFIG = dict(
    # The durable session/source identity, distinct from the URL-safe
    # tile-service id embedded in the endpoint below.
    source_asset_id="asset-42",
    revision="abc123",
    endpoint="/pointcloud/cloud-1/abc123",
    point_count=9_128_231,
    presentation={
        "mode": "auto",
        "userScale": 1.0,
        "minDiameterCssPx": 1.5,
        "maxDiameterCssPx": 5.0,
    },
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
    # The durable source id rides the wire under its own key, never conflated
    # with the tile-service id the endpoint embeds.
    assert block["sourceAssetId"] == "asset-42"
    assert "assetId" not in block
    assert block["revision"] == "abc123"
    assert block["endpoint"] == "/pointcloud/cloud-1/abc123"
    assert block["pointCount"] == 9_128_231
    assert block["presentation"] == CONFIG["presentation"]
    assert block["hasRgb"] is True
    # No configured point budget: the client default applies (fixed mode) and
    # adaptive mode has no point ceiling at all.
    assert "pointBudget" not in block
    # Adaptive quality is off by default.
    assert block["adaptive"] is False
    assert "refinementCutoffPx" not in block
    # Config props ride the block, never the mapper props.
    assert "sourceAssetId" not in node.get("props", {})


def test_adaptive_config_reaches_the_wire():
    api, rw, mapper, render_window_id = _make_scene()
    pcl.mark_point_cloud_lod(
        mapper,
        **CONFIG,
        adaptive=True,
    )
    state = _translate(api, rw, render_window_id)

    (node,) = _find_nodes(state, pcl.POINT_CLOUD_LOD_TYPE)
    block = node["blocks"][pcl.POINT_CLOUD_LOD_BLOCK]
    assert block["adaptive"] is True
    # Adaptive mode carries no point ceiling: frame time and the client's
    # GPU-memory budget govern.
    assert "pointBudget" not in block


def test_adaptive_options_reach_the_wire():
    api, rw, mapper, render_window_id = _make_scene()
    pcl.mark_point_cloud_lod(
        mapper,
        **CONFIG,
        adaptive=True,
        adaptive_options={
            "maxBudget": 4_000_000,
            "interactionTargetMs": 16,
            "stationaryTargetMs": 33,
        },
    )
    state = _translate(api, rw, render_window_id)

    (node,) = _find_nodes(state, pcl.POINT_CLOUD_LOD_TYPE)
    block = node["blocks"][pcl.POINT_CLOUD_LOD_BLOCK]
    assert block["adaptiveOptions"] == {
        "maxBudget": 4_000_000,
        "interactionTargetMs": 16.0,
        "stationaryTargetMs": 33.0,
    }
    # The optional ceiling is not a fixed budget: selection still adapts.
    assert "pointBudget" not in block


def test_adaptive_options_are_absent_unless_configured():
    api, rw, mapper, render_window_id = _make_scene()
    pcl.mark_point_cloud_lod(mapper, **CONFIG, adaptive=True)
    state = _translate(api, rw, render_window_id)

    (node,) = _find_nodes(state, pcl.POINT_CLOUD_LOD_TYPE)
    # Omitting them leaves the memory-derived ceiling as the only upper bound.
    assert "adaptiveOptions" not in node["blocks"][pcl.POINT_CLOUD_LOD_BLOCK]


def test_adaptive_options_require_adaptive_quality():
    _api, _rw, mapper, _render_window_id = _make_scene()
    with pytest.raises(ValueError, match="adaptive_options requires adaptive=True"):
        pcl.mark_point_cloud_lod(
            mapper, **CONFIG, adaptive_options={"maxBudget": 4_000_000}
        )


def test_adaptive_options_validation_errors():
    _api, _rw, mapper, _render_window_id = _make_scene()

    def mark(options):
        pcl.mark_point_cloud_lod(
            mapper, **CONFIG, adaptive=True, adaptive_options=options
        )

    # Below the client's floor, so the governor would refuse it at construction.
    with pytest.raises(ValueError, match="maxBudget must be >= minBudget"):
        mark({"maxBudget": 1_000})
    with pytest.raises(ValueError, match="maxBudget must be >= minBudget"):
        mark({"minBudget": 500_000, "maxBudget": 400_000})
    with pytest.raises(ValueError, match="minBudget must be > 0"):
        mark({"minBudget": 0})
    with pytest.raises(ValueError, match="interactionTargetMs must be > 0"):
        mark({"interactionTargetMs": 0})
    with pytest.raises(ValueError, match="stationaryTargetMs must be > 0"):
        mark({"stationaryTargetMs": -1})
    # A typo must not read as "use the defaults".
    with pytest.raises(ValueError, match="unknown adaptive_options: maxPoints"):
        mark({"maxPoints": 4_000_000})
    with pytest.raises(ValueError, match="adaptive_options must be an object"):
        mark(4_000_000)


def test_adaptive_floor_matches_the_library():
    """Pin the mirrored floor to the library's own DEFAULTS.minBudget.

    The JS component imports the value, so this module's mirror is the one
    hand-copy left in the chain: everything downstream (the app validates
    deployment caps against it) inherits a drift here as a crash in the
    client's render pass. The library source is reachable through the vue
    build's node_modules both in development (a symlink to the sibling
    checkout) and in CI (the npm tarball ships src/).
    """
    import re
    from pathlib import Path

    source = (
        Path(__file__).resolve().parents[1]
        / "vue-components"
        / "node_modules"
        / "pointcloud-lod"
        / "src"
        / "adaptiveBudget.ts"
    )
    if not source.exists():
        pytest.skip("pointcloud-lod is not installed next to the vue build")
    match = re.search(r"minBudget:\s*([0-9_]+)", source.read_text())
    assert match is not None, "the library no longer states DEFAULTS.minBudget"
    assert pcl.DEFAULT_ADAPTIVE_MIN_BUDGET == int(match.group(1).replace("_", ""))


def test_refinement_cutoff_reaches_the_wire():
    api, rw, mapper, render_window_id = _make_scene()
    pcl.mark_point_cloud_lod(mapper, **CONFIG, refinement_cutoff_px=0.5)
    state = _translate(api, rw, render_window_id)

    (node,) = _find_nodes(state, pcl.POINT_CLOUD_LOD_TYPE)
    assert node["blocks"][pcl.POINT_CLOUD_LOD_BLOCK]["refinementCutoffPx"] == 0.5


def test_refinement_cutoff_rejects_negative_values():
    _api, _rw, mapper, _render_window_id = _make_scene()
    with pytest.raises(ValueError, match="refinement_cutoff_px must be >= 0"):
        pcl.mark_point_cloud_lod(mapper, **CONFIG, refinement_cutoff_px=-0.1)


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
        pcl.mark_point_cloud_lod(mapper, **{**CONFIG, "source_asset_id": ""})
    with pytest.raises(ValueError):
        pcl.mark_point_cloud_lod(mapper, **{**CONFIG, "revision": ""})
    with pytest.raises(ValueError):
        pcl.mark_point_cloud_lod(mapper, **{**CONFIG, "endpoint": "/pointcloud/a/rev/"})
    with pytest.raises(ValueError):
        pcl.mark_point_cloud_lod(
            mapper,
            **{
                **CONFIG,
                "presentation": {"mode": "fixed", "diameterCssPx": 0},
            },
        )
    with pytest.raises(ValueError):
        pcl.mark_point_cloud_lod(mapper, **{**CONFIG, "point_budget": 0})


def test_legacy_asset_id_keyword_fails_loudly():
    """The rename to ``source_asset_id`` is breaking on purpose.

    A compatibility alias or a ``**kwargs`` sink would let old callers keep
    passing ``asset_id`` — silently marking anchors with no durable identity.
    """
    _, _, mapper, _ = _make_scene()

    legacy = dict(CONFIG)
    legacy["asset_id"] = legacy.pop("source_asset_id")
    with pytest.raises(TypeError):
        pcl.mark_point_cloud_lod(mapper, **legacy)
