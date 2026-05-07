"""Self-tests for the push-sync oracle harness.

These exist so "the oracle catches stale ledgers" and "the shadow snapshot
doesn't pollute live tracking" stay regression-tested as the harness evolves.
"""

import pytest

from push_oracle import OracleMismatch, OracleStep, run_oracle_steps, take_shadow_snapshot
from push_oracle.harness import _FakeServer, _make_real_push_sync
from push_oracle.normalize import first_difference, normalize
from push_oracle.scenes import make_basic_scene


def _hide_actor(scene):
    scene.handles["actor"].SetVisibility(False)


# ----------------------------------------------------------------------
# Self-test 1: harness sensitivity to dirty-tracking gaps
# ----------------------------------------------------------------------


def test_oracle_detects_when_dirty_tracking_misses_actor_change(monkeypatch):
    """If both the observer-driven and status-snapshot paths miss a mutation,
    the patch ledger goes stale and the oracle must surface it.

    We sabotage:
    - ``_observe_dirty_object``: kills observer-based dirty marking
    - ``_snapshot_status``: kills the status-snapshot fallback's mtime/hash
      tracking by re-emitting a frozen status

    The plan calls out monkeypatching ``_observe_dirty_object`` alone, but
    ``update()`` falls back to ``_update_from_status_snapshot`` when no objects
    are observed, and that path catches changes via mtime. Both must be
    silenced for the oracle to actually see a stale ledger.
    """
    from trame_vtklocal.widgets.push_sync import PushSync

    monkeypatch.setattr(PushSync, "_observe_dirty_object", lambda self, *_args, **_kw: None)

    snapshot_counter = {"value": 0}
    real_snapshot = PushSync._snapshot_status

    def frozen_snapshot(self):
        snapshot_counter["value"] += 1
        if snapshot_counter["value"] == 1:
            return real_snapshot(self)
        # Re-emit the cached status so dirty-via-mtime detection misses.
        return self._client_statuses.get("client-a")

    monkeypatch.setattr(PushSync, "_snapshot_status", frozen_snapshot)

    actor_id = None
    with pytest.raises(OracleMismatch) as excinfo:
        scene = make_basic_scene()
        actor_id = str(scene.api.vtk_object_manager.GetId(scene.handles["actor"]))
        run_oracle_steps(
            lambda: scene,
            [OracleStep(name="hide-actor", mutate=_hide_actor)],
        )

    report = str(excinfo.value)
    assert actor_id is not None
    assert f"object {actor_id}" in report, (
        f"expected first-differing object id {actor_id!r} in oracle report:\n{report}"
    )


# ----------------------------------------------------------------------
# Self-test 2: dependency signatures are part of the oracle
# ----------------------------------------------------------------------


def test_normalizer_preserves_dependency_edges():
    """Two ledgers with the same object ids but different dependency edges
    must not compare equal."""

    def no_arrays(_descriptor):
        return None

    left = {
        "id": "rw",
        "type": "vtkRenderWindow",
        "dependencies": [
            {
                "id": "mapper",
                "type": "vtkMapper",
                "dependencies": [{"id": "poly-a", "type": "vtkPolyData"}],
            },
            {"id": "poly-a", "type": "vtkPolyData"},
            {"id": "poly-b", "type": "vtkPolyData"},
        ],
    }
    right = {
        "id": "rw",
        "type": "vtkRenderWindow",
        "dependencies": [
            {
                "id": "mapper",
                "type": "vtkMapper",
                "dependencies": [{"id": "poly-b", "type": "vtkPolyData"}],
            },
            {"id": "poly-a", "type": "vtkPolyData"},
            {"id": "poly-b", "type": "vtkPolyData"},
        ],
    }

    normalized_left = normalize(left, no_arrays)
    normalized_right = normalize(right, no_arrays)

    assert normalized_left != normalized_right
    assert "dependencies" in first_difference(normalized_left, normalized_right)


# ----------------------------------------------------------------------
# Self-test 3: shadow-snapshot non-interference
# ----------------------------------------------------------------------


def _snapshot_dirty_bookkeeping(push_sync):
    return {
        "object_ids": set(push_sync._dirty_object_ids),
        "owner_ids": {k: set(v) for k, v in push_sync._dirty_owner_ids.items()},
        "pipeline_updates_keys": {
            k: set(v.keys()) for k, v in push_sync._dirty_pipeline_updates.items()
        },
        "structural_ids": set(push_sync._dirty_structural_ids),
        "structure_pending": push_sync._dirty_structure_pending,
    }


def test_take_shadow_snapshot_preserves_dirty_bookkeeping():
    scene = make_basic_scene()
    server = _FakeServer()
    push_sync, _ = _make_real_push_sync(server, scene)
    try:
        push_sync.client_resync("client-a")

        scene.handles["actor"].SetVisibility(False)
        pre = _snapshot_dirty_bookkeeping(push_sync)
        take_shadow_snapshot(push_sync)
        post = _snapshot_dirty_bookkeeping(push_sync)
        assert pre == post, (
            "take_shadow_snapshot must not mutate dirty bookkeeping "
            f"(pre-update). pre={pre} post={post}"
        )

        push_sync.update()

        scene.handles["actor"].GetProperty().SetOpacity(0.5)
        pre = _snapshot_dirty_bookkeeping(push_sync)
        take_shadow_snapshot(push_sync)
        post = _snapshot_dirty_bookkeeping(push_sync)
        assert pre == post, (
            "take_shadow_snapshot must not mutate dirty bookkeeping "
            f"(post-update). pre={pre} post={post}"
        )
    finally:
        push_sync.cleanup()


def test_take_shadow_snapshot_does_not_leak_collection_tracker():
    scene = make_basic_scene()
    server = _FakeServer()
    push_sync, _ = _make_real_push_sync(server, scene)
    try:
        push_sync.client_resync("client-a")

        take_shadow_snapshot(push_sync)
        take_shadow_snapshot(push_sync)

        assert "__oracle_shadow__" not in push_sync._collection_trackers, (
            "shadow tracker must be popped after each snapshot"
        )
    finally:
        push_sync.cleanup()
