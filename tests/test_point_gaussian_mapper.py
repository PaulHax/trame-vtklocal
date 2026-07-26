"""Contract tests for the dense-point vtkPointGaussianMapper translation.

The app renders dense clouds through a Python ``vtkPointGaussianMapper`` (native
class ``vtkOpenGLPointGaussianMapper``) feeding a ``vtkPolyData`` with points and
Uint8 RGB but no vertex cells. These pin the wire contract: the client mapper
type, a client-supported property set (no PointGaussian-only fields), a
topology-free array set (points + scalars, no verts/cell blob), Float32
positions, full-range Uint8 RGB, and the actor UserMatrix.
"""

from __future__ import annotations

import numpy as np
from vtkmodules.util.numpy_support import numpy_to_vtk
from vtkmodules.vtkCommonCore import vtkPoints
from vtkmodules.vtkCommonDataModel import vtkPolyData
from vtkmodules.vtkCommonMath import vtkMatrix4x4
from vtkmodules.vtkRenderingCore import (
    vtkActor,
    vtkPointGaussianMapper,
    vtkRenderer,
    vtkRenderWindow,
)

# The OpenGL2 backend registers the object-factory overrides the serialization
# manager dereferences; VTK 9.6 no longer pulls it in behind vtkRenderingCore,
# so without this Render() segfaults when this module runs on its own.
from vtkmodules.vtkRenderingOpenGL2 import vtkOpenGLRenderer  # noqa: F401

from trame_vtklocal.module import distance_to_camera as dtc
from trame_vtklocal.module.node_translator import translate_scene
from trame_vtklocal.module.protocol import ObjectManagerAPI
from trame_vtklocal.widgets.blob_payloads import resolve_ref_payload

POSITIONS = np.array(
    [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]], dtype=np.float32
)
# Full-range channels straddling the signed-byte midpoint (0/127/128/255).
COLORS = np.array(
    [[0, 127, 128], [255, 0, 127], [128, 255, 0], [127, 128, 255]],
    dtype=np.uint8,
)

# vtkPointGaussianMapper-only fields that must never reach the client mapper.
POINT_GAUSSIAN_ONLY = {
    "emissive",
    "boundScale",
    "lowpassMatrix",
    "opacityArray",
    "anisotropic",
    "scaleArray",
    "opacityArrayComponent",
    "opacityTableSize",
    "scaleArrayComponent",
    "scaleTableSize",
}


def _point_cloud_scene(user_matrix=None, native_array_names=False):
    api = ObjectManagerAPI()
    om = api.vtk_object_manager
    render_window = vtkRenderWindow()
    render_window.SetOffScreenRendering(1)
    renderer = vtkRenderer()
    render_window.AddRenderer(renderer)

    points = vtkPoints()
    points.SetData(numpy_to_vtk(POSITIONS, deep=True))
    poly = vtkPolyData()
    poly.SetPoints(points)  # no verts / lines / polys
    rgb = numpy_to_vtk(COLORS, deep=True)
    rgb.SetName("RGB")
    poly.GetPointData().SetScalars(rgb)

    mapper = vtkPointGaussianMapper()
    mapper.SetInputData(poly)
    mapper.SetScalarVisibility(True)
    mapper.SetColorModeToDirectScalars()
    mapper.SetStatic(True)
    if native_array_names:
        mapper.SetScaleArray("radius")
        mapper.SetOpacityArray("opacity")

    actor = vtkActor()
    actor.SetMapper(mapper)
    if user_matrix is not None:
        matrix = vtkMatrix4x4()
        for row in range(4):
            for col in range(4):
                matrix.SetElement(row, col, float(user_matrix[row][col]))
        actor.SetUserMatrix(matrix)
    renderer.AddActor(actor)
    renderer.ResetCamera()

    rw_id = om.RegisterObject(render_window)
    with dtc.bypass_distance_to_camera_for_serialization(render_window):
        render_window.Render()
        om.UpdateStatesFromObjects()

    nodes = translate_scene(om, rw_id)
    handles = {"object_manager": om, "mapper": mapper, "actor": actor}
    return nodes, handles


def _only(nodes, node_type):
    matches = [node for node in nodes.values() if node["type"] == node_type]
    assert len(matches) == 1, f"expected exactly one {node_type}, got {len(matches)}"
    return matches[0]


def test_native_mapper_maps_to_the_client_point_gaussian_type():
    nodes, _ = _point_cloud_scene()
    mapper = _only(nodes, "vtkPointGaussianMapper")

    props = mapper.get("props", {})
    # Client-supported surface is present...
    assert props["scalarVisibility"] == 1
    assert props["scaleFactor"] == 1.0
    assert props["static"] == 1
    assert props["colorMode"] == 2  # direct scalars
    # ...and no PointGaussian-only field the client mapper cannot set leaks.
    assert POINT_GAUSSIAN_ONLY.isdisjoint(props)

    # No native OpenGL class name survives anywhere in the scene.
    assert all(node["type"] != "vtkOpenGLPointGaussianMapper" for node in nodes.values())


def test_native_scale_and_opacity_array_names_do_not_cross_the_wire():
    nodes, _ = _point_cloud_scene(native_array_names=True)
    props = _only(nodes, "vtkPointGaussianMapper").get("props", {})

    assert "scaleArray" not in props
    assert "opacityArray" not in props


def test_polydata_is_topology_free():
    nodes, _ = _point_cloud_scene()
    poly = _only(nodes, "vtkPolyData")
    arrays = poly.get("arrays", {})

    assert set(arrays) == {"points", "field:pointData:RGB"}
    # No cell topology of any kind is fabricated or published.
    for reserved in ("verts", "lines", "polys", "strips"):
        assert reserved not in arrays
    for entry in arrays.values():
        assert entry.get("vtkClass") != "vtkCellArray"
        assert not entry["ref"].startswith("c2:")  # packed cell-array namespace


def test_positions_are_float32_and_rgb_is_full_range_uint8():
    nodes, handles = _point_cloud_scene()
    poly = _only(nodes, "vtkPolyData")
    arrays = poly["arrays"]

    points = arrays["points"]
    assert points["dataType"] == "Float32Array"
    assert points["numberOfComponents"] == 3
    assert points["size"] == POSITIONS.size

    rgb = arrays["field:pointData:RGB"]
    assert rgb["dataType"] == "Uint8Array"
    assert rgb["numberOfComponents"] == 3
    assert rgb["registration"] == "setScalars"

    # The RGB payload round-trips every channel, including values above 127.
    payload = resolve_ref_payload(
        handles["object_manager"], rgb["ref"], lambda *_: None
    )
    decoded = np.frombuffer(payload, dtype=np.uint8).reshape(COLORS.shape)
    assert decoded.tolist() == COLORS.tolist()


def test_actor_carries_the_user_matrix():
    user_matrix = [
        [2.0, 0.0, 0.0, 10.0],
        [0.0, 2.0, 0.0, 20.0],
        [0.0, 0.0, 2.0, 30.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
    nodes, _ = _point_cloud_scene(user_matrix=user_matrix)
    actor = _only(nodes, "vtkActor")

    # actor_user_matrix_property emits column-major (col-outer, row-inner).
    expected = [user_matrix[row][col] for col in range(4) for row in range(4)]
    assert actor["props"]["userMatrix"] == expected
