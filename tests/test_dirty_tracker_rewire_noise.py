"""The dtc serialization bypass must be invisible to dirty tracking.

The bypass rewires every dtc-fed mapper's input (``SetInputData`` on enter,
``SetInputConnection`` on exit) — semantic no-ops that fire ``ModifiedEvent``
and advance the mapper's MTime. Layers with no handle on a tracker run the
bypass too (the protocol blob GC does, after every publish whose refs leave),
so the noise must be dropped at the source: neither the events nor the MTime
delta may re-dirty a mapper. Regression for the landmark-drag publish
amplification (one wasted empty publish per window per move).
"""

from trame_vtklocal.module.distance_to_camera import (
    bypass_distance_to_camera_for_serialization,
)
from trame_vtklocal.widgets.dirty_tracker import DirtyTracker

from vtkmodules.vtkCommonCore import vtkPoints
from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData
from vtkmodules.vtkRenderingCore import (
    vtkActor,
    vtkDistanceToCamera,
    vtkGlyph3DMapper,
    vtkRenderer,
    vtkRenderWindow,
)
from vtkmodules.vtkRenderingOpenGL2 import vtkOpenGLRenderer  # noqa: F401


def _make_cross_polydata():
    points = vtkPoints()
    lines = vtkCellArray()
    for dx, dy, dz in ((1, 0, 0), (0, 1, 0), (0, 0, 1)):
        a = points.InsertNextPoint(-dx, -dy, -dz)
        b = points.InsertNextPoint(dx, dy, dz)
        lines.InsertNextCell(2)
        lines.InsertCellPoint(a)
        lines.InsertCellPoint(b)

    polydata = vtkPolyData()
    polydata.SetPoints(points)
    polydata.SetLines(lines)
    return polydata


def _make_tracked_dtc_scene():
    from vtkmodules.vtkSerializationManager import vtkObjectManager

    rw = vtkRenderWindow()
    rw.SetOffScreenRendering(1)
    renderer = vtkRenderer()
    rw.AddRenderer(renderer)

    centers_points = vtkPoints()
    centers_points.InsertNextPoint(-0.5, 0.0, 0.0)
    centers = vtkPolyData()
    centers.SetPoints(centers_points)

    distance_to_camera = vtkDistanceToCamera()
    distance_to_camera.SetInputData(centers)
    distance_to_camera.SetScreenSize(36)

    mapper = vtkGlyph3DMapper()
    mapper.SetInputConnection(distance_to_camera.GetOutputPort())
    mapper.SetSourceData(_make_cross_polydata())
    mapper.SetScaleArray("DistanceToCamera")
    mapper.SetScaleModeToScaleByMagnitude()
    mapper.OrientOff()
    mapper.SetScalarVisibility(False)

    actor = vtkActor()
    actor.SetMapper(mapper)
    renderer.AddActor(actor)
    renderer.ResetCamera()

    om = vtkObjectManager()
    om.Initialize()
    rw_id = om.RegisterObject(rw)
    with bypass_distance_to_camera_for_serialization(rw):
        rw.Render()
        om.UpdateStatesFromObjects()

    tracker = DirtyTracker(om, rw_id)
    tracker.sync_observers()
    tracker.consume()  # drop any marks from scene construction
    return rw, om, mapper, tracker


def test_unsuppressed_bypass_marks_nothing_dirty():
    rw, _om, _mapper, tracker = _make_tracked_dtc_scene()

    # The protocol blob GC shape: a bare bypass with no tracker suppression.
    with bypass_distance_to_camera_for_serialization(rw):
        pass

    assert not tracker.has_pending()


def test_sweep_ignores_bypass_mtime_bumps():
    rw, _om, _mapper, tracker = _make_tracked_dtc_scene()
    tracker.sweep()
    tracker.consume()  # settle the mtime snapshot

    with bypass_distance_to_camera_for_serialization(rw):
        pass

    tracker.sweep()
    assert not tracker.has_pending()


def test_real_mapper_change_after_bypass_still_marks_dirty():
    rw, om, mapper, tracker = _make_tracked_dtc_scene()

    with bypass_distance_to_camera_for_serialization(rw):
        pass
    mapper.Modified()

    assert tracker.has_pending()
    batch = tracker.consume()
    assert str(om.GetId(mapper)) in batch.candidates


def test_sweep_still_heals_real_changes_after_bypass():
    rw, om, mapper, tracker = _make_tracked_dtc_scene()
    tracker.sweep()
    tracker.consume()

    with bypass_distance_to_camera_for_serialization(rw):
        pass
    # A change the observer missed (fired under suppression), later than the
    # bypass bump: sweep must still fold it in.
    with tracker.suppress():
        mapper.Modified()

    tracker.sweep()
    assert tracker.has_pending()
    batch = tracker.consume()
    assert str(om.GetId(mapper)) in batch.candidates
