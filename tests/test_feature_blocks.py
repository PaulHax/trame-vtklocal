"""Feature blocks stored in a VTK object's own information."""

import subprocess
import sys
import textwrap

from vtkmodules.vtkRenderingCore import vtkActor, vtkPolyDataMapper

from trame_vtklocal.module.feature_blocks import get_block, set_block


def test_blocks_on_one_object_are_independent():
    mapper = vtkPolyDataMapper()
    assert set_block(mapper, "a", {"value": (1, 2)})
    assert set_block(mapper, "b", {"value": "x"})
    assert get_block(mapper, "a") == {"value": [1, 2]}

    mtime = mapper.GetMTime()
    assert not set_block(mapper, "a", {"value": [1, 2]})
    assert mapper.GetMTime() == mtime

    assert set_block(mapper, "a", None)
    assert get_block(mapper, "a") is None
    assert get_block(mapper, "b") == {"value": "x"}
    assert not set_block(mapper, "a", None)


def test_removing_the_last_block_leaves_the_prop_without_blocks():
    actor = vtkActor()
    assert not set_block(actor, "a", None)
    assert actor.GetPropertyKeys() is None

    set_block(actor, "a", {"value": 1})
    set_block(actor, "a", None)
    assert actor.GetPropertyKeys().GetNumberOfKeys() == 0


def test_a_process_that_sets_blocks_exits_cleanly():
    script = textwrap.dedent(
        """
        from vtkmodules.vtkRenderingCore import vtkActor, vtkGlyph3DMapper
        from trame_vtklocal.module.interaction import make_pickable
        from trame_vtklocal.module.screen_size_glyphs import (
            mark_screen_size_glyphs,
        )
        from trame_vtklocal.streamed_scene import (
            PointCloudSource,
            StreamedSceneActor,
        )

        mapper = vtkGlyph3DMapper()
        make_pickable(mapper, grab_px=8)
        mark_screen_size_glyphs(mapper, 12)
        actor = vtkActor()
        actor.SetMapper(mapper)
        streamed = StreamedSceneActor(
            PointCloudSource(
                source_asset_id="asset",
                revision="r1",
                endpoint="/pointcloud/asset/r1",
                point_count=10,
                presentation={
                    "mode": "auto",
                    "userScale": 1.0,
                    "minDiameterCssPx": 1.5,
                    "maxDiameterCssPx": 5.0,
                },
            )
        )
        """
    )
    completed = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, check=False
    )
    assert completed.returncode == 0, completed.stderr
