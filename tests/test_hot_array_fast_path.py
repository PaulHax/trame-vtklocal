"""Eligibility and recovery regressions for retained-array publication."""

from __future__ import annotations

import numpy as np
import pytest
from vtkmodules.util.numpy_support import numpy_to_vtk

from push_oracle.harness import (
    MirrorClient,
    cloud_dataset_id,
    make_publisher,
    start_retention,
    touch_point,
)
from push_oracle.scenes import (
    POINT_COUNT,
    add_actor,
    make_line_polydata,
    make_points_cloud_scene,
    make_scalars_scene,
)
from trame_vtklocal.widgets.dirty_batch import DirtyBatch
from trame_vtklocal.widgets.hot_array_batch import commit_hot_array_batch
from trame_vtklocal.widgets.hot_arrays import live_dataset_array


@pytest.fixture
def retained_points():
    """Point-cloud publisher whose ``points`` array is already retained."""
    scene = make_points_cloud_scene()
    publisher, server = make_publisher(scene)
    try:
        start_retention(scene, publisher, server)
        yield scene, publisher, server
    finally:
        publisher.cleanup()


def _pending_batch(publisher):
    """The batch one tick's mutations produced, without publishing it."""
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

    touch_point(scene, 1234, (5.0, 6.0, 7.0))
    result = _try_fast_path(publisher)

    assert result is not None
    assert [op["op"] for op in result["ops"]] == ["patchArray"]
    assert result["ops"][0]["id"] == cloud_dataset_id(scene)


# ----------------------------------------------------------------------
# One rejection test per class of skipped work
# ----------------------------------------------------------------------


def test_guard_rejects_a_structural_tick(retained_points):
    scene, publisher, _server = retained_points

    touch_point(scene, 1234, (5.0, 6.0, 7.0))
    batch = _pending_batch(publisher)
    batch.structural = True

    assert _try_fast_path(publisher, batch) is None


def test_guard_rejects_a_mapper_tick(retained_points):
    scene, publisher, _server = retained_points

    touch_point(scene, 1234, (5.0, 6.0, 7.0))
    batch = _pending_batch(publisher)
    batch.mappers = {id(scene.handles["mapper"]): scene.handles["mapper"]}

    assert _try_fast_path(publisher, batch) is None


def test_guard_rejects_an_empty_batch(retained_points):
    _scene, publisher, _server = retained_points

    assert _try_fast_path(publisher, DirtyBatch()) is None


def test_guard_rejects_the_first_mutation_of_an_array():
    """No retained copy yet: nothing to diff against, so nothing to patch."""
    scene = make_points_cloud_scene()
    publisher, _server = make_publisher(scene)
    try:
        touch_point(scene, 1234, (5.0, 6.0, 7.0))
        assert _try_fast_path(publisher) is None
    finally:
        publisher.cleanup()


def test_guard_rejects_a_dtype_change(retained_points):
    """Same values, wider element type: only the dtype check can catch this.

    Every value compares equal against the retained float32 copy, so the
    change/span thresholds all say "nothing to send" -- and the node still
    advertises ``Float32Array``, so patching from the float64 buffer would
    put mis-sized elements on the wire.
    """
    scene, publisher, _server = retained_points
    dataset_id = cloud_dataset_id(scene)
    live = live_dataset_array(scene.api.vtk_object_manager, dataset_id)
    widened = live.astype(np.float64).reshape(-1, 3)

    scene.handles["points"].SetData(numpy_to_vtk(widened, deep=True))
    scene.handles["points"].Modified()

    assert _try_fast_path(publisher) is None


def test_guard_rejects_more_spans_than_the_cap(retained_points):
    scene, publisher, _server = retained_points
    # Nine well-separated moves against a default cap of eight spans.
    for index in range(9):
        scene.handles["points"].SetPoint(index * 500, float(index), 1.0, 2.0)
    scene.handles["points"].Modified()

    assert _try_fast_path(publisher) is None


def test_guard_rejects_a_tick_that_also_changed_a_node(retained_points):
    """A point move plus an actor property: the actor edit has no patch."""
    scene, publisher, _server = retained_points

    touch_point(scene, 1234, (5.0, 6.0, 7.0))
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
    publisher, server = make_publisher(scene)
    try:
        start_retention(scene, publisher, server)

        touch_point(scene, 100, (5.0, 6.0, 7.0))
        meta.SetValue(2, -2.0)
        meta.Modified()
        batch = _pending_batch(publisher)
        assert batch.candidates == {cloud_dataset_id(scene)}

        assert _try_fast_path(publisher, batch) is None
    finally:
        publisher.cleanup()


def test_guard_rejects_a_swept_node_with_no_hot_array_at_all(retained_points):
    """Suppressed edits require recovery and cannot use the array fast path."""
    scene, publisher, _server = retained_points

    with publisher._tracker.suppress():
        scene.handles["actor"].SetVisibility(False)
    publisher._tracker.sweep()
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

    touch_point(scene, 1234, (5.0, 6.0, 7.0))
    polydata, _points = make_line_polydata()
    add_actor(scene.handles["renderer"], polydata)
    publisher.sync()

    ((_topic, message),) = server.protocol.drain()
    kinds = {op["op"] for op in message["ops"]}
    assert "upsert" in kinds
    assert "patchArray" in kinds


@pytest.mark.parametrize(
    ("point_count", "moved"),
    [(4, 4), (POINT_COUNT, 1)],
    ids=["small-array-rewrite", "sparse-patch"],
)
def test_edits_to_a_swapped_in_points_array_reach_the_client(point_count, moved):
    """``vtkPoints.SetData`` fires only the points, a patchable dirty source.

    The array it swaps in is new to the node's state and to the tracker, so a
    later edit made to that array alone must still reach a following client.
    """
    scene = make_points_cloud_scene(point_count=point_count)
    publisher, server = make_publisher(scene)
    try:
        start_retention(scene, publisher, server)
        client = MirrorClient()
        client.resync(publisher)
        object_manager = scene.api.vtk_object_manager
        dataset_id = cloud_dataset_id(scene)

        values = live_dataset_array(object_manager, dataset_id).copy()
        values[: 3 * moved] += 1.0
        replacement = numpy_to_vtk(values.reshape(-1, 3), deep=True)
        scene.handles["points"].SetData(replacement)
        publisher.sync()
        replacement.SetTuple3(point_count - 1, 7.0, 7.0, 7.0)
        replacement.Modified()
        publisher.sync()
        for _topic, message in server.protocol.drain():
            assert client.apply(message) == "applied"

        entry = client.nodes[dataset_id]["arrays"]["points"]
        shown = np.frombuffer(client.blobs[entry["ref"]], dtype=np.float32)
        assert shown[-3:].tolist() == [7.0, 7.0, 7.0]
        assert np.array_equal(shown, live_dataset_array(object_manager, dataset_id))
    finally:
        publisher.cleanup()


# ----------------------------------------------------------------------
# The DirtyTracker invariant the guard rests on
# ----------------------------------------------------------------------


def test_every_polydata_child_stays_observed():
    """Every dataset child must be observed for ordinary publication."""
    scene = make_scalars_scene()
    publisher, _server = make_publisher(scene)
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
            + ". Unobserved children cannot trigger ordinary publication."
        )
    finally:
        publisher.cleanup()


# ----------------------------------------------------------------------
# Retained-copy bookkeeping
# ----------------------------------------------------------------------


def test_fast_tick_advances_the_retained_copy_to_the_live_array(retained_points):
    """The server's model of what the client holds must match live VTK."""
    scene, publisher, server = retained_points

    touch_point(scene, 20, (2.0, 3.0, 4.0))
    touch_point(scene, 8_000, (5.0, 6.0, 7.0))
    publisher.sync()
    ((_topic, message),) = server.protocol.drain()
    assert [op["op"] for op in message["ops"]] == ["patchArray", "patchArray"]

    dataset_id = cloud_dataset_id(scene)
    retained = publisher._hot_arrays._retained[(dataset_id, "points")]
    live = live_dataset_array(scene.api.vtk_object_manager, dataset_id)
    assert np.array_equal(retained, live)
    assert retained is not live  # a copy, not the live VTK view


def test_resync_after_a_run_of_fast_ticks_serves_the_live_array(retained_points):
    """A client joining mid-stream must get the geometry VTK actually holds."""
    scene, publisher, server = retained_points

    for tick in range(6):
        touch_point(scene, tick * 700, (float(tick), 1.0, 2.0))
        publisher.sync()
        ((_topic, message),) = server.protocol.drain()
        assert [op["op"] for op in message["ops"]] == ["patchArray"]

    client = MirrorClient()
    client.resync(publisher)

    dataset_id = cloud_dataset_id(scene)
    entry = client.nodes[dataset_id]["arrays"]["points"]
    served = np.frombuffer(client.blobs[entry["ref"]], dtype=np.float32)
    live = live_dataset_array(scene.api.vtk_object_manager, dataset_id)
    assert np.array_equal(served, live)


def test_dirty_but_unchanged_array_publishes_nothing(retained_points):
    """A verified no-op emits no ops, mints no seq, and does not wedge."""
    scene, publisher, server = retained_points
    seq_before = publisher.store.seq

    scene.handles["points"].Modified()
    publisher.sync()

    assert server.protocol.drain() == []
    assert publisher.store.seq == seq_before
    publisher.sync()
    assert server.protocol.drain() == []
    assert publisher.store.seq == seq_before


def test_recovery_does_not_mistake_suppressed_metadata_for_aggregate_mtime():
    scene = make_points_cloud_scene(point_count=1_000)
    heat = numpy_to_vtk(np.arange(1_000, dtype=np.float32), deep=True)
    heat.SetName("Heat")
    scene.handles["polydata"].GetPointData().AddArray(heat)
    publisher, _server = make_publisher(scene)
    try:
        with publisher._tracker.suppress():
            scene.handles["polydata"].GetPointData().SetActiveScalars("Heat")
            heat.SetValue(100, 7.0)
            heat.Modified()
        publisher.recover()
        arrays = publisher.store.get(cloud_dataset_id(scene))["arrays"]
        assert arrays["field:pointData:Heat"]["registration"] == "setScalars"
    finally:
        publisher.cleanup()
