"""Contract and lifetime tests for streamed scene actors."""

from __future__ import annotations

import gc
import subprocess
import sys
import weakref
from dataclasses import FrozenInstanceError

import pytest
from vtkmodules.vtkCommonMath import vtkMatrix4x4
from vtkmodules.vtkRenderingCore import vtkActor, vtkRenderer, vtkRenderWindow

import trame_vtklocal.streamed_scene as streamed_scene
from trame_vtklocal import PointCloudSource, StreamedSceneActor, Tiles3DSource
from trame_vtklocal.module.node_translator import translate_scene
from trame_vtklocal.module.protocol import ObjectManagerAPI
from trame_vtklocal.module import streamed_scene_registry
from trame_vtklocal.widgets.publisher import ScenePublisher

import vtkmodules.vtkRenderingOpenGL2  # noqa: F401, E402


POINT_SOURCE_ARGS = {
    "source_asset_id": "asset-42",
    "revision": "abc123",
    "endpoint": "/pointcloud/cloud-1/abc123",
    "point_count": 9_128_231,
    "presentation": {
        "mode": "auto",
        "userScale": 1.0,
        "minDiameterCssPx": 1.5,
        "maxDiameterCssPx": 5.0,
    },
}

IDENTITY = (
    1.0,
    0.0,
    0.0,
    0.0,
    0.0,
    1.0,
    0.0,
    0.0,
    0.0,
    0.0,
    1.0,
    0.0,
    0.0,
    0.0,
    0.0,
    1.0,
)


class _Protocol:
    def publish(self, _topic, _payload):
        pass


class _Server:
    protocol = _Protocol()


# Tolerance agreement with the JS boundary. The same constants and the same
# matrices are pinned in vue-components/tests/streamedSceneHost.test.mjs
# ("fixed affine entries share one absolute tolerance with the producer").
AFFINE_INSIDE_TOLERANCE = 9e-13
AFFINE_OUTSIDE_TOLERANCE = 2e-12


def _source(**overrides):
    return PointCloudSource(**{**POINT_SOURCE_ARGS, **overrides})


def _matrix_with(index, value):
    return (*IDENTITY[:index], value, *IDENTITY[index + 1 :])


def _delete_observer_count(actor, limit=256):
    """Count live observers. VTK exposes tags, not a count, so scan the tags."""
    return sum(1 for tag in range(1, limit) if actor.GetCommand(tag) is not None)


def _scene(actor):
    api = ObjectManagerAPI()
    render_window = vtkRenderWindow()
    render_window.SetOffScreenRendering(1)
    renderer = vtkRenderer()
    render_window.AddRenderer(renderer)
    renderer.AddActor(actor)
    root_id = api.vtk_object_manager.RegisterObject(render_window)
    api.vtk_object_manager.UpdateStatesFromObjects()
    return api, render_window, renderer, root_id


def _actor_node(api, root_id):
    api.vtk_object_manager.UpdateStatesFromObjects()
    nodes = translate_scene(api.vtk_object_manager, root_id)
    return next(
        node
        for node in nodes.values()
        if node["type"] in {"vtkActor", "vtkStreamedSceneActor"}
    )


def test_point_cloud_actor_translates_at_the_actor_with_normal_props():
    actor = StreamedSceneActor(
        _source(
            adaptive=True,
            adaptive_options={
                "maxBudget": 4_000_000,
                "interactionTargetMs": 16,
                "stationaryTargetMs": 33,
            },
            point_budget=2_000_000,
            refinement_cutoff_px=0.5,
        )
    )
    actor.SetVisibility(False)
    matrix = vtkMatrix4x4()
    matrix.SetElement(0, 3, 10)
    matrix.SetElement(1, 3, 20)
    matrix.SetElement(2, 3, 30)
    actor.SetUserMatrix(matrix)
    api, _window, _renderer, root_id = _scene(actor)

    node = _actor_node(api, root_id)

    assert node["type"] == "vtkStreamedSceneActor"
    assert node["props"]["visibility"] == 0
    assert node["props"]["userMatrix"] == [
        1.0,
        0.0,
        0.0,
        0.0,
        0.0,
        1.0,
        0.0,
        0.0,
        0.0,
        0.0,
        1.0,
        0.0,
        10.0,
        20.0,
        30.0,
        1.0,
    ]
    assert "refs" in node
    assert node["refs"] == {}
    assert node["blocks"] == {
        "streamedScene": {
            "kind": "pointCloud",
            "sourceAssetId": "asset-42",
            "revision": "abc123",
            "endpoint": "/pointcloud/cloud-1/abc123",
            "pointCloud": {
                "pointCount": 9_128_231,
                "presentation": POINT_SOURCE_ARGS["presentation"],
                "adaptive": True,
                "adaptiveOptions": {
                    "maxBudget": 4_000_000,
                    "interactionTargetMs": 16.0,
                    "stationaryTargetMs": 33.0,
                },
                "pointBudget": 2_000_000,
                "refinementCutoffPx": 0.5,
            },
        }
    }


def test_tiles_actor_translates_with_immutable_geographic_placement():
    source = Tiles3DSource(
        source_asset_id="mesh-7",
        revision="rev-2",
        endpoint="/tiles/mesh-7/rev-2",
        tileset_to_scene=IDENTITY,
        maximum_screen_space_error_px=12,
        vertical_exaggeration=2.5,
        vertical_pivot_z=105.25,
    )
    api, _window, _renderer, root_id = _scene(StreamedSceneActor(source))

    block = _actor_node(api, root_id)["blocks"]["streamedScene"]

    assert block == {
        "kind": "tiles3d",
        "sourceAssetId": "mesh-7",
        "revision": "rev-2",
        "endpoint": "/tiles/mesh-7/rev-2",
        "tiles3d": {
            "tilesetToScene": list(IDENTITY),
            "maximumScreenSpaceErrorPx": 12.0,
            "verticalExaggeration": 2.5,
            "verticalPivotZ": 105.25,
        },
    }

    defaults = streamed_scene.source_block(
        Tiles3DSource("model-1", "rev-1", "/tiles/model-1/rev-1", IDENTITY)
    )
    assert defaults["tiles3d"] == {
        "tilesetToScene": list(IDENTITY),
        "verticalExaggeration": 1.0,
        "verticalPivotZ": 0.0,
    }


def test_plain_actor_is_unaffected():
    api, _window, _renderer, root_id = _scene(vtkActor())

    node = _actor_node(api, root_id)

    assert node["type"] == "vtkActor"
    assert "streamedScene" not in node.get("blocks", {})


def test_sources_are_frozen_and_copy_mutable_input():
    presentation = dict(POINT_SOURCE_ARGS["presentation"])
    source = _source(presentation=presentation)
    presentation["userScale"] = 99

    assert source.presentation["userScale"] == 1.0
    assert isinstance(hash(source), int)
    with pytest.raises(FrozenInstanceError):
        source.revision = "changed"
    with pytest.raises(FrozenInstanceError):
        Tiles3DSource("mesh", "rev", "/tiles/mesh/rev", IDENTITY).endpoint = "/changed"


@pytest.mark.parametrize(
    ("overrides", "match"),
    [
        ({"source_asset_id": ""}, "source_asset_id is required"),
        ({"revision": ""}, "revision is required"),
        ({"endpoint": "/pointcloud/a/rev/"}, "must not end with '/'"),
        ({"point_count": -1}, "point_count must be >= 0"),
        ({"point_budget": 0}, "point_budget must be > 0"),
        ({"refinement_cutoff_px": -0.1}, "refinement_cutoff_px must be >= 0"),
        ({"refinement_cutoff_px": float("nan")}, "finite"),
        (
            {"presentation": {"mode": "fixed", "diameterCssPx": 0}},
            "positive and finite",
        ),
        (
            {"adaptive": False, "adaptive_options": {"maxBudget": 4_000_000}},
            "adaptive_options requires adaptive=True",
        ),
        (
            {"adaptive_options": {"maxPoints": 4_000_000}},
            "unknown adaptive_options: maxPoints",
        ),
        (
            {"adaptive_options": {"interactionTargetMs": float("inf")}},
            "interactionTargetMs must be positive and finite",
        ),
        (
            {"adaptive_options": {"stationaryTargetMs": float("nan")}},
            "stationaryTargetMs must be positive and finite",
        ),
    ],
)
def test_point_source_rejects_invalid_wire_values(overrides, match):
    with pytest.raises(ValueError, match=match):
        _source(**overrides)


@pytest.mark.parametrize(
    ("kwargs", "match"),
    [
        ({"source_asset_id": ""}, "source_asset_id is required"),
        ({"revision": ""}, "revision is required"),
        ({"endpoint": "/tiles/a/rev/"}, "must not end with '/'"),
        ({"tileset_to_scene": IDENTITY[:-1]}, "16 finite"),
        (
            {"tileset_to_scene": (*IDENTITY[:-1], float("inf"))},
            "16 finite",
        ),
        (
            {"tileset_to_scene": (*IDENTITY[:3], 1.0, *IDENTITY[4:])},
            "affine",
        ),
        (
            {"tileset_to_scene": (0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)},
            "invertible",
        ),
        ({"maximum_screen_space_error_px": 0}, "positive and finite"),
        (
            {"maximum_screen_space_error_px": float("nan")},
            "positive and finite",
        ),
        ({"vertical_exaggeration": 0}, "vertical_exaggeration.*positive and finite"),
        ({"vertical_exaggeration": "2"}, "vertical_exaggeration.*positive and finite"),
        ({"vertical_exaggeration": True}, "vertical_exaggeration.*positive and finite"),
        ({"vertical_exaggeration": None}, "vertical_exaggeration.*positive and finite"),
        (
            {"vertical_exaggeration": float("inf")},
            "vertical_exaggeration.*positive and finite",
        ),
        ({"vertical_pivot_z": float("nan")}, "vertical_pivot_z.*finite"),
        ({"vertical_pivot_z": float("-inf")}, "vertical_pivot_z.*finite"),
        ({"vertical_pivot_z": "0"}, "vertical_pivot_z.*finite"),
        ({"vertical_pivot_z": False}, "vertical_pivot_z.*finite"),
        ({"vertical_pivot_z": None}, "vertical_pivot_z.*finite"),
    ],
)
def test_tiles_source_rejects_invalid_wire_values(kwargs, match):
    values = {
        "source_asset_id": "mesh",
        "revision": "rev",
        "endpoint": "/tiles/mesh/rev",
        "tileset_to_scene": IDENTITY,
        **kwargs,
    }
    with pytest.raises(ValueError, match=match):
        Tiles3DSource(**values)


def test_source_update_bumps_mtime_and_reaches_translation():
    actor = StreamedSceneActor(_source())
    api, _window, _renderer, root_id = _scene(actor)
    before = actor.GetMTime()

    actor.source = _source(revision="next")

    assert actor.GetMTime() > before
    block = _actor_node(api, root_id)["blocks"]["streamedScene"]
    assert block["revision"] == "next"
    with pytest.raises(TypeError, match="PointCloudSource or Tiles3DSource"):
        actor.source = {"revision": "bad"}


def test_vtk_reconstituted_subclass_recovers_source_after_wrapper_dies():
    renderer = vtkRenderer()
    actor = StreamedSceneActor(_source())
    renderer.AddActor(actor)
    pointer = actor.__this__
    original = weakref.ref(actor)
    del actor
    gc.collect()
    assert original() is None

    reconstructed = vtkActor(pointer)

    assert isinstance(reconstructed, StreamedSceneActor)
    assert reconstructed.source == _source()


def test_registered_source_stays_authoritative_for_stale_and_reconstituted_wrappers():
    registry = streamed_scene_registry._StreamedSceneRegistry()
    renderer = vtkRenderer()
    original_source = _source()
    current_source = _source(revision="current")
    actor = StreamedSceneActor(original_source)
    renderer.AddActor(actor)
    registry.resolve(actor, "41")

    actor.source = current_source
    actor._source = original_source  # model a second wrapper's stale local cache
    assert registry._associate(actor, "41", original_source) == current_source
    assert actor.source == current_source
    translated = streamed_scene.source_block(registry.resolve(actor, "41"))
    assert translated["revision"] == "current"

    pointer = actor.__this__
    original = weakref.ref(actor)
    del actor
    gc.collect()
    assert original() is None

    reconstructed = vtkActor(pointer)
    assert reconstructed.source == current_source


def test_unrecoverable_streamed_subclass_source_loss_raises_loudly():
    actor = StreamedSceneActor(_source())
    address = streamed_scene_registry._actor_address(actor)
    streamed_scene_registry._forget_registration(address)
    del actor._source
    api, _window, _renderer, root_id = _scene(actor)

    with pytest.raises(RuntimeError, match="lost its streamed source"):
        _actor_node(api, root_id)


def test_publisher_full_init_and_structural_pass_retain_then_release_registry():
    actor = StreamedSceneActor(_source())
    api, render_window, renderer, root_id = _scene(actor)
    publisher = ScenePublisher(_Server(), api, render_window, root_id)
    try:
        actor_id = str(api.vtk_object_manager.GetId(actor))
        assert publisher.store.get(actor_id)["type"] == "vtkStreamedSceneActor"

        renderer.RemoveActor(actor)
        publisher.sync()

        assert publisher.store.get(actor_id) is None
        assert actor_id not in publisher._streamed_scene_registry.object_ids()

        renderer.AddActor(actor)
        publisher.sync()
        actor_id = str(api.vtk_object_manager.GetId(actor))
        assert publisher.store.get(actor_id)["type"] == "vtkStreamedSceneActor"
        assert actor_id in publisher._streamed_scene_registry.object_ids()
    finally:
        publisher.cleanup()


def test_dead_unscoped_actor_leaves_no_address_tombstone():
    actor = StreamedSceneActor(_source())
    address = streamed_scene_registry._actor_address(actor)
    original = weakref.ref(actor)
    del actor
    gc.collect()

    assert original() is None
    assert not streamed_scene_registry._has_registration(address)


def test_same_address_and_id_reuse_is_rejected_by_vtk_identity(monkeypatch):
    forced_address = "forced-address"
    monkeypatch.setattr(
        streamed_scene_registry,
        "_actor_address",
        lambda _actor: forced_address,
    )
    registry = streamed_scene_registry._StreamedSceneRegistry()
    old_actor = StreamedSceneActor(_source())
    registry.resolve(old_actor, "17")
    plain_replacement = vtkActor()

    assert registry.resolve(plain_replacement, "17") is None
    assert registry.object_ids() == frozenset()
    assert not streamed_scene_registry._has_registration(forced_address)


def test_registry_module_can_be_imported_before_public_streamed_scene_module():
    code = """
import trame_vtklocal.module.streamed_scene_registry
from trame_vtklocal.streamed_scene import PointCloudSource, StreamedSceneActor
source = PointCloudSource('asset', 'rev', '/endpoint', 1,
                          {'mode': 'fixed', 'diameterCssPx': 1})
assert StreamedSceneActor(source).source == source
"""
    subprocess.run([sys.executable, "-c", code], check=True)


def test_scene_membership_cycles_do_not_pile_up_delete_observers():
    actor = StreamedSceneActor(_source())
    api, render_window, renderer, root_id = _scene(actor)
    publisher = ScenePublisher(_Server(), api, render_window, root_id)
    try:
        baseline = _delete_observer_count(actor)

        for _ in range(5):
            renderer.RemoveActor(actor)
            publisher.sync()
            renderer.AddActor(actor)
            publisher.sync()

        assert _delete_observer_count(actor) == baseline
    finally:
        publisher.cleanup()


def test_dropped_registration_stops_retaining_its_source():
    actor = StreamedSceneActor(_source())
    address = streamed_scene_registry._actor_address(actor)
    retired = _source(revision="retired")
    actor.source = retired
    reference = weakref.ref(retired)
    del retired

    streamed_scene_registry._forget_registration(address)
    actor.source = _source(revision="current")
    gc.collect()

    assert reference() is None


@pytest.mark.parametrize(
    ("index", "expected"), [(3, 0.0), (7, 0.0), (11, 0.0), (15, 1.0)]
)
def test_fixed_affine_entries_share_one_absolute_tolerance(index, expected):
    values = {
        "source_asset_id": "mesh",
        "revision": "rev",
        "endpoint": "/tiles/mesh/rev",
    }
    inside = _matrix_with(index, expected + AFFINE_INSIDE_TOLERANCE)
    outside = _matrix_with(index, expected + AFFINE_OUTSIDE_TOLERANCE)

    assert Tiles3DSource(**values, tileset_to_scene=inside).tileset_to_scene == inside
    with pytest.raises(ValueError, match="affine"):
        Tiles3DSource(**values, tileset_to_scene=outside)


def test_publisher_cleanup_releases_its_registry_scope():
    actor = StreamedSceneActor(_source())
    api, render_window, _renderer, root_id = _scene(actor)
    publisher = ScenePublisher(_Server(), api, render_window, root_id)
    actor_id = str(api.vtk_object_manager.GetId(actor))

    publisher.cleanup()

    assert actor_id not in publisher._streamed_scene_registry.object_ids()


def test_two_publishers_release_shared_actor_independently():
    actor = StreamedSceneActor(_source())
    address = streamed_scene_registry._actor_address(actor)
    api1, window1, renderer1, root1 = _scene(actor)
    api2, window2, renderer2, root2 = _scene(actor)
    publisher1 = ScenePublisher(_Server(), api1, window1, root1)
    publisher2 = ScenePublisher(_Server(), api2, window2, root2)
    try:
        actor_id1 = str(api1.vtk_object_manager.GetId(actor))
        actor_id2 = str(api2.vtk_object_manager.GetId(actor))
        assert actor_id1 in publisher1._streamed_scene_registry.object_ids()
        assert actor_id2 in publisher2._streamed_scene_registry.object_ids()

        renderer1.RemoveActor(actor)
        publisher1.sync()
        publisher1.cleanup()

        assert actor_id1 not in publisher1._streamed_scene_registry.object_ids()
        assert actor_id2 in publisher2._streamed_scene_registry.object_ids()
        assert streamed_scene_registry._has_registration(address)

        actor.source = _source(revision="shared-current")
        publisher2.sync()
        block = publisher2.store.get(actor_id2)["blocks"]["streamedScene"]
        assert block["revision"] == "shared-current"

        renderer2.RemoveActor(actor)
        publisher2.sync()
        assert not streamed_scene_registry._has_registration(address)
    finally:
        publisher1.cleanup()
        publisher2.cleanup()
