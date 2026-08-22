"""Guard, bookkeeping and invariant coverage for the sparse-patch fast path.

``commit_hot_array_batch`` short-circuits a publish tick whose only change is
values inside an already-retained array: it commits ``patchArray`` ops before
VTK serialization, hashing and blob registration ever run. Everything that
tick did *not* look at is therefore never published, and nothing later heals
it -- the sweep only re-marks the dataset, which the guard then accepts again.
So each rejection condition is load-bearing, and each gets a test that fails
when that condition alone is removed.

Two conditions are deliberately tested against a synthetic batch instead of a
real tick: ``batch.structural`` and ``batch.producers`` are defense in depth,
subsumed in practice by the final subset check (a structural collection id and
a ``pipeline:`` pseudo-id are both dirty ids that no whitelist covers). Only a
hand-built batch isolates them.
"""

from __future__ import annotations

import numpy as np
import pytest
from vtkmodules.util.numpy_support import numpy_to_vtk

from push_oracle.scenes import add_actor, make_line_polydata, make_scalars_scene
from test_publisher import (
    POINT_COUNT,
    _FakeServer,
    _dataset_id,
    _start_retention,
    _touch_point,
    make_points_cloud_scene,
    run_coroutine,
)
from test_v2_oracle import MirrorClient
from trame_vtklocal.widgets.dirty_batch import DirtyBatch
from trame_vtklocal.widgets.hot_arrays import (
    commit_hot_array_batch,
    live_dataset_array,
)
from trame_vtklocal.widgets.publisher import ScenePublisher

HEAT_KEY = "field:pointData:Heat"


# ----------------------------------------------------------------------
# Harness
# ----------------------------------------------------------------------


def _make_publisher(scene, hot_array_keys=None):
    server = _FakeServer()
    publisher = ScenePublisher(
        server,
        scene.api,
        scene.render_window,
        scene.render_window_id,
        hot_array_keys=hot_array_keys,
    )
    return publisher, server


@pytest.fixture
def retained_points():
    """Point-cloud publisher whose ``points`` array is already retained."""
    scene = make_points_cloud_scene()
    publisher, server = _make_publisher(scene)
    try:
        _start_retention(scene, publisher, server)
        yield scene, publisher, server
    finally:
        publisher.cleanup()


def _pending_batch(publisher):
    """The batch one tick's mutations produced, without publishing it."""
    publisher._tracker.sweep()
    return publisher._tracker.consume()


def _try_fast_path(publisher, batch=None):
    """Call the guard exactly as ``_commit_batch`` does."""
    if batch is None:
        batch = _pending_batch(publisher)
    return commit_hot_array_batch(
        batch,
        publisher._object_manager,
        publisher.store,
        publisher._hot_arrays,
    )


# ----------------------------------------------------------------------
# The tick the fast path exists for
# ----------------------------------------------------------------------


def test_guard_accepts_a_pure_value_edit(retained_points):
    """Control for every rejection below: this tick must be accepted."""
    scene, publisher, _server = retained_points

    _touch_point(scene, 1234, (5.0, 6.0, 7.0))
    result = _try_fast_path(publisher)

    assert result is not None
    assert [op["op"] for op in result["ops"]] == ["patchArray"]
    assert result["ops"][0]["id"] == _dataset_id(scene)


# ----------------------------------------------------------------------
# One rejection test per class of skipped work
# ----------------------------------------------------------------------


def test_guard_rejects_a_structural_tick(retained_points):
    scene, publisher, _server = retained_points

    _touch_point(scene, 1234, (5.0, 6.0, 7.0))
    batch = _pending_batch(publisher)
    batch.structural = True

    assert _try_fast_path(publisher, batch) is None


def test_guard_rejects_a_producer_tick(retained_points):
    scene, publisher, _server = retained_points

    _touch_point(scene, 1234, (5.0, 6.0, 7.0))
    batch = _pending_batch(publisher)
    batch.producers = {id(scene.handles["mapper"]): scene.handles["mapper"]}

    assert _try_fast_path(publisher, batch) is None


def test_guard_rejects_an_empty_batch(retained_points):
    _scene, publisher, _server = retained_points

    assert _try_fast_path(publisher, DirtyBatch()) is None


def test_guard_rejects_the_first_mutation_of_an_array():
    """No retained copy yet: nothing to diff against, so nothing to patch."""
    scene = make_points_cloud_scene()
    publisher, _server = _make_publisher(scene)
    try:
        _touch_point(scene, 1234, (5.0, 6.0, 7.0))
        assert _try_fast_path(publisher) is None
    finally:
        publisher.cleanup()


def test_guard_rejects_an_over_cap_array(retained_points):
    scene, publisher, _server = retained_points
    # The cap is a constructor default with no publisher-level setting; the
    # guard reads it off the differ on every plan.
    publisher._hot_arrays._cap_bytes = 8

    _touch_point(scene, 1234, (5.0, 6.0, 7.0))

    assert _try_fast_path(publisher) is None


def test_guard_rejects_a_dtype_change(retained_points):
    """Same values, wider element type: only the dtype check can catch this.

    Every value compares equal against the retained float32 copy, so the
    change/span thresholds all say "nothing to send" -- and the node still
    advertises ``Float32Array``, so patching from the float64 buffer would
    put mis-sized elements on the wire.
    """
    scene, publisher, _server = retained_points
    dataset_id = _dataset_id(scene)
    live = live_dataset_array(scene.api.vtk_object_manager, dataset_id, "points")
    widened = live.astype(np.float64).reshape(-1, 3)

    scene.handles["points"].SetData(numpy_to_vtk(widened, deep=True))
    scene.handles["points"].Modified()

    assert _try_fast_path(publisher) is None


def test_guard_rejects_a_size_change(retained_points):
    scene, publisher, _server = retained_points
    coords = np.zeros((POINT_COUNT + 7, 3), dtype=np.float32)

    scene.handles["points"].SetData(numpy_to_vtk(coords, deep=True))
    scene.handles["points"].Modified()

    assert _try_fast_path(publisher) is None


def test_guard_rejects_more_spans_than_the_cap(retained_points):
    scene, publisher, _server = retained_points
    # Nine well-separated moves against a default cap of eight spans.
    for index in range(9):
        scene.handles["points"].SetPoint(index * 500, float(index), 1.0, 2.0)
    scene.handles["points"].Modified()

    assert _try_fast_path(publisher) is None


def test_guard_rejects_a_majority_rewrite(retained_points):
    """Past half the array, patching costs more than resending it.

    Two conditions enforce this (a changed-element short circuit before spans
    are assembled, and a patched-size check after); the test pins the outcome,
    so deleting either one alone still leaves it green.
    """
    scene, publisher, _server = retained_points
    for index in range(POINT_COUNT):
        scene.handles["points"].SetPoint(index, float(index), 0.5, -0.5)
    scene.handles["points"].Modified()

    assert _try_fast_path(publisher) is None


def test_guard_rejects_a_tick_that_also_changed_a_node(retained_points):
    """A point move plus an actor property: the actor edit has no patch."""
    scene, publisher, _server = retained_points

    _touch_point(scene, 1234, (5.0, 6.0, 7.0))
    scene.handles["actor"].SetVisibility(False)

    assert _try_fast_path(publisher) is None


def test_guard_rejects_an_unexplained_dirty_id_on_a_patchable_node():
    """Point move plus a field-data edit on the *same* dataset.

    The only candidate is the polydata and it does have a dirty hot array, so
    nothing but the final subset check stands between this tick and a commit
    that silently drops the field-data edit.
    """
    scene = make_points_cloud_scene(point_count=1_000)
    meta = numpy_to_vtk(np.arange(4, dtype=np.float32), deep=True)
    meta.SetName("Meta")
    scene.handles["polydata"].GetFieldData().AddArray(meta)
    publisher, server = _make_publisher(scene)
    try:
        _start_retention(scene, publisher, server)

        _touch_point(scene, 100, (5.0, 6.0, 7.0))
        meta.SetValue(2, -2.0)
        meta.Modified()
        batch = _pending_batch(publisher)
        assert batch.candidates == {_dataset_id(scene)}

        assert _try_fast_path(publisher, batch) is None
    finally:
        publisher.cleanup()


def test_guard_rejects_a_swept_node_with_no_hot_array_at_all(retained_points):
    """A node whose own MTime moved unobserved, and which has no hot array.

    Swept candidates are whitelisted, so the subset check passes here; only
    the "every candidate must have a dirty hot array" rule keeps the actor's
    change from being dropped. Suppressing the observer reproduces the
    false-negative the sweep exists to heal.
    """
    scene, publisher, _server = retained_points

    with publisher._tracker.suppress():
        scene.handles["actor"].SetVisibility(False)
    batch = _pending_batch(publisher)
    actor_id = str(scene.api.vtk_object_manager.GetId(scene.handles["actor"]))
    assert batch.candidates == {actor_id}
    assert actor_id in batch.swept_ids

    assert _try_fast_path(publisher, batch) is None


def test_guard_rejects_a_candidate_with_no_dirty_hot_array(retained_points):
    """The only candidate is a node the fast path cannot patch at all."""
    scene, publisher, _server = retained_points

    scene.handles["actor"].GetProperty().SetOpacity(0.25)
    batch = _pending_batch(publisher)
    assert batch.candidates

    assert _try_fast_path(publisher, batch) is None


def test_guard_rejects_a_structural_tick_end_to_end(retained_points):
    """The realistic shape of the structural case, through the publisher."""
    scene, publisher, server = retained_points

    _touch_point(scene, 1234, (5.0, 6.0, 7.0))
    polydata, _points = make_line_polydata()
    add_actor(scene.handles["renderer"], polydata)
    publisher.sync()

    ((_topic, message),) = server.protocol.drain()
    kinds = {op["op"] for op in message["ops"]}
    assert "upsert" in kinds
    assert "patchArray" in kinds


# ----------------------------------------------------------------------
# Field-array hot keys reach the fast path (and still fall back correctly)
# ----------------------------------------------------------------------


def _heat_scene(point_count=1_000):
    scene = make_points_cloud_scene(point_count=point_count)
    heat = numpy_to_vtk(np.arange(point_count, dtype=np.float32), deep=True)
    heat.SetName("Heat")
    other = numpy_to_vtk(np.arange(point_count, dtype=np.float32), deep=True)
    other.SetName("Other")
    scene.handles["polydata"].GetPointData().AddArray(heat)
    scene.handles["polydata"].GetPointData().AddArray(other)
    scene.handles["heat"] = heat
    scene.handles["other"] = other
    return scene


@pytest.fixture
def retained_heat():
    """Publisher with a ``field:pointData:`` hot key, already retaining it."""
    scene = _heat_scene()
    publisher, server = _make_publisher(scene, hot_array_keys={HEAT_KEY})
    try:
        scene.handles["heat"].SetValue(0, -1.0)
        scene.handles["heat"].Modified()
        publisher.sync()
        server.protocol.drain()  # first send starts retention
        yield scene, publisher, server
    finally:
        publisher.cleanup()


def test_field_array_value_edit_takes_the_fast_path(retained_heat):
    """Editing a point-data array's values is exactly what the bypass is for.

    Its owning ``vtkPointData`` lands in the tick's *swept* set (field data
    aggregates its arrays' MTimes without firing its own event), so the guard
    has to excuse it or this configuration never benefits.
    """
    scene, publisher, _server = retained_heat

    scene.handles["heat"].SetValue(100, 7.0)
    scene.handles["heat"].Modified()
    result = _try_fast_path(publisher)

    assert result is not None
    assert [op["key"] for op in result["ops"]] == [HEAT_KEY]
    assert [op["offset"] for op in result["ops"]] == [100]


def test_field_array_active_scalars_swap_falls_back(retained_heat):
    """The container's *own* edits fire its ModifiedEvent, so it is not swept.

    This is the line the whitelist must not cross: excusing a dirty
    ``vtkPointData`` unconditionally would drop this active-attribute change
    on the floor for good.
    """
    scene, publisher, _server = retained_heat

    scene.handles["heat"].SetValue(100, 7.0)
    scene.handles["heat"].Modified()
    scene.handles["polydata"].GetPointData().SetActiveScalars("Heat")

    assert _try_fast_path(publisher) is None


def test_field_array_sibling_edit_falls_back(retained_heat):
    """A non-hot array in the same container is its own unexcused dirty id."""
    scene, publisher, _server = retained_heat

    scene.handles["heat"].SetValue(100, 7.0)
    scene.handles["heat"].Modified()
    scene.handles["other"].SetValue(100, 7.0)
    scene.handles["other"].Modified()

    assert _try_fast_path(publisher) is None


# ----------------------------------------------------------------------
# The DirtyTracker invariant the guard rests on
# ----------------------------------------------------------------------


def test_every_polydata_child_stays_observed():
    """Tripwire: the guard is only sound while every dataset child is observed.

    ``commit_hot_array_batch`` excuses a dirty ``vtkPolyData`` whose MTime the
    sweep found moved, on the grounds that any change to a child it cannot
    patch also dirties that child. A child that drops out of the tracker's
    observed set turns that into silent, permanent client divergence: the
    tick takes the fast path, the child's change is never serialized, and no
    later tick heals it because the sweep only ever re-marks the polydata.

    ``_classes`` is the tracker's record of what ``sync_observers`` observed.
    """
    scene = make_scalars_scene()
    publisher, _server = _make_publisher(scene)
    try:
        publisher._tracker.sync_observers()
        classes = publisher._tracker.classes()
        object_manager = scene.api.vtk_object_manager
        polydata = scene.handles["polydata"]

        children = {
            "GetPoints()": polydata.GetPoints(),
            "GetPoints().GetData()": polydata.GetPoints().GetData(),
            "GetPointData()": polydata.GetPointData(),
            "GetCellData()": polydata.GetCellData(),
            "GetFieldData()": polydata.GetFieldData(),
            "GetVerts()": polydata.GetVerts(),
            "GetPolys()": polydata.GetPolys(),
        }
        for field_name in ("GetPointData", "GetCellData", "GetFieldData"):
            field_data = getattr(polydata, field_name)()
            for index in range(field_data.GetNumberOfArrays()):
                array = field_data.GetArray(index)
                children[f"{field_name}()[{array.GetName()}]"] = array

        unobserved = sorted(
            label
            for label, child in children.items()
            if str(object_manager.GetId(child)) not in classes
        )
        assert not unobserved, (
            "vtkPolyData children left the DirtyTracker's observed set: "
            + ", ".join(unobserved)
            + ". commit_hot_array_batch excuses a swept dataset id on the "
            "assumption that every child it cannot patch dirties itself; an "
            "unobserved child makes that assumption silent data loss."
        )
    finally:
        publisher.cleanup()


# ----------------------------------------------------------------------
# Retained-copy bookkeeping
# ----------------------------------------------------------------------


def test_fast_tick_advances_the_retained_copy_to_the_live_array(retained_points):
    """The server's model of what the client holds must match live VTK."""
    scene, publisher, server = retained_points

    _touch_point(scene, 20, (2.0, 3.0, 4.0))
    _touch_point(scene, 8_000, (5.0, 6.0, 7.0))
    publisher.sync()
    ((_topic, message),) = server.protocol.drain()
    assert [op["op"] for op in message["ops"]] == ["patchArray", "patchArray"]

    dataset_id = _dataset_id(scene)
    retained = publisher._hot_arrays._retained[dataset_id]
    live = live_dataset_array(scene.api.vtk_object_manager, dataset_id, "points")
    assert np.array_equal(retained, live)
    assert retained is not live  # a copy, not the live VTK view


def test_resync_after_a_run_of_fast_ticks_serves_the_live_array(retained_points):
    """A client joining mid-stream must get the geometry VTK actually holds."""
    scene, publisher, server = retained_points

    for tick in range(6):
        _touch_point(scene, tick * 700, (float(tick), 1.0, 2.0))
        publisher.sync()
        ((_topic, message),) = server.protocol.drain()
        assert [op["op"] for op in message["ops"]] == ["patchArray"]

    client = MirrorClient()
    client.resync(publisher)

    dataset_id = _dataset_id(scene)
    entry = client.nodes[dataset_id]["arrays"]["points"]
    served = np.frombuffer(client.blobs[entry["ref"]], dtype=np.float32)
    live = live_dataset_array(scene.api.vtk_object_manager, dataset_id, "points")
    assert np.array_equal(served, live)


def test_dirty_but_unchanged_array_publishes_nothing(retained_points):
    """A verified no-op emits no ops, mints no seq, and does not wedge."""
    scene, publisher, server = retained_points
    seq_before = publisher.store.seq

    scene.handles["points"].Modified()
    publisher.sync()

    assert server.protocol.drain() == []
    assert publisher.store.seq == seq_before
    run_coroutine(publisher.settled())
    assert server.protocol.drain() == []
    assert publisher.store.seq == seq_before
