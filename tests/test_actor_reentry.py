"""Reattached actors deliver current geometry, independently of stored state."""

import numpy as np
import pytest
from vtkmodules.util.numpy_support import vtk_to_numpy
from vtkmodules.vtkCommonCore import vtkPoints
from vtkmodules.vtkCommonTransforms import vtkTransform
from vtkmodules.vtkFiltersGeneral import vtkTransformPolyDataFilter

from push_oracle.scenes import add_actor, make_quad_scene
from test_v2_oracle import MirrorClient, hot_array_fast_path, make_publisher


def flush(publisher, server, client):
    publisher.sync()
    for _, message in server.protocol.drain():
        assert client.apply(message) == "applied"


def assert_points(scene, client, data=None):
    data = data if data is not None else scene.handles["polydata"]
    data_id = str(scene.api.vtk_object_manager.GetId(data))
    entry = client.nodes[data_id]["arrays"]["points"]
    actual = np.frombuffer(client.blobs[entry["ref"]], dtype=np.float32)
    np.testing.assert_array_equal(
        actual, vtk_to_numpy(data.GetPoints().GetData()).ravel()
    )


def move(data, x):
    data.GetPoints().SetPoint(1, x, 0, 0)
    data.GetPoints().Modified()


@pytest.mark.parametrize("fast", [False, True])
@pytest.mark.parametrize("before", [False, True])
@pytest.mark.parametrize("mutation", ["unchanged", "point", "replacement", "pipeline"])
def test_actor_reentry_delivers_live_points(fast, before, mutation):
    scene = make_quad_scene()
    h = scene.handles
    with hot_array_fast_path(fast):
        publisher, server = make_publisher(scene)
        client = MirrorClient()
        client.resync(publisher)
        try:
            if before:
                move(h["polydata"], 1.25)
                flush(publisher, server, client)
                move(h["polydata"], 1.5)
                flush(publisher, server, client)
            h["renderer"].RemoveActor(h["actor"])
            flush(publisher, server, client)
            assert (
                str(scene.api.vtk_object_manager.GetId(h["actor"])) not in client.nodes
            )
            assert not client.blobs
            if mutation == "point":
                move(h["polydata"], 2.5)
            elif mutation == "replacement":
                points = vtkPoints()
                points.DeepCopy(h["polydata"].GetPoints())
                points.SetPoint(1, 3.5, 0, 0)
                h["polydata"].SetPoints(points)
            elif mutation == "pipeline":
                transform = vtkTransform()
                transform.Translate(2, 3, 4)
                pipeline = vtkTransformPolyDataFilter()
                pipeline.SetTransform(transform)
                pipeline.SetInputData(h["polydata"])
                h["mapper"].SetInputConnection(pipeline.GetOutputPort())
            flush(publisher, server, client)
            h["renderer"].AddActor(h["actor"])
            flush(publisher, server, client)
            data = h["mapper"].GetInput()
            assert_points(scene, client, data)
            if mutation == "pipeline":
                np.testing.assert_array_equal(data.GetPoint(0), (2, 3, 4))
            move(h["polydata"], 4.5)
            flush(publisher, server, client)
            assert_points(scene, client, h["mapper"].GetInput())
        finally:
            publisher.cleanup()


@pytest.mark.parametrize("fast", [False, True])
def test_returning_pipeline_executes_edits_while_absent(fast):
    scene = make_quad_scene()
    h = scene.handles
    transform = vtkTransform()
    pipeline = vtkTransformPolyDataFilter()
    pipeline.SetTransform(transform)
    pipeline.SetInputData(h["polydata"])
    h["mapper"].SetInputConnection(pipeline.GetOutputPort())
    with hot_array_fast_path(fast):
        publisher, server = make_publisher(scene)
        client = MirrorClient()
        client.resync(publisher)
        try:
            h["renderer"].RemoveActor(h["actor"])
            flush(publisher, server, client)
            transform.Translate(5, 6, 7)
            move(h["polydata"], 3)
            flush(publisher, server, client)
            h["renderer"].AddActor(h["actor"])
            flush(publisher, server, client)
            assert_points(scene, client, pipeline.GetOutput())
            assert pipeline.GetOutput().GetPoint(1) == (8, 6, 7)
        finally:
            publisher.cleanup()


def test_shared_geometry_survives_one_actor_leaving_and_returning():
    scene = make_quad_scene()
    h = scene.handles
    other, _ = add_actor(h["renderer"], h["polydata"])
    publisher, server = make_publisher(scene)
    client = MirrorClient()
    client.resync(publisher)
    try:
        h["renderer"].RemoveActor(h["actor"])
        flush(publisher, server, client)
        move(h["polydata"], 2)
        flush(publisher, server, client)
        assert_points(scene, client)
        h["renderer"].AddActor(h["actor"])
        flush(publisher, server, client)
        assert_points(scene, client)
        h["renderer"].RemoveActor(other)
        flush(publisher, server, client)
        move(h["polydata"], 3)
        flush(publisher, server, client)
        assert_points(scene, client)
    finally:
        publisher.cleanup()


@pytest.mark.parametrize("flush_removed", [False, True])
@pytest.mark.parametrize("changed", [False, True])
def test_reentry_restores_blobs_and_retires_old_content(flush_removed, changed):
    from test_publisher import blob_size
    from trame_vtklocal.store import ref_manager_hashes

    scene = make_quad_scene()
    h = scene.handles
    publisher, server = make_publisher(scene)
    client = MirrorClient()
    client.resync(publisher)
    manager = scene.api.vtk_object_manager
    try:
        data_id = str(manager.GetId(h["polydata"]))
        old_ref = client.nodes[data_id]["arrays"]["points"]["ref"]
        (old_hash,) = ref_manager_hashes([old_ref])
        h["renderer"].RemoveActor(h["actor"])
        flush(publisher, server, client)
        if flush_removed:
            scene.api.flush_stale_blobs()
            assert not blob_size(manager, old_hash)
        if changed:
            move(h["polydata"], 3)
        h["renderer"].AddActor(h["actor"])
        flush(publisher, server, client)
        assert_points(scene, client)
        scene.api.flush_stale_blobs()
        assert bool(blob_size(manager, old_hash)) is not changed
        h["renderer"].RemoveActor(h["actor"])
        flush(publisher, server, client)
        scene.api.flush_stale_blobs()
        assert not client.blobs
        assert not blob_size(manager, old_hash)
    finally:
        publisher.cleanup()


def test_reentry_refresh_failure_can_retry_descendants(monkeypatch):
    from test_publisher import _CountingObjectManager

    scene = make_quad_scene()
    h = scene.handles
    wrapper = _CountingObjectManager(scene.api.vtk_object_manager)
    scene.api.vtk_object_manager = wrapper
    publisher, server = make_publisher(scene)
    client = MirrorClient()
    client.resync(publisher)
    try:
        h["renderer"].RemoveActor(h["actor"])
        flush(publisher, server, client)
        move(h["polydata"], 4)
        data_id = wrapper.GetId(h["polydata"])
        original = wrapper.UpdateStateFromObject

        def fail_data(object_id):
            if object_id == data_id:
                raise RuntimeError("injected entering-data failure")
            return original(object_id)

        monkeypatch.setattr(wrapper, "UpdateStateFromObject", fail_data)
        h["renderer"].AddActor(h["actor"])
        with pytest.raises(RuntimeError, match="entering-data"):
            publisher.sync()
        monkeypatch.setattr(wrapper, "UpdateStateFromObject", original)
        flush(publisher, server, client)
        assert_points(scene, client)
    finally:
        publisher.cleanup()


def test_shared_geometry_reentry_across_render_windows():
    from vtkmodules.vtkRenderingCore import vtkRenderer, vtkRenderWindow
    from push_oracle.scenes import OracleScene

    scene = make_quad_scene()
    h = scene.handles
    other_window = vtkRenderWindow()
    other_window.SetOffScreenRendering(1)
    other_renderer = vtkRenderer()
    other_window.AddRenderer(other_renderer)
    add_actor(other_renderer, h["polydata"])
    publisher, server = make_publisher(scene)
    other_window.Render()
    other_id = scene.api.vtk_object_manager.RegisterObject(other_window)
    scene.api.vtk_object_manager.UpdateStatesFromObjects([other_id])
    other_scene = OracleScene(
        "other",
        scene.api,
        other_window,
        other_id,
    )
    other_publisher, other_server = make_publisher(other_scene)
    client, other_client = MirrorClient(), MirrorClient()
    client.resync(publisher)
    other_client.resync(other_publisher)
    try:
        h["renderer"].RemoveActor(h["actor"])
        flush(publisher, server, client)
        move(h["polydata"], 5)
        flush(other_publisher, other_server, other_client)
        assert_points(scene, other_client)
        h["renderer"].AddActor(h["actor"])
        flush(publisher, server, client)
        assert_points(scene, client)
        scene.api.flush_stale_blobs()
        assert_points(scene, other_client)
        move(h["polydata"], 6)
        flush(publisher, server, client)
        flush(other_publisher, other_server, other_client)
        assert_points(scene, client)
        assert_points(scene, other_client)
    finally:
        publisher.cleanup()
        other_publisher.cleanup()


def test_failed_actor_replacement_releases_detached_actor(monkeypatch):
    import gc
    from vtkmodules.vtkCommonCore import vtkWeakReference
    from push_oracle.scenes import make_line_polydata
    from test_publisher import _CountingObjectManager

    scene = make_quad_scene()
    h = scene.handles
    manager = _CountingObjectManager(scene.api.vtk_object_manager)
    scene.api.vtk_object_manager = manager
    publisher, server = make_publisher(scene)
    client = MirrorClient()
    client.resync(publisher)
    original = manager.UpdateStateFromObject
    try:
        old = vtkWeakReference()
        old.Set(h["actor"])
        h["renderer"].RemoveActor(h.pop("actor"))
        data, _ = make_line_polydata()
        actor, _ = add_actor(h["renderer"], data)

        def fail_actor(object_id):
            if manager.GetObjectAtId(object_id) is actor:
                raise RuntimeError("injected entering-actor failure")
            return original(object_id)

        monkeypatch.setattr(manager, "UpdateStateFromObject", fail_actor)
        with pytest.raises(RuntimeError, match="entering-actor"):
            publisher.sync()
        monkeypatch.setattr(manager, "UpdateStateFromObject", original)
        flush(publisher, server, client)
        gc.collect()
        assert old.Get() is None
        assert_points(scene, client, data)
    finally:
        publisher.cleanup()
