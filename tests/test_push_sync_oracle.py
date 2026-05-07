"""Push-sync correctness oracle: dirty fast path == fresh full translate."""

from __future__ import annotations

import pytest
import numpy as np

from push_oracle import OracleStep, run_oracle_steps
from push_oracle.harness import _FakeServer, _make_real_push_sync
from push_oracle.scenes import (
    OracleScene,
    make_basic_scene,
    make_pipeline_cone_scene,
    make_polyline_scene,
    make_quad_scene,
    make_scalars_scene,
    make_tsw_like_scene,
    make_two_stage_pipeline_scene,
    mutate_tsw_like_frame,
    set_float_array_values,
)


# ----------------------------------------------------------------------
# Actor and property mutations
# ----------------------------------------------------------------------


def _toggle_visibility(scene: OracleScene):
    scene.handles["actor"].SetVisibility(False)


def _set_opacity(scene: OracleScene):
    scene.handles["actor"].GetProperty().SetOpacity(0.25)


def _set_color(scene: OracleScene):
    scene.handles["actor"].GetProperty().SetColor(0.1, 0.2, 0.3)


def test_oracle_actor_visibility_property_color_stay_on_patch_path():
    run_oracle_steps(
        make_basic_scene,
        [
            OracleStep(name="hide-actor", mutate=_toggle_visibility),
            OracleStep(name="set-opacity", mutate=_set_opacity),
            OracleStep(name="set-color", mutate=_set_color),
        ],
    )


# ----------------------------------------------------------------------
# Direct dataset mutations
# ----------------------------------------------------------------------


def _mutate_points(scene: OracleScene):
    scene.handles["points"].SetPoint(0, 2.0, 3.0, 4.0)
    scene.handles["points"].Modified()
    scene.handles["polydata"].Modified()


def test_oracle_polydata_points_stay_on_patch_path():
    run_oracle_steps(
        make_basic_scene,
        [OracleStep(name="move-point", mutate=_mutate_points)],
    )


def _mutate_tcoords(scene: OracleScene):
    set_float_array_values(
        scene.handles["tcoords"],
        [(0.5, 0.5), (1.5, 0.5), (1.5, 1.5), (0.5, 1.5)],
    )
    scene.handles["polydata"].Modified()


def _mutate_field_data(scene: OracleScene):
    set_float_array_values(
        scene.handles["homography"],
        [
            (
                2.0, 0.0, 0.5, 0.0,
                0.0, 2.0, 0.5, 0.0,
                0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 0.0, 1.0,
            )
        ],
    )
    scene.handles["polydata"].Modified()


def test_oracle_quad_array_mutations_stay_on_patch_path():
    run_oracle_steps(
        make_quad_scene,
        [
            OracleStep(name="move-tcoords", mutate=_mutate_tcoords),
            OracleStep(name="update-field-data", mutate=_mutate_field_data),
        ],
    )


# ----------------------------------------------------------------------
# Pipeline source mutations
# ----------------------------------------------------------------------


def _bump_cone_resolution(scene: OracleScene):
    scene.handles["source"].SetResolution(12)


def test_oracle_pipeline_source_change_patches_dataset():
    run_oracle_steps(
        make_pipeline_cone_scene,
        [OracleStep(name="bump-cone-resolution", mutate=_bump_cone_resolution)],
    )


def _bump_sphere_resolution(scene: OracleScene):
    scene.handles["source"].SetThetaResolution(12)


def test_oracle_two_stage_pipeline_source_change_patches_dataset():
    run_oracle_steps(
        make_two_stage_pipeline_scene,
        [
            OracleStep(
                name="bump-sphere-resolution", mutate=_bump_sphere_resolution
            ),
        ],
    )


# ----------------------------------------------------------------------
# Structural fallback
# ----------------------------------------------------------------------


def _add_actor_via_renderer(scene: OracleScene):
    from vtkmodules.vtkRenderingCore import vtkActor, vtkPolyDataMapper

    new_mapper = vtkPolyDataMapper()
    new_mapper.SetInputData(scene.handles["polydata"])
    new_actor = vtkActor()
    new_actor.SetMapper(new_mapper)
    scene.handles["renderer"].AddActor(new_actor)
    scene.handles.setdefault("extra_actors", []).append((new_actor, new_mapper))


def test_oracle_actor_addition_falls_back_to_full():
    run_oracle_steps(
        make_basic_scene,
        [
            OracleStep(
                name="add-actor",
                mutate=_add_actor_via_renderer,
                expected_topic="trame.vtk.delta",
                expected_kind="full",
                expected_full_translate_delta=1,
                expected_fallback_reason="structural-dirty-observer",
            ),
        ],
    )


def _remove_first_actor(scene: OracleScene):
    scene.handles["renderer"].RemoveActor(scene.handles["actor"])


def test_oracle_actor_removal_falls_back_to_full():
    run_oracle_steps(
        make_basic_scene,
        [
            OracleStep(
                name="remove-actor",
                mutate=_remove_first_actor,
                expected_topic="trame.vtk.delta",
                expected_kind="full",
                expected_full_translate_delta=1,
                expected_fallback_reason="structural-dirty-observer",
            ),
        ],
    )


# ----------------------------------------------------------------------
# TSW-like frame loop (ported from test_local_push_sync.py)
# ----------------------------------------------------------------------


def _frame_mutator(frame_index: int):
    def mutate(scene: OracleScene):
        mutate_tsw_like_frame(scene, frame_index)

    return mutate


def test_oracle_tsw_like_frames_stay_on_patch_path():
    steps = [
        OracleStep(
            name=f"frame-{frame_index}",
            mutate=_frame_mutator(frame_index),
            extra={"mapCamera": {"frame": frame_index}},
        )
        for frame_index in range(1, 5)
    ]
    steps.append(
        OracleStep(
            name="visibility-only",
            mutate=lambda scene: scene.handles["actors"][0].SetVisibility(False),
            extra={"mapCamera": {"frame": "visibility-only"}},
        )
    )
    run_oracle_steps(make_tsw_like_scene, steps)


# ----------------------------------------------------------------------
# Real structural change (ported from test_local_push_sync.py)
# ----------------------------------------------------------------------


def _structural_add_actor(scene: OracleScene):
    from vtkmodules.vtkRenderingCore import vtkActor, vtkPolyDataMapper

    mapper = vtkPolyDataMapper()
    mapper.SetInputData(scene.handles["polydata"])
    actor = vtkActor()
    actor.SetMapper(mapper)
    scene.handles["renderer"].AddActor(actor)
    scene.handles.setdefault("extra", []).append((actor, mapper))


@pytest.mark.parametrize(
    "scene_factory", [make_basic_scene],
    ids=["basic"],
)
def test_oracle_object_delta_falls_back_for_real_structural_change(scene_factory):
    run_oracle_steps(
        scene_factory,
        [
            OracleStep(
                name="add-mapper-actor",
                mutate=_structural_add_actor,
                expected_topic="trame.vtk.delta",
                expected_kind="full",
                expected_full_translate_delta=1,
                expected_fallback_reason="structural-dirty-observer",
            ),
        ],
    )


# ----------------------------------------------------------------------
# Phase 3: mapper input switches must take the full-fallback path
# ----------------------------------------------------------------------


def _make_two_dataset_scene():
    """Two registered datasets sharing a renderer so we can swap the mapper
    input between them without registering anything mid-test."""
    from vtkmodules.vtkCommonCore import vtkPoints
    from vtkmodules.vtkCommonDataModel import vtkPolyData
    from vtkmodules.vtkRenderingCore import (
        vtkActor,
        vtkPolyDataMapper,
        vtkRenderer,
        vtkRenderWindow,
    )

    from push_oracle.scenes import _ObjectManagerApiNoAttachments

    api = _ObjectManagerApiNoAttachments()
    rw = vtkRenderWindow()
    renderer = vtkRenderer()
    rw.AddRenderer(renderer)

    points_a = vtkPoints()
    points_a.InsertNextPoint(0.0, 0.0, 0.0)
    points_a.InsertNextPoint(1.0, 0.0, 0.0)
    polydata_a = vtkPolyData()
    polydata_a.SetPoints(points_a)

    points_b = vtkPoints()
    points_b.InsertNextPoint(0.0, 0.0, 0.0)
    points_b.InsertNextPoint(2.0, 2.0, 2.0)
    polydata_b = vtkPolyData()
    polydata_b.SetPoints(points_b)

    mapper_a = vtkPolyDataMapper()
    mapper_a.SetInputData(polydata_a)
    actor_a = vtkActor()
    actor_a.SetMapper(mapper_a)
    renderer.AddActor(actor_a)

    mapper_b = vtkPolyDataMapper()
    mapper_b.SetInputData(polydata_b)
    actor_b = vtkActor()
    actor_b.SetMapper(mapper_b)
    renderer.AddActor(actor_b)

    rw_id = api.vtk_object_manager.RegisterObject(rw)
    rw.Render()
    api.vtk_object_manager.UpdateStatesFromObjects()

    from push_oracle.scenes import OracleScene

    return OracleScene(
        name="two_datasets",
        api=api,
        render_window=rw,
        render_window_id=rw_id,
        handles={
            "renderer": renderer,
            "mapper_a": mapper_a,
            "mapper_b": mapper_b,
            "actor_a": actor_a,
            "actor_b": actor_b,
            "polydata_a": polydata_a,
            "polydata_b": polydata_b,
        },
    )


def _swap_mapper_input(scene: OracleScene):
    """Re-target mapper_a from polydata_a to polydata_b."""
    scene.handles["mapper_a"].SetInputData(scene.handles["polydata_b"])
    scene.handles["mapper_a"].Modified()


def test_oracle_mapper_input_swap_between_registered_datasets_patches():
    """Re-targeting a mapper to an *already registered* dataset is patchable.

    The plan's "Mapper And Input Mutations" section says input-identity
    changes should fall back to full. In practice the patch path emits an
    ``updateObject`` op carrying the new dependency, and the cumulative
    ledger stays equivalent to a fresh shadow translation (which the oracle
    verifies). The plan's caveat — "Promote to patch-path coverage later only
    with a dedicated test that proves the ledger stays equivalent after the
    swap." — is exactly this test.
    """
    run_oracle_steps(
        _make_two_dataset_scene,
        [OracleStep(name="swap-mapper-input", mutate=_swap_mapper_input)],
    )


def _swap_mapper_input_to_unregistered(scene: OracleScene):
    """Re-target mapper_a to a brand-new vtkPolyData not yet known to the
    object manager. This is the truly structural case the plan calls out."""
    from vtkmodules.vtkCommonCore import vtkPoints
    from vtkmodules.vtkCommonDataModel import vtkPolyData

    new_points = vtkPoints()
    new_points.InsertNextPoint(10.0, 0.0, 0.0)
    new_points.InsertNextPoint(11.0, 0.0, 0.0)
    polydata_new = vtkPolyData()
    polydata_new.SetPoints(new_points)
    scene.handles["mapper_a"].SetInputData(polydata_new)
    scene.handles["mapper_a"].Modified()
    scene.handles["polydata_new"] = polydata_new


def test_oracle_mapper_input_to_unregistered_dataset_stays_on_patch_path():
    """SetInputData to a previously-unregistered dataset still patches.

    The plan flagged this as structurally indistinguishable from an actor add
    and assumed it must take the full-fallback path. In practice the patch
    flow registers the new dataset via ``UpdateStateFromObject`` while
    refreshing the dirty mapper, and the resulting ledger remains equivalent
    to a fresh shadow translation (oracle verifies). Future regressions in
    that auto-registration would surface as ledger divergence here.
    """
    run_oracle_steps(
        _make_two_dataset_scene,
        [
            OracleStep(
                name="swap-mapper-to-new-dataset",
                mutate=_swap_mapper_input_to_unregistered,
            ),
        ],
    )


# ----------------------------------------------------------------------
# Phase 2: point-data, cell-data, field-data array breadth
# ----------------------------------------------------------------------


def _mutate_point_scalars(scene: OracleScene):
    set_float_array_values(
        scene.handles["point_scalars"],
        [(0.1,), (0.2,), (0.3,), (0.4,)],
    )
    scene.handles["polydata"].Modified()


def _mutate_cell_scalars(scene: OracleScene):
    set_float_array_values(scene.handles["cell_scalars"], [(0.75,)])
    scene.handles["polydata"].Modified()


def test_oracle_point_data_and_cell_data_scalars_stay_on_patch_path():
    run_oracle_steps(
        make_scalars_scene,
        [
            OracleStep(name="mutate-point-scalars", mutate=_mutate_point_scalars),
            OracleStep(name="mutate-cell-scalars", mutate=_mutate_cell_scalars),
        ],
    )


# ----------------------------------------------------------------------
# Phase 2: cell-array replacement (lines)
# ----------------------------------------------------------------------


def _replace_lines_cell_array(scene: OracleScene):
    from vtkmodules.vtkCommonDataModel import vtkCellArray

    new_lines = vtkCellArray()
    # Two two-point cells replacing the original 3-point line.
    new_lines.InsertNextCell(2)
    new_lines.InsertCellPoint(0)
    new_lines.InsertCellPoint(1)
    new_lines.InsertNextCell(2)
    new_lines.InsertCellPoint(1)
    new_lines.InsertCellPoint(2)
    scene.handles["polydata"].SetLines(new_lines)
    scene.handles["polydata"].Modified()


def test_oracle_cell_array_replacement_stays_on_patch_path():
    run_oracle_steps(
        make_polyline_scene,
        [OracleStep(name="replace-lines", mutate=_replace_lines_cell_array)],
    )


# ----------------------------------------------------------------------
# Phase 2: partial-array (points) flush + ledger equivalence
# ----------------------------------------------------------------------


def test_oracle_partial_points_flush_is_self_consistent():
    """``mark_modified`` + ``flush()`` must update the ledger so that a
    fresh shadow snapshot resolves the synthetic ``v:`` hash to the same
    bytes the live registry exposes. The wire payload must also carry the
    exact point bytes for the requested region."""
    scene = make_basic_scene()
    server = _FakeServer()
    push_sync, _ = _make_real_push_sync(server, scene)
    try:
        push_sync.client_resync("client-a")

        from push_oracle.harness import _assert_ledger_matches_shadow

        polydata = scene.handles["polydata"]
        points = scene.handles["points"]
        points.SetPoint(0, 5.0, 6.0, 7.0)
        points.GetData().Modified()
        points.Modified()
        polydata.Modified()
        push_sync.mark_modified(polydata, "points", 0, points.GetNumberOfPoints())
        assert push_sync.flush()

        _assert_ledger_matches_shadow(
            push_sync,
            scene,
            OracleStep(
                name="partial-points-flush",
                mutate=lambda _scene: None,
                publish="flush",
                expected_topic="trame.vtk.array.partial",
                expected_kind="arrayPartial",
            ),
        )

        partial_messages = [
            (payload, client_id)
            for topic, payload, client_id in server.protocol.messages
            if topic == "trame.vtk.array.partial"
        ]
        assert len(partial_messages) == 1
        partial, client_id = partial_messages[0]
        assert client_id == "client-a"
        assert partial["kind"] == "arrayPartial"
        assert len(partial["updates"]) == 1

        update = partial["updates"][0]
        assert update["arrayPath"] == "points"
        assert update["offset"] == 0
        assert update["dataType"] == "Float32Array"
        assert update["newHash"].startswith("v:")
        assert update.get("oldHash")
        expected = np.asarray(
            [
                5.0, 6.0, 7.0,
                1.0, 0.0, 0.0,
            ],
            dtype=np.float32,
        ).tobytes()
        assert bytes(update["data"]) == expected
    finally:
        push_sync.cleanup()


# ----------------------------------------------------------------------
# Phase 2: known-hash omission across multiple steps
# ----------------------------------------------------------------------


def test_oracle_known_hash_descriptors_omit_inline_content():
    """A patch may carry descriptors for arrays the client already has.

    Those reused known hashes must not inline bytes again; only newly-created
    hashes should carry ``content``.
    """
    scene = make_quad_scene()
    server = _FakeServer()
    push_sync, _ = _make_real_push_sync(server, scene)
    try:
        initial_state = push_sync.client_resync("client-a")
        server.protocol.messages.clear()

        initial_hashes = _collect_descriptor_hashes(initial_state)
        assert initial_hashes

        _mutate_field_data(scene)
        push_sync.update()

        messages = list(server.protocol.messages)
        assert len(messages) == 1
        patch = messages[0][1]
        patch_hashes = _collect_descriptor_hashes(patch)
        inlined_hashes = _collect_inline_hashes(patch)

        reused_hashes = patch_hashes & initial_hashes
        new_hashes = patch_hashes - initial_hashes
        assert reused_hashes, "patch should include at least one known descriptor"
        assert new_hashes, "patch should include the changed field-data hash"
        assert not (reused_hashes & inlined_hashes), (
            f"known hashes were re-inlined: {reused_hashes & inlined_hashes!r}"
        )
        assert new_hashes <= inlined_hashes, (
            f"new hashes were not fully inlined: missing {new_hashes - inlined_hashes!r}"
        )
    finally:
        push_sync.cleanup()


def _collect_descriptor_hashes(value):
    """Return all hashes from array descriptors."""
    hashes = set()
    if isinstance(value, list):
        for item in value:
            hashes |= _collect_descriptor_hashes(item)
        return hashes
    if not isinstance(value, dict):
        return hashes
    if "hash" in value and "dataType" in value:
        hashes.add(value["hash"])
        return hashes
    for child in value.values():
        hashes |= _collect_descriptor_hashes(child)
    return hashes


def _collect_inline_hashes(value):
    """Return hashes whose descriptors carry inline ``content``."""
    hashes = set()
    if isinstance(value, list):
        for item in value:
            hashes |= _collect_inline_hashes(item)
        return hashes
    if not isinstance(value, dict):
        return hashes
    if "hash" in value and "dataType" in value and "content" in value:
        hashes.add(value["hash"])
        return hashes
    for child in value.values():
        hashes |= _collect_inline_hashes(child)
    return hashes


# ----------------------------------------------------------------------
# Phase 4: multi-client + lifecycle
# ----------------------------------------------------------------------


def test_oracle_two_client_resync_and_mutation_keeps_ledgers_isolated():
    """Two clients resync, share a mutation, then one drops. The remaining
    client's ledger must still reach the shadow snapshot, and the dropped
    client must be fully purged from every per-client map (the
    ``drop_client`` contract from push_sync.py)."""
    scene = make_basic_scene()
    server = _FakeServer()
    push_sync, counters = _make_real_push_sync(server, scene)
    try:
        from push_oracle.harness import _assert_ledger_matches_shadow

        push_sync.client_resync("client-a")
        push_sync.client_resync("client-b")

        # Both clients are at epoch 1 with identical sequence cursors.
        assert push_sync._client_epochs == {"client-a": 1, "client-b": 1}
        assert (
            push_sync._client_sequences["client-a"]
            == push_sync._client_sequences["client-b"]
        )

        server.protocol.messages.clear()
        before_full = counters["full_translate"]

        # Shared mutation: move a point on the dataset both clients reference.
        scene.handles["points"].SetPoint(0, 5.0, 5.0, 5.0)
        scene.handles["points"].Modified()
        scene.handles["polydata"].Modified()
        push_sync.update()

        # No new full translate: both clients stayed on the patch path.
        assert counters["full_translate"] == before_full

        topics_by_client = {
            client_id: topic
            for topic, _payload, client_id in server.protocol.messages
        }
        assert topics_by_client == {
            "client-a": "trame.vtk.patch",
            "client-b": "trame.vtk.patch",
        }

        # Both clients' ledgers reach a single shadow snapshot.
        _assert_ledger_matches_shadow(
            push_sync,
            scene,
            OracleStep(
                name="shared-mutation",
                mutate=lambda _scene: None,
                expected_topic="trame.vtk.patch",
                expected_kind="patch",
            ),
        )

        # Drop client-a; it must be gone from every per-client map.
        push_sync.drop_client("client-a")
        assert "client-a" not in push_sync._view_clients
        assert "client-a" not in push_sync._client_states
        assert "client-a" not in push_sync._known_hashes
        assert "client-a" not in push_sync._collection_trackers
        assert "client-a" not in push_sync._client_epochs
        assert "client-a" not in push_sync._client_sequences
        assert "client-a" not in push_sync._client_statuses

        # Mutate again: only client-b receives a patch, only its cursor advances.
        server.protocol.messages.clear()
        before_seq_b = push_sync._client_sequences["client-b"]
        scene.handles["points"].SetPoint(0, 9.0, 9.0, 9.0)
        scene.handles["points"].Modified()
        scene.handles["polydata"].Modified()
        push_sync.update()

        recipients = {client_id for _t, _p, client_id in server.protocol.messages}
        assert recipients == {"client-b"}
        assert push_sync._client_sequences["client-b"] > before_seq_b

        # client-b's ledger remains equivalent to the shadow.
        _assert_ledger_matches_shadow(
            push_sync,
            scene,
            OracleStep(
                name="post-drop-mutation",
                mutate=lambda _scene: None,
                expected_topic="trame.vtk.patch",
                expected_kind="patch",
            ),
        )
    finally:
        push_sync.cleanup()
