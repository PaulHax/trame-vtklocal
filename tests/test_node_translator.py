"""Flat-node translator tests.

Every scene runs the same caller choreography as ``vtkjs_base``: register the
render window, ``Render()`` under the dtc bypass, ``UpdateStatesFromObjects()``.
Mutation steps refresh states *without* re-rendering so camera/light state
stays inert and node diffs isolate exactly the mutated objects.
"""

from __future__ import annotations

import numpy as np
import pytest

from push_oracle.scenes import (
    OracleScene,
    _ObjectManagerApiNoAttachments,
    add_actor,
    make_basic_scene,
    make_line_polydata,
    make_pipeline_cone_scene,
    make_polyline_scene,
    make_quad_polydata,
    make_quad_scene,
    make_scalars_scene,
    make_map_drape_scene,
    make_two_stage_pipeline_scene,
)
from trame_vtklocal.module import distance_to_camera as dtc
from trame_vtklocal.module import interaction as pick
from trame_vtklocal.module import projected_texture as ptx
from trame_vtklocal.module.node_translator import translate_object, translate_scene
from trame_vtklocal.module.array_datatypes import js_datatype
from trame_vtklocal.module.vtkjs_translator import CAMERA_PROPERTIES
from trame_vtklocal.store import SceneStore, ref_manager_hashes
from trame_vtklocal.widgets.blob_payloads import (
    pack_cell_array_payload,
    resolve_ref_payload,
)


# ----------------------------------------------------------------------
# Scene builders beyond the shared oracle set
# ----------------------------------------------------------------------


def _wrap_scene(name, api, render_window, handles):
    render_window_id = api.vtk_object_manager.RegisterObject(render_window)
    with dtc.bypass_distance_to_camera_for_serialization(render_window):
        render_window.Render()
        api.vtk_object_manager.UpdateStatesFromObjects()
    return OracleScene(
        name=name,
        api=api,
        render_window=render_window,
        render_window_id=render_window_id,
        handles=handles,
    )


def make_glyph_scene(name="glyph_dtc"):
    """Glyph mapper fed by a vtkDistanceToCamera filter (screen-size glyphs)."""
    from vtkmodules.vtkCommonCore import vtkFloatArray, vtkPoints
    from vtkmodules.vtkCommonDataModel import vtkPolyData
    from vtkmodules.vtkFiltersSources import vtkSphereSource
    from vtkmodules.vtkRenderingCore import (
        vtkActor,
        vtkDistanceToCamera,
        vtkGlyph3DMapper,
        vtkRenderer,
        vtkRenderWindow,
    )

    api = _ObjectManagerApiNoAttachments()
    render_window = vtkRenderWindow()
    render_window.SetOffScreenRendering(1)
    renderer = vtkRenderer()
    render_window.AddRenderer(renderer)

    points = vtkPoints()
    points.InsertNextPoint(0.0, 0.0, 0.0)
    points.InsertNextPoint(1.0, 0.0, 0.0)
    centers = vtkPolyData()
    centers.SetPoints(points)
    rotation = vtkFloatArray()
    rotation.SetName("GlyphRotation")
    rotation.SetNumberOfComponents(3)
    rotation.InsertNextTuple3(0.0, 0.0, 0.25)
    rotation.InsertNextTuple3(0.0, 0.0, -0.5)
    centers.GetPointData().AddArray(rotation)

    distance_filter = vtkDistanceToCamera()
    distance_filter.SetInputData(centers)
    distance_filter.SetScreenSize(36)

    source = vtkSphereSource()
    source.Update()

    mapper = vtkGlyph3DMapper()
    mapper.SetInputConnection(distance_filter.GetOutputPort())
    mapper.SetSourceData(source.GetOutput())
    mapper.SetScaleArray("DistanceToCamera")
    mapper.SetScaleModeToScaleByMagnitude()
    mapper.SetOrientationArray("GlyphRotation")
    mapper.SetOrientationModeToRotation()
    mapper.OrientOn()
    mapper.SetScalarVisibility(False)

    actor = vtkActor()
    actor.SetMapper(mapper)
    renderer.AddActor(actor)
    renderer.ResetCamera()

    handles = {
        "renderer": renderer,
        "actor": actor,
        "mapper": mapper,
        "centers": centers,
        "centers_points": points,
        "filter": distance_filter,
        "source_output": source.GetOutput(),
    }
    return _wrap_scene(name, api, render_window, handles)


def make_textured_scene(name="textured"):
    """Quad actor with a vtkTexture (its image pipeline never becomes a node)."""
    from vtkmodules.vtkImagingSources import vtkImageEllipsoidSource
    from vtkmodules.vtkRenderingCore import vtkRenderer, vtkRenderWindow, vtkTexture

    api = _ObjectManagerApiNoAttachments()
    render_window = vtkRenderWindow()
    render_window.SetOffScreenRendering(1)
    renderer = vtkRenderer()
    render_window.AddRenderer(renderer)

    image = vtkImageEllipsoidSource()
    image.SetWholeExtent(0, 7, 0, 7, 0, 0)
    texture = vtkTexture()
    texture.SetInputConnection(image.GetOutputPort())

    polydata, points, tcoords, homography = make_quad_polydata()
    actor, mapper = add_actor(renderer, polydata)
    actor.SetTexture(texture)

    handles = {
        "renderer": renderer,
        "actor": actor,
        "mapper": mapper,
        "polydata": polydata,
        "texture": texture,
        "image_source": image,
    }
    return _wrap_scene(name, api, render_window, handles)


def make_verts_scene(name="verts"):
    """Polydata whose only cells are two single-point vertices."""
    from vtkmodules.vtkCommonCore import vtkPoints
    from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData
    from vtkmodules.vtkRenderingCore import vtkRenderer, vtkRenderWindow

    api = _ObjectManagerApiNoAttachments()
    render_window = vtkRenderWindow()
    render_window.SetOffScreenRendering(1)
    renderer = vtkRenderer()
    render_window.AddRenderer(renderer)

    points = vtkPoints()
    points.InsertNextPoint(0.0, 0.0, 0.0)
    points.InsertNextPoint(1.0, 1.0, 0.0)
    verts = vtkCellArray()
    for point_id in range(2):
        verts.InsertNextCell(1)
        verts.InsertCellPoint(point_id)

    polydata = vtkPolyData()
    polydata.SetPoints(points)
    polydata.SetVerts(verts)
    actor, mapper = add_actor(renderer, polydata)

    handles = {
        "renderer": renderer,
        "actor": actor,
        "mapper": mapper,
        "polydata": polydata,
        "points": points,
    }
    return _wrap_scene(name, api, render_window, handles)


def make_typed_field_scene(np_array, array_name="values", name="typed_field"):
    """Polydata carrying one named numeric point-data array.

    Exercises array-datatype translation end to end: ``numpy_to_vtk`` yields the
    concrete ``vtkType*Array`` the app's loaders produce, and the emitted field
    entry's ``dataType`` is exactly what the client uses to reinterpret the raw
    bytes — a wrong label silently corrupts values (e.g. uint8 as int8).
    """
    from vtkmodules.util.numpy_support import numpy_to_vtk
    from vtkmodules.vtkCommonCore import vtkPoints
    from vtkmodules.vtkCommonDataModel import vtkPolyData
    from vtkmodules.vtkRenderingCore import vtkRenderer, vtkRenderWindow

    vtk_array = None
    if hasattr(np_array, "GetDataType"):
        vtk_array = np_array
        values = None
        n = vtk_array.GetNumberOfTuples()
    else:
        values = np.ascontiguousarray(np_array)
        n = int(values.shape[0])

    api = _ObjectManagerApiNoAttachments()
    render_window = vtkRenderWindow()
    render_window.SetOffScreenRendering(1)
    renderer = vtkRenderer()
    render_window.AddRenderer(renderer)

    points = vtkPoints()
    for index in range(n):
        points.InsertNextPoint(float(index), 0.0, 0.0)
    polydata = vtkPolyData()
    polydata.SetPoints(points)

    if vtk_array is None:
        vtk_array = numpy_to_vtk(values, deep=True)
    vtk_array.SetName(array_name)
    polydata.GetPointData().AddArray(vtk_array)

    actor, mapper = add_actor(renderer, polydata)
    renderer.ResetCamera()

    handles = {
        "renderer": renderer,
        "actor": actor,
        "mapper": mapper,
        "polydata": polydata,
        "points": points,
        "array_name": array_name,
        "values": values,
    }
    return _wrap_scene(name, api, render_window, handles)


SCENE_FACTORIES = [
    make_basic_scene,
    make_quad_scene,
    make_map_drape_scene,
    make_scalars_scene,
    make_polyline_scene,
    make_pipeline_cone_scene,
    make_two_stage_pipeline_scene,
    make_glyph_scene,
    make_textured_scene,
    make_verts_scene,
]


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------


def refresh(scene):
    """Caller choreography for a re-translate after mutations (no Render)."""
    with dtc.bypass_distance_to_camera_for_serialization(scene.render_window):
        scene.api.vtk_object_manager.UpdateStatesFromObjects()


def translate(scene):
    return translate_scene(scene.api.vtk_object_manager, scene.render_window_id)


def oid(scene, vtk_object):
    return str(scene.api.vtk_object_manager.GetId(vtk_object))


def emitted_array_refs(nodes):
    return {
        entry["ref"]
        for node in nodes.values()
        for entry in node.get("arrays", {}).values()
    }


def changed_ids(before, after):
    return {
        node_id
        for node_id in set(before) | set(after)
        if before.get(node_id) != after.get(node_id)
    }


def blob_size(object_manager, hash_value):
    """Registered blob length (0 when the hash is gone).

    VTK >= 9.6 answers an unknown hash with an EMPTY array rather than None,
    so length — never ``is not None`` — is the liveness test.
    """
    blob = object_manager.GetBlob(hash_value)
    return 0 if blob is None else memoryview(blob).nbytes


def commit_scene(scene, nodes):
    store = SceneStore(str(scene.render_window_id))
    result = store.transact().upsert_nodes(nodes).commit()
    return store, result


# ----------------------------------------------------------------------
# Core invariants over every scene
# ----------------------------------------------------------------------


@pytest.mark.parametrize("scene_factory", SCENE_FACTORIES)
def test_scene_commits_to_store_without_dangling_refs(scene_factory):
    scene = scene_factory()
    nodes = translate(scene)

    store, result = commit_scene(scene, nodes)

    assert result["blob_refs_entering"] == emitted_array_refs(nodes)
    # Canonicalization kept every node intact and reachable from the root.
    assert store.snapshot()["nodes"] == nodes

    # Every emitted ref is resolvable by the publisher.
    object_manager = scene.api.vtk_object_manager
    for ref in emitted_array_refs(nodes):
        if ref.startswith("c2:"):
            assert pack_cell_array_payload(object_manager, ref)
        else:
            assert ref.startswith("c:")
            assert blob_size(object_manager, ref[len("c:") :])


@pytest.mark.parametrize("scene_factory", SCENE_FACTORIES)
def test_translate_object_matches_translate_scene(scene_factory):
    scene = scene_factory()
    nodes = translate(scene)

    for node_id, node in nodes.items():
        assert translate_object(scene.api.vtk_object_manager, node_id) == node


@pytest.mark.parametrize("scene_factory", SCENE_FACTORIES)
def test_translation_is_deterministic(scene_factory):
    scene = scene_factory()

    assert translate(scene) == translate(scene)


# ----------------------------------------------------------------------
# Mutations map to exactly the expected node diffs
# ----------------------------------------------------------------------


def test_visibility_change_touches_only_the_actor_node():
    scene = make_basic_scene()
    before = translate(scene)

    scene.handles["actor"].SetVisibility(0)
    refresh(scene)
    after = translate(scene)

    actor_id = oid(scene, scene.handles["actor"])
    assert changed_ids(before, after) == {actor_id}
    assert before[actor_id]["props"]["visibility"] == 1
    assert after[actor_id]["props"]["visibility"] == 0


def test_property_color_change_touches_only_the_property_node():
    scene = make_basic_scene()
    vtk_property = scene.handles["actor"].GetProperty()
    before = translate(scene)

    vtk_property.SetColor(0.9, 0.1, 0.2)
    refresh(scene)
    after = translate(scene)

    property_id = oid(scene, vtk_property)
    assert changed_ids(before, after) == {property_id}
    assert after[property_id]["props"]["color"] == [0.9, 0.1, 0.2]


def test_renderer_composition_properties_round_trip():
    scene = make_basic_scene()
    renderer = scene.handles["renderer"]
    before = translate(scene)

    renderer.SetLayer(1)
    renderer.PreserveColorBufferOn()
    renderer.PreserveDepthBufferOff()
    refresh(scene)
    after = translate(scene)

    renderer_id = oid(scene, renderer)
    assert changed_ids(before, after) == {renderer_id}
    assert after[renderer_id]["props"]["layer"] == 1
    assert after[renderer_id]["props"]["preserveColorBuffer"] == 1
    assert after[renderer_id]["props"]["preserveDepthBuffer"] == 0

    renderer.PreserveDepthBufferOn()
    refresh(scene)
    preserved = translate(scene)
    assert preserved[renderer_id]["props"]["preserveDepthBuffer"] == 1


def test_points_mutation_changes_only_the_dataset_array_ref():
    scene = make_basic_scene()
    before = translate(scene)

    scene.handles["points"].SetPoint(0, 0.25, 0.5, 0.0)
    scene.handles["points"].Modified()
    refresh(scene)
    after = translate(scene)

    polydata_id = oid(scene, scene.handles["polydata"])
    assert changed_ids(before, after) == {polydata_id}
    before_points = before[polydata_id]["arrays"]["points"]
    after_points = after[polydata_id]["arrays"]["points"]
    assert before_points["ref"] != after_points["ref"]
    assert after_points["ref"].startswith("c:")
    assert {**before_points, "ref": None} == {**after_points, "ref": None}


def test_pickable_retag_changes_only_the_mapper_pickable_block():
    scene = make_basic_scene()
    mapper = scene.handles["mapper"]
    pick.make_pickable(mapper, tags={"kind": "landmark"}, ids=[7, 9], grab_px=8)
    refresh(scene)
    before = translate(scene)

    pick.make_pickable(
        mapper, tags={"kind": "landmark", "rev": 2}, ids=[7, 9], grab_px=8
    )
    refresh(scene)
    after = translate(scene)

    mapper_id = oid(scene, mapper)
    assert changed_ids(before, after) == {mapper_id}

    before_node = dict(before[mapper_id])
    after_node = dict(after[mapper_id])
    before_blocks = before_node.pop("blocks")
    after_blocks = after_node.pop("blocks")
    assert before_node == after_node
    assert set(before_blocks) == set(after_blocks) == {"pickable"}
    assert after_blocks["pickable"]["tags"] == {"kind": "landmark", "rev": 2}
    assert before_blocks["pickable"]["tags"] == {"kind": "landmark"}


def test_add_then_remove_actor_round_trips_through_the_store():
    scene = make_basic_scene()
    renderer = scene.handles["renderer"]
    renderer_id = oid(scene, renderer)
    before = translate(scene)
    store, _ = commit_scene(scene, before)

    polydata, _points = make_line_polydata()
    actor2, mapper2 = add_actor(renderer, polydata)
    refresh(scene)
    added = translate(scene)

    new_ids = set(added) - set(before)
    assert {oid(scene, actor2), oid(scene, mapper2)} <= new_ids
    assert changed_ids(before, added) == new_ids | {renderer_id}
    assert oid(scene, actor2) in added[renderer_id]["refs"]["viewProps"]
    store.transact().upsert_nodes(added).commit()
    assert store.snapshot()["nodes"] == added

    renderer.RemoveActor(actor2)
    refresh(scene)
    after = translate(scene)

    assert after == before
    result = store.transact().upsert_nodes(after).commit()
    removed = {op["id"] for op in result["ops"] if op["op"] == "remove"}
    assert removed == new_ids
    assert store.snapshot()["nodes"] == after


# ----------------------------------------------------------------------
# Feature blocks
# ----------------------------------------------------------------------


def test_distance_to_camera_glyph_mapper_bypasses_the_filter():
    scene = make_glyph_scene()
    nodes = translate(scene)

    mapper_id = oid(scene, scene.handles["mapper"])
    centers_id = oid(scene, scene.handles["centers"])
    source_id = oid(scene, scene.handles["source_output"])
    node = nodes[mapper_id]

    assert node["type"] == "vtkGlyph3DMapper"
    assert node["refs"]["inputs"][0] == centers_id
    assert node["refs"]["inputs"][1] == source_id
    assert node["props"]["scaleArray"] == "DistanceToCamera"
    assert node["props"]["orientationArray"] == "GlyphRotation"
    assert node["props"]["orientationMode"] == 1
    assert node["props"]["orient"] is True
    assert node["blocks"]["distanceToCamera"] == {
        "arrayName": "DistanceToCamera",
        "screenSize": 36.0,
        "inputDataObjectId": centers_id,
    }

    # The algorithm itself never becomes a node.
    assert all(n["type"] != "vtkDistanceToCamera" for n in nodes.values())
    filter_id = scene.api.vtk_object_manager.GetId(scene.handles["filter"])
    assert str(filter_id) not in nodes

    # The pre-filter dataset is a normal dataset node with its points array.
    assert nodes[centers_id]["type"] == "vtkPolyData"
    assert nodes[centers_id]["arrays"]["points"]["ref"].startswith("c:")


def test_projected_texture_mapper_translates_as_a_block():
    scene = make_quad_scene()
    mapper = scene.handles["mapper"]
    ptx.mark_projected_texture(mapper, "video-frame", mode="homography")
    ptx.set_projected_texture_matrix(
        mapper, homography=[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    )
    refresh(scene)
    nodes = translate(scene)

    node = nodes[oid(scene, mapper)]
    assert node["type"] == "vtkProjectedTextureMapper"
    assert node["blocks"]["projectedTexture"] == {
        "textureKey": "video-frame",
        "mode": "homography",
        "homography": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
    }
    assert "textureKey" not in node.get("props", {})


# ----------------------------------------------------------------------
# Camera authority
# ----------------------------------------------------------------------


@pytest.mark.parametrize("scene_factory", [make_basic_scene, make_map_drape_scene])
def test_client_camera_authority_excludes_cameras_and_the_active_camera_slot(
    scene_factory,
):
    scene = scene_factory()
    server_nodes = translate(scene)
    client_nodes = translate_scene(
        scene.api.vtk_object_manager,
        scene.render_window_id,
        camera_authority="client",
    )

    camera_ids = {
        node_id for node_id, node in server_nodes.items() if node["type"] == "vtkCamera"
    }
    renderer_ids = {
        node_id
        for node_id, node in server_nodes.items()
        if node["type"] == "vtkRenderer"
    }
    assert camera_ids

    # No camera node and no activeCamera slot anywhere.
    assert not camera_ids & set(client_nodes)
    assert all(node["type"] != "vtkCamera" for node in client_nodes.values())
    for renderer_id in renderer_ids:
        assert "activeCamera" not in client_nodes[renderer_id].get("refs", {})

    # Renderer nodes are otherwise identical; every other node is untouched.
    for renderer_id in renderer_ids:
        expected_refs = dict(server_nodes[renderer_id]["refs"])
        expected_refs.pop("activeCamera")
        assert client_nodes[renderer_id] == {
            **server_nodes[renderer_id],
            "refs": expected_refs,
        }
    unchanged_ids = set(server_nodes) - camera_ids - renderer_ids
    assert set(client_nodes) == unchanged_ids | renderer_ids
    for node_id in unchanged_ids:
        assert client_nodes[node_id] == server_nodes[node_id]

    # The emitted node set commits without dangling refs.
    store, _ = commit_scene(scene, client_nodes)
    assert store.snapshot()["nodes"] == client_nodes


def test_client_camera_authority_translate_object_skips_the_camera():
    scene = make_basic_scene()
    camera_id = oid(scene, scene.handles["renderer"].GetActiveCamera())
    object_manager = scene.api.vtk_object_manager

    assert translate_object(object_manager, camera_id) is not None
    assert (
        translate_object(object_manager, camera_id, camera_authority="client") is None
    )


def test_unknown_camera_authority_is_rejected():
    scene = make_basic_scene()
    with pytest.raises(ValueError, match="camera_authority"):
        translate_scene(
            scene.api.vtk_object_manager,
            scene.render_window_id,
            camera_authority="nobody",
        )


# ----------------------------------------------------------------------
# Refs shapes
# ----------------------------------------------------------------------


def test_camera_node_uses_the_property_whitelist():
    scene = make_basic_scene()
    nodes = translate(scene)

    camera = scene.handles["renderer"].GetActiveCamera()
    camera_id = oid(scene, camera)
    renderer_id = oid(scene, scene.handles["renderer"])

    assert nodes[renderer_id]["refs"]["activeCamera"] == camera_id
    camera_node = nodes[camera_id]
    assert camera_node["type"] == "vtkCamera"
    assert set(camera_node["props"]) <= CAMERA_PROPERTIES
    assert {"position", "focalPoint", "viewUp", "viewAngle"} <= set(
        camera_node["props"]
    )
    assert "refs" not in camera_node


def test_renderer_lights_dissolve_into_a_ref_list():
    scene = make_basic_scene()
    nodes = translate(scene)

    renderer = scene.handles["renderer"]
    renderer_id = oid(scene, renderer)
    lights = renderer.GetLights()
    light_ids = [
        oid(scene, lights.GetItemAsObject(index))
        for index in range(lights.GetNumberOfItems())
    ]

    assert nodes[renderer_id]["refs"]["lights"] == light_ids
    for light_id in light_ids:
        assert nodes[light_id]["type"] == "vtkLight"
        assert nodes[light_id]["props"]["lightType"] in (
            "HeadLight",
            "CameraLight",
            "SceneLight",
        )


def test_actor_texture_ref_and_no_texture_pipeline_nodes():
    scene = make_textured_scene()
    nodes = translate(scene)

    actor_id = oid(scene, scene.handles["actor"])
    texture_id = oid(scene, scene.handles["texture"])
    image_id = scene.api.vtk_object_manager.GetId(
        scene.handles["image_source"].GetOutput()
    )

    assert nodes[actor_id]["refs"]["textures"] == [texture_id]
    texture_node = nodes[texture_id]
    assert texture_node["type"] == "vtkTexture"
    assert "inputDataObjects" not in texture_node.get("props", {})
    lookup_table_id = texture_node["refs"]["lookupTable"]
    assert lookup_table_id in nodes
    # The texture's image pipeline stays out of the node graph.
    assert str(image_id) not in nodes


# ----------------------------------------------------------------------
# Arrays shapes
# ----------------------------------------------------------------------


def test_points_and_field_arrays_use_content_refs():
    scene = make_quad_scene()
    nodes = translate(scene)
    arrays = nodes[oid(scene, scene.handles["polydata"])]["arrays"]

    points = arrays["points"]
    assert points["ref"].startswith("c:")
    assert points["dataType"] == "Float32Array"
    assert points["size"] == 12
    assert points["numberOfComponents"] == 3
    assert points["registration"] == "setPoints"
    assert points["vtkClass"] == "vtkPoints"

    tcoords = arrays["field:pointData:TextureCoordinates"]
    assert tcoords["ref"].startswith("c:")
    assert tcoords["registration"] == "setTCoords"
    assert tcoords["location"] == "pointData"
    assert tcoords["name"] == "TextureCoordinates"
    assert tcoords["size"] == 8

    homography = arrays["field:fieldData:HomographyInverse"]
    assert homography["location"] == "fieldData"
    assert "registration" not in homography


def test_named_attribute_arrays_carry_registrations():
    scene = make_scalars_scene()
    nodes = translate(scene)
    arrays = nodes[oid(scene, scene.handles["polydata"])]["arrays"]

    assert arrays["field:pointData:PointScalars"]["registration"] == "setScalars"
    assert arrays["field:cellData:CellScalars"]["registration"] == "setScalars"


def test_field_array_blob_registration_caches_by_mtime():
    """Unchanged attribute arrays keep their ref without re-registration;
    a GC'd blob is re-registered on the next translate; a content change
    (new MTime) mints a new content ref."""
    scene = make_quad_scene()
    object_manager = scene.api.vtk_object_manager
    dataset_id = oid(scene, scene.handles["polydata"])
    key = "field:pointData:TextureCoordinates"

    first = translate(scene)[dataset_id]["arrays"][key]
    (hash_value,) = ref_manager_hashes([first["ref"]])
    live_bytes = blob_size(object_manager, hash_value)
    assert live_bytes

    # Unchanged array: same ref, blob live, registration still stamped.
    second = translate(scene)[dataset_id]["arrays"][key]
    assert second == first
    assert blob_size(object_manager, hash_value) == live_bytes

    # The blob GC retired the hash while the node was out of the scene: a
    # cache hit alone must not serve a ref whose payload is gone.
    object_manager.UnRegisterBlob(hash_value)
    assert not blob_size(object_manager, hash_value), (
        "UnRegisterBlob no longer drops the payload, so the re-registration "
        "this test covers is not being exercised"
    )
    third = translate(scene)[dataset_id]["arrays"][key]
    assert third["ref"] == first["ref"]
    assert blob_size(object_manager, hash_value) == live_bytes

    # Content change -> new MTime -> new content ref.
    tcoords = scene.handles["tcoords"]
    tcoords.SetComponent(0, 0, 0.25)
    tcoords.Modified()
    changed = translate(scene)[dataset_id]["arrays"][key]
    assert changed["ref"] != first["ref"]
    (changed_hash,) = ref_manager_hashes([changed["ref"]])
    assert blob_size(object_manager, changed_hash) == live_bytes


@pytest.mark.parametrize(
    ("scene_factory", "key", "expected_packed"),
    [
        (make_quad_scene, "polys", [4, 0, 1, 2, 3]),
        (make_polyline_scene, "lines", [3, 0, 1, 2]),
        (make_verts_scene, "verts", [1, 0, 1, 1]),
    ],
)
def test_cell_arrays_pack_to_the_vtkjs_layout(scene_factory, key, expected_packed):
    scene = scene_factory()
    nodes = translate(scene)
    arrays = nodes[oid(scene, scene.handles["polydata"])]["arrays"]

    entry = arrays[key]
    assert entry["ref"].startswith("c2:")
    assert entry["dataType"] == "Uint32Array"
    assert entry["numberOfComponents"] == 1
    assert entry["size"] == len(expected_packed)
    assert entry["registration"] == f"set{key.capitalize()}"
    assert entry["vtkClass"] == "vtkCellArray"

    # Only the cell arrays actually present are emitted.
    other_cell_keys = {"verts", "lines", "polys", "strips"} - {key}
    assert not other_cell_keys & set(arrays)

    packed = pack_cell_array_payload(scene.api.vtk_object_manager, entry["ref"])
    assert np.frombuffer(packed, dtype=np.uint32).tolist() == expected_packed


# ----------------------------------------------------------------------
# Array datatype translation (VTK GetDataType()/class -> JS typed array)
# ----------------------------------------------------------------------

# The client reinterprets the raw blob bytes through the advertised dataType,
# so the JS constructor must be exact for every VTK scalar type the loaders
# can emit. Keyed by JS constructor name for the payload-decode contract below.
NUMPY_BY_JS_DATATYPE = {
    "Int8Array": np.int8,
    "Uint8Array": np.uint8,
    "Int16Array": np.int16,
    "Uint16Array": np.uint16,
    "Int32Array": np.int32,
    "Uint32Array": np.uint32,
    "BigInt64Array": np.int64,
    "BigUint64Array": np.uint64,
    "Float32Array": np.float32,
    "Float64Array": np.float64,
}

NUMERIC_DATATYPE_CASES = [
    (np.int8, "Int8Array"),
    (np.uint8, "Uint8Array"),
    (np.int16, "Int16Array"),
    (np.uint16, "Uint16Array"),
    (np.int32, "Int32Array"),
    (np.uint32, "Uint32Array"),
    (np.int64, "BigInt64Array"),
    (np.uint64, "BigUint64Array"),
    (np.float32, "Float32Array"),
    (np.float64, "Float64Array"),
]


@pytest.mark.parametrize(("np_dtype", "expected_js"), NUMERIC_DATATYPE_CASES)
def test_field_array_datatype_matches_the_concrete_vtk_class(np_dtype, expected_js):
    values = np.arange(4, dtype=np_dtype)
    scene = make_typed_field_scene(values, array_name="values")
    arrays = translate(scene)[oid(scene, scene.handles["polydata"])]["arrays"]

    entry = arrays["field:pointData:values"]
    assert entry["dataType"] == expected_js
    assert entry["numberOfComponents"] == 1
    assert entry["size"] == 4

    # Decoding the payload through the advertised dtype recovers the input:
    # a mislabeled type (the VTK 9.x char/short id transposition) would not.
    payload = resolve_ref_payload(
        scene.api.vtk_object_manager, entry["ref"], lambda *_: None
    )
    assert (
        len(payload)
        == entry["size"] * np.dtype(NUMPY_BY_JS_DATATYPE[entry["dataType"]]).itemsize
    )
    decoded = np.frombuffer(payload, dtype=NUMPY_BY_JS_DATATYPE[entry["dataType"]])
    assert decoded.tolist() == values.tolist()


def test_uint8_rgb_survives_as_a_uint8_contract():
    """Full-range RGB advertises Uint8Array and round-trips every channel.

    ``vtkTypeUInt8Array`` (GetDataType()=3) mislabeled as ``Int8Array`` makes
    the client read 128 as -128 and 255 as -1, so the payload values straddle
    127 in both directions.
    """
    colors = np.array(
        [[0, 127, 128], [255, 0, 127], [128, 255, 0], [127, 128, 255]],
        dtype=np.uint8,
    )
    scene = make_typed_field_scene(colors, array_name="RGB")
    arrays = translate(scene)[oid(scene, scene.handles["polydata"])]["arrays"]

    entry = arrays["field:pointData:RGB"]
    assert entry["dataType"] == "Uint8Array"
    assert entry["numberOfComponents"] == 3
    assert entry["size"] == colors.size

    payload = resolve_ref_payload(
        scene.api.vtk_object_manager, entry["ref"], lambda *_: None
    )
    decoded = np.frombuffer(
        payload, dtype=NUMPY_BY_JS_DATATYPE[entry["dataType"]]
    ).reshape(colors.shape)
    assert decoded.tolist() == colors.tolist()
    assert {0, 127, 128, 255} <= set(decoded.ravel().tolist())


def test_bit_array_publishes_one_uint8_per_logical_value():
    """A real vtkBitArray must not leak VTK's packed backing bytes."""
    from vtkmodules.vtkCommonCore import vtkBitArray

    values = [1, 0, 1, 0, 1, 1, 0, 0, 1]
    bit_array = vtkBitArray()
    bit_array.SetName("Mask")
    bit_array.SetNumberOfComponents(3)
    bit_array.SetNumberOfTuples(3)
    for index, value in enumerate(values):
        bit_array.SetValue(index, value)

    scene = make_typed_field_scene(bit_array, array_name="Mask")
    arrays = translate(scene)[oid(scene, scene.handles["polydata"])]["arrays"]
    entry = arrays["field:pointData:Mask"]

    assert entry["dataType"] == "Uint8Array"
    assert entry["numberOfComponents"] == 3
    assert entry["size"] == 9
    payload = resolve_ref_payload(
        scene.api.vtk_object_manager, entry["ref"], lambda *_: None
    )
    assert len(payload) == entry["size"]
    assert np.frombuffer(payload, dtype=np.uint8).tolist() == values


def test_unknown_numeric_array_type_is_rejected():
    with pytest.raises(ValueError, match="unsupported VTK numeric array datatype 999"):
        js_datatype("vtkFutureNumericArray", 999)
