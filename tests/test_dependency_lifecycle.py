"""Published client state against freshly serialized VTK, without healing between edits."""

import copy

import pytest
from vtkmodules.vtkCommonCore import vtkFloatArray, vtkPoints
from vtkmodules.vtkCommonMath import vtkMatrix4x4
from vtkmodules.vtkCommonTransforms import vtkTransform
from vtkmodules.vtkFiltersSources import vtkConeSource
from vtkmodules.vtkRenderingCore import vtkProperty

from push_oracle.scenes import add_actor, make_basic_scene
from test_v2_oracle import MirrorClient, make_publisher
from trame_vtklocal.module.node_translator import translate_scene


def canonical(nodes, blob):
    result = copy.deepcopy(nodes)
    for node in result.values():
        props = node.get("props", {})
        for key in ("estimatedRenderTime", "renderTimeMultiplier"):
            props.pop(key, None)
        for entry in node.get("arrays", {}).values():
            entry["ref"] = bytes(blob(entry["ref"]))
    return result


def assert_live(scene, publisher, client):
    # Capture the actual received bytes before reference serialization can
    # refresh manager state or accidentally repair any publisher bookkeeping.
    actual = canonical(client.nodes, client.blobs.__getitem__)
    with publisher._tracker.suppress():
        scene.render_window.Render()
        manager = scene.api.vtk_object_manager
        manager.UpdateStatesFromObjects([scene.render_window_id])
        expected = translate_scene(manager, scene.render_window_id)
        expected = canonical(expected, publisher._resolve_ref_payload)
    assert actual == expected


def replace(scene, kind):
    h = scene.handles
    if kind == "points":
        child = vtkPoints()
        child.InsertNextPoint(0, 0, 0)
        child.InsertNextPoint(1, 1, 0)
        h["polydata"].SetPoints(child)
    elif kind == "property":
        child = vtkProperty()
        child.SetOpacity(0.8)
        h["actor"].SetProperty(child)
    elif kind == "array":
        child = vtkFloatArray()
        child.SetName("probe")
        child.InsertNextValue(1)
        child.InsertNextValue(2)
        h["polydata"].GetPointData().SetScalars(child)
    elif kind == "pipeline":
        child = vtkConeSource()
        # Intentionally leave it unexecuted; publication must update it.
        h["mapper"].SetInputConnection(child.GetOutputPort())
    elif kind == "matrix":
        child = vtkMatrix4x4()
        h["actor"].SetUserMatrix(child)
    else:
        child = vtkTransform()
        h["actor"].SetUserTransform(child)
    h["replacement"] = child


def edit(scene, kind):
    child = scene.handles["replacement"]
    if kind == "points":
        child.SetPoint(0, 7, 8, 9)
        child.Modified()
    elif kind == "property":
        child.SetOpacity(0.2)
    elif kind == "array":
        child.SetValue(0, 42)
        child.Modified()
    elif kind == "pipeline":
        child.SetHeight(4)
    elif kind == "matrix":
        child.SetElement(0, 3, 12)
    else:
        child.Translate(12, 0, 0)


@pytest.mark.parametrize(
    "kind", ["points", "property", "array", "pipeline", "matrix", "transform"]
)
@pytest.mark.parametrize("steps", [1, 2])
def test_replace_then_edit_matches_live_vtk(kind, steps):
    scene = make_basic_scene()
    publisher, server = make_publisher(scene)
    client = MirrorClient()
    client.resync(publisher)
    try:
        for mutate in (replace, edit)[:steps]:
            with publisher.transaction():
                mutate(scene, kind)
            for _, message in server.protocol.drain():
                client.apply(message)
        assert_live(scene, publisher, client)
    finally:
        publisher.cleanup()


def test_detached_property_no_longer_schedules_work():
    scene = make_basic_scene()
    publisher, server = make_publisher(scene)
    old = scene.handles["actor"].GetProperty()
    try:
        replace(scene, "property")
        publisher.sync()
        server.protocol.drain()
        old.SetOpacity(0.3)
        assert not publisher._tracker.has_pending()
        edit(scene, "property")
        publisher.sync()
        assert len(server.protocol.drain()) == 1
    finally:
        publisher.cleanup()


def test_shared_property_remains_observed_until_last_owner_detaches():
    scene = make_basic_scene()
    shared = scene.handles["actor"].GetProperty()
    other, _mapper = add_actor(scene.handles["renderer"], scene.handles["polydata"])
    other.SetProperty(shared)
    publisher, server = make_publisher(scene)
    client = MirrorClient()
    client.resync(publisher)
    try:
        replace(scene, "property")
        publisher.sync()
        shared.SetOpacity(0.4)
        publisher.sync()
        for _, message in server.protocol.drain():
            client.apply(message)
        assert_live(scene, publisher, client)
    finally:
        publisher.cleanup()


def test_scheduled_publish_followed_by_sync_does_not_refresh_twice(monkeypatch):
    scene = make_basic_scene()
    publisher, server = make_publisher(scene)
    try:
        scene.handles["actor"].SetVisibility(False)
        publisher._run_scheduled_publish()
        assert len(server.protocol.drain()) == 1

        def unexpected(*args):
            pytest.fail("unchanged sync must not scan or serialize")

        monkeypatch.setattr(publisher, "_refresh_object_states", unexpected)
        monkeypatch.setattr(publisher._tracker, "sweep", unexpected)
        publisher.sync()
    finally:
        publisher.cleanup()


def test_precommit_failure_retries_changes_and_commands(monkeypatch):
    scene = make_basic_scene()
    publisher, server = make_publisher(scene)
    original = publisher._refresh_object_states
    try:
        publisher.send_command("probe")
        scene.handles["actor"].SetVisibility(False)

        def fail(_ids):
            raise RuntimeError("injected")

        monkeypatch.setattr(publisher, "_refresh_object_states", fail)
        with pytest.raises(RuntimeError, match="injected"):
            publisher.sync()
        monkeypatch.setattr(publisher, "_refresh_object_states", original)
        publisher.sync()
        ((_, message),) = server.protocol.drain()
        assert message["commands"][0]["name"] == "probe"
        actor_id = str(scene.api.vtk_object_manager.GetId(scene.handles["actor"]))
        assert publisher.store.get(actor_id)["props"]["visibility"] == 0
    finally:
        publisher.cleanup()


@pytest.mark.parametrize("fast", [True, False])
def test_failed_commit_preserves_retained_array_for_retry(monkeypatch, fast):
    from test_hot_array_fast_path import (
        _make_publisher,
        _start_retention,
        _touch_point,
        make_points_cloud_scene,
    )

    scene = make_points_cloud_scene(point_count=1000)
    publisher, server = _make_publisher(scene)
    _start_retention(scene, publisher, server)
    client = MirrorClient()
    client.resync(publisher)
    before = {
        key: value.copy() for key, value in publisher._hot_arrays._retained.items()
    }
    original = publisher.store._commit
    try:
        _touch_point(scene, 123, (5, 6, 7))
        if not fast:
            scene.handles["actor"].SetVisibility(False)

        def fail(*args):
            raise ValueError("injected commit failure")

        monkeypatch.setattr(publisher.store, "_commit", fail)
        with pytest.raises(ValueError, match="injected"):
            publisher.sync()
        import numpy as np

        for key, value in before.items():
            np.testing.assert_array_equal(value, publisher._hot_arrays._retained[key])
        monkeypatch.setattr(publisher.store, "_commit", original)
        publisher.sync()
        for _, message in server.protocol.drain():
            client.apply(message)
        assert_live(scene, publisher, client)
    finally:
        publisher.cleanup()


def test_shared_points_detach_one_owner_then_edit():
    from vtkmodules.vtkCommonDataModel import vtkPolyData

    scene = make_basic_scene()
    shared = scene.handles["polydata"].GetPoints()
    second_data = vtkPolyData()
    second_data.SetPoints(shared)
    second, _mapper = add_actor(scene.handles["renderer"], second_data)
    publisher, server = make_publisher(scene)
    client = MirrorClient()
    client.resync(publisher)
    try:
        replace(scene, "points")
        publisher.sync()
        shared.SetPoint(0, 20, 30, 40)
        shared.Modified()
        publisher.sync()
        for _, message in server.protocol.drain():
            client.apply(message)
        assert_live(scene, publisher, client)
    finally:
        publisher.cleanup()


def test_replaced_pipeline_detaches_old_producer_and_tracks_reconnection():
    from vtkmodules.vtkFiltersGeneral import vtkTransformPolyDataFilter

    scene = make_basic_scene()
    old = vtkConeSource()
    terminal = vtkTransformPolyDataFilter()
    terminal.SetTransform(vtkTransform())
    terminal.SetInputConnection(old.GetOutputPort())
    scene.handles["mapper"].SetInputConnection(terminal.GetOutputPort())
    publisher, server = make_publisher(scene)
    client = MirrorClient()
    client.resync(publisher)
    try:
        new = vtkConeSource()
        new.SetResolution(12)
        terminal.SetInputConnection(new.GetOutputPort())
        publisher.sync()
        old.SetHeight(8)
        assert not publisher._tracker.has_pending()
        new.SetHeight(4)
        publisher.sync()
        for _, message in server.protocol.drain():
            client.apply(message)
        assert_live(scene, publisher, client)
    finally:
        publisher.cleanup()


def test_repeated_replacements_keep_observers_bounded():
    scene = make_basic_scene()
    publisher, server = make_publisher(scene)
    try:
        counts = []
        for _ in range(20):
            replace(scene, "points")
            publisher.sync()
            counts.append(len(publisher._tracker._observed_objects))
        assert len(set(counts)) == 1
        assert not publisher._tracker.has_pending()
    finally:
        publisher.cleanup()


def test_pipeline_transform_concatenation_is_polled():
    from vtkmodules.vtkFiltersGeneral import vtkTransformPolyDataFilter

    scene = make_basic_scene()
    transform = vtkTransform()
    transform_filter = vtkTransformPolyDataFilter()
    transform_filter.SetTransform(transform)
    transform_filter.SetInputData(scene.handles["polydata"])
    scene.handles["mapper"].SetInputConnection(transform_filter.GetOutputPort())
    publisher, server = make_publisher(scene)
    client = MirrorClient()
    client.resync(publisher)
    try:
        with publisher.transaction():
            transform.Translate(8, 9, 10)
        for _, message in server.protocol.drain():
            client.apply(message)
        assert_live(scene, publisher, client)
    finally:
        publisher.cleanup()


def test_pipeline_implicit_function_edit_updates_output_without_manual_modified():
    from vtkmodules.vtkCommonDataModel import vtkPlane
    from vtkmodules.vtkFiltersCore import vtkClipPolyData

    scene = make_basic_scene()
    cone = vtkConeSource()
    cone.SetResolution(12)
    plane = vtkPlane()
    plane.SetNormal(1, 0, 0)
    clip = vtkClipPolyData()
    clip.SetInputConnection(cone.GetOutputPort())
    clip.SetClipFunction(plane)
    scene.handles["mapper"].SetInputConnection(clip.GetOutputPort())
    publisher, server = make_publisher(scene)
    client = MirrorClient()
    client.resync(publisher)
    try:
        with publisher.transaction():
            plane.SetOrigin(0.2, 0, 0)
        for _, message in server.protocol.drain():
            client.apply(message)
        assert_live(scene, publisher, client)
    finally:
        publisher.cleanup()


def test_unserialized_pipeline_input_points_are_observed():
    from vtkmodules.vtkFiltersGeneral import vtkTransformPolyDataFilter

    scene = make_basic_scene()
    source_data = scene.handles["polydata"]
    transform_filter = vtkTransformPolyDataFilter()
    transform_filter.SetTransform(vtkTransform())
    transform_filter.SetInputData(source_data)
    scene.handles["mapper"].SetInputConnection(transform_filter.GetOutputPort())
    publisher, server = make_publisher(scene)
    client = MirrorClient()
    client.resync(publisher)
    try:
        with publisher.transaction():
            source_data.GetPoints().SetPoint(0, 5, 6, 7)
            source_data.GetPoints().Modified()
        for _, message in server.protocol.drain():
            client.apply(message)
        assert_live(scene, publisher, client)
    finally:
        publisher.cleanup()


def test_shared_direct_and_filtered_input_updates_both_paths():
    from vtkmodules.vtkFiltersGeneral import vtkTransformPolyDataFilter

    scene = make_basic_scene()
    data = scene.handles["polydata"]
    transform_filter = vtkTransformPolyDataFilter()
    transform_filter.SetTransform(vtkTransform())
    transform_filter.SetInputData(data)
    # Keep the original direct actor and add the filtered output.
    transform_filter.Update()
    _, mapper = add_actor(scene.handles["renderer"], transform_filter.GetOutput())
    mapper.SetInputConnection(transform_filter.GetOutputPort())
    publisher, server = make_publisher(scene)
    client = MirrorClient()
    client.resync(publisher)
    try:
        with publisher.transaction():
            data.GetPoints().SetPoint(0, 5, 6, 7)
            data.GetPoints().Modified()
        for _, message in server.protocol.drain():
            client.apply(message)
        assert_live(scene, publisher, client)
    finally:
        publisher.cleanup()


def test_failed_replacement_commit_preserves_new_events_and_commands(monkeypatch):
    scene = make_basic_scene()
    publisher, server = make_publisher(scene)
    original = publisher.store._commit
    client = MirrorClient()
    client.resync(publisher)
    try:
        replace(scene, "property")
        publisher.send_command("first")

        def fail(*args):
            publisher.send_command("second")
            raise ValueError("injected after reconciliation")

        monkeypatch.setattr(publisher.store, "_commit", fail)
        with pytest.raises(ValueError, match="injected"):
            publisher.sync()
        edit(scene, "property")
        monkeypatch.setattr(publisher.store, "_commit", original)
        publisher.sync()
        ((_, message),) = server.protocol.drain()
        assert [command["name"] for command in message["commands"]] == [
            "first",
            "second",
        ]
        client.apply(message)
        assert_live(scene, publisher, client)
    finally:
        publisher.cleanup()


def test_pipeline_output_object_replacement_then_edit():
    from vtkmodules.vtkCommonExecutionModel import vtkTrivialProducer
    from push_oracle.scenes import make_line_polydata

    scene = make_basic_scene()
    producer = vtkTrivialProducer()
    producer.SetOutput(scene.handles["polydata"])
    scene.handles["mapper"].SetInputConnection(producer.GetOutputPort())
    publisher, server = make_publisher(scene)
    client = MirrorClient()
    client.resync(publisher)
    try:
        data, _points = make_line_polydata()
        with publisher.transaction():
            producer.SetOutput(data)
        with publisher.transaction():
            data.GetPoints().SetPoint(0, 5, 6, 7)
            data.GetPoints().Modified()
        for _, message in server.protocol.drain():
            client.apply(message)
        assert_live(scene, publisher, client)
    finally:
        publisher.cleanup()


def test_server_camera_edits_do_not_refresh_the_client_scene(monkeypatch):
    scene = make_basic_scene()
    publisher, server = make_publisher(scene)
    try:

        def unexpected(*args):
            pytest.fail("client-owned camera edits must not serialize the renderer")

        monkeypatch.setattr(publisher, "_refresh_object_states", unexpected)
        with publisher.transaction():
            scene.handles["renderer"].GetActiveCamera().SetPosition(5, 6, 7)
        assert server.protocol.drain() == []
    finally:
        publisher.cleanup()
