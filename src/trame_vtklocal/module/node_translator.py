"""Flat-node translator for the scene store (push sync v2).

Translates a ``vtkObjectManager`` scene into flat store nodes. Shared tables
own class maps/fixups. Callers own render-window ``Render()`` /
``UpdateStatesFromObjects()`` / dtc-bypass choreography (as the publisher
does); the translator only reads object-manager state plus live objects.

Client-authority cameras never become nodes or refs.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Set
from typing import TYPE_CHECKING, cast

from vtkmodules.vtkCommonCore import vtkCollection
from vtkmodules.vtkRenderingCore import vtkPointGaussianMapper

from trame_vtklocal.module import distance_to_camera as dtc
from trame_vtklocal.module import interaction as pick
from trame_vtklocal.module import point_cloud_presentation as point_presentation
from trame_vtklocal.module import projected_texture as ptx
from trame_vtklocal.module.point_gaussian import validate_simple_points
from trame_vtklocal.module.node_arrays import (
    glyph_mapper_array_props,
    polydata_array_entries,
)
from trame_vtklocal.module.camera_authority import CameraAuthority
from trame_vtklocal.module.state_cache import SceneReader
from trame_vtklocal.module.streamed_scene_translation import translate_actor
from trame_vtklocal.module.vtkjs_translator import (
    CAMERA_PROPERTIES,
    COLLECTION_TYPES,
    LOOKUPTABLE_SKIP_PROPERTIES,
    MAPPER_SKIP_PROPERTIES,
    PROPERTY_SKIP_PROPERTIES,
    RENDERER_SKIP_PROPERTIES,
    RENDERWINDOW_SKIP_PROPERTIES,
    SKIP_PROPERTIES,
    SKIP_TYPES,
    VTK_LIGHT_TYPE_MAP,
    get_ref_id,
    map_class_name,
    to_camel_case,
)
from trame_vtklocal.streamed_scene import STREAMED_SCENE_TYPE

if TYPE_CHECKING:
    from vtkmodules.vtkCommonCore import vtkObjectBase
    from vtkmodules.vtkSerializationManager import vtkObjectManager

    from trame_vtklocal.module.state_cache import ParsedStateCache, VtkState
    from trame_vtklocal.store import ArrayEntry, RefSlot, SceneNode


class DistanceToCameraBlock(dtc.DistanceToCameraConfig):
    inputDataObjectId: str


# The only ref slots a node may carry (state key -> slot name), keyed by
# vtk.js type. Everything else that looks like a reference stays out of the
# node entirely: props never hold refs, and unknown relations never dangle.
SINGLE_REF_SLOTS: dict[str, dict[str, str]] = {
    "vtkRenderer": {"ActiveCamera": "activeCamera"},
    "vtkActor": {"Mapper": "mapper", "Property": "property"},
    "vtkVolume": {"Mapper": "mapper", "Property": "property"},
    "vtkImageSlice": {"Mapper": "mapper", "Property": "property"},
    "vtkTexture": {"LookupTable": "lookupTable"},
}

LIST_REF_SLOTS: dict[str, dict[str, str]] = {
    "vtkRenderWindow": {"Renderers": "renderers"},
    "vtkRenderer": {"ViewProps": "viewProps", "Lights": "lights"},
    "vtkActor": {"Texture": "textures"},
    "vtkVolumeProperty": {
        "RGBTransferFunction": "rgbTransferFunction",
        "GrayTransferFunction": "grayTransferFunction",
        "ScalarOpacity": "scalarOpacity",
    },
    "vtkImageProperty": {
        "RGBTransferFunction": "rgbTransferFunction",
        "ScalarOpacity": "scalarOpacity",
    },
}

TYPE_SKIP_PROPERTIES: dict[str, set[str]] = {
    "vtkRenderWindow": RENDERWINDOW_SKIP_PROPERTIES,
    "vtkRenderer": RENDERER_SKIP_PROPERTIES,
    "vtkLookupTable": LOOKUPTABLE_SKIP_PROPERTIES,
    "vtkProperty": PROPERTY_SKIP_PROPERTIES,
}

# Containers that back node array entries or dissolve into ref lists; they
# never become nodes themselves (data arrays are matched by class name).
_NON_NODE_CLASS_NAMES = COLLECTION_TYPES | {
    "vtkPoints",
    "vtkCellArray",
    "vtkDataSetAttributes",
    "vtkPointData",
    "vtkCellData",
    "vtkFieldData",
}


def is_node_class(
    class_name: str, camera_authority: CameraAuthority = "server"
) -> bool:
    """Whether objects of this VTK class become scene-store nodes."""
    if not class_name:
        return False
    if class_name in SKIP_TYPES or class_name in _NON_NODE_CLASS_NAMES:
        return False
    if camera_authority == "client" and map_class_name(class_name) == "vtkCamera":
        return False
    return "Array" not in class_name


def _contains_ref(value: object) -> bool:
    if isinstance(value, list):
        return any(_contains_ref(item) for item in value)
    return get_ref_id(value) is not None


def _make_node(
    node_type: str,
    props: dict[str, object],
    refs: dict[str, RefSlot],
    arrays: dict[str, ArrayEntry],
    blocks: dict[str, Mapping[str, object]],
) -> SceneNode:
    node: SceneNode = {"type": node_type}
    if props:
        node["props"] = props
    if refs:
        node["refs"] = refs
    if arrays:
        node["arrays"] = arrays
    if blocks:
        node["blocks"] = blocks
    return node


def node_ref_ids(node: SceneNode) -> Iterator[str]:
    """Every node id a node's ref slots point at."""
    for value in node.get("refs", {}).values():
        if isinstance(value, str):
            yield value
        else:
            yield from value


def _collection_item_ids(reader: SceneReader, collection_id: int) -> list[int]:
    """Item ids of a live VTK collection (state ``Items`` as fallback)."""
    collection = reader.vtk_object(collection_id)
    if not isinstance(collection, vtkCollection):
        items = reader.state(collection_id).get("Items", [])
        return [ref_id for ref_id in map(get_ref_id, items) if ref_id]

    item_ids = []
    for index in range(collection.GetNumberOfItems()):
        item = collection.GetItemAsObject(index)
        if item is None:
            continue
        item_id = reader.object_manager.GetId(item)
        if item_id and item_id > 0:
            item_ids.append(item_id)
    return item_ids


def _ref_node_ids(reader: SceneReader, value: object) -> list[int]:
    """Resolve a state ref (or list of refs) into node ids.

    Collections dissolve into their items; SKIP_TYPES and other non-node
    classes (cameras under client authority included) drop out entirely so
    emitted ref slots can never dangle.
    """
    if isinstance(value, list):
        return [node_id for item in value for node_id in _ref_node_ids(reader, item)]

    ref_id = get_ref_id(value)
    if not ref_id:
        return []
    class_name = reader.class_name(ref_id)
    if class_name in COLLECTION_TYPES:
        return [
            node_id
            for item_id in _collection_item_ids(reader, ref_id)
            for node_id in _ref_node_ids(reader, {"Id": item_id})
        ]
    if not is_node_class(class_name, reader.camera_authority):
        return []
    return [ref_id]


def _slot_refs(
    reader: SceneReader, state: Mapping[str, object], vtkjs_type: str
) -> dict[str, RefSlot]:
    refs: dict[str, RefSlot] = {}
    for state_key, slot in SINGLE_REF_SLOTS.get(vtkjs_type, {}).items():
        if state_key not in state:
            continue
        node_ids = _ref_node_ids(reader, state[state_key])
        if node_ids:
            refs[slot] = str(node_ids[0])
    for state_key, slot in LIST_REF_SLOTS.get(vtkjs_type, {}).items():
        if state_key not in state:
            continue
        refs[slot] = [
            str(node_id) for node_id in _ref_node_ids(reader, state[state_key])
        ]
    return refs


def _scalar_props(
    state: Mapping[str, object], vtkjs_type: str, extra_skips: Set[str] = frozenset()
) -> dict[str, object]:
    props: dict[str, object] = {}
    type_skips: Set[str] = TYPE_SKIP_PROPERTIES.get(vtkjs_type, frozenset())
    for key, value in state.items():
        camel_key = to_camel_case(key)
        if key in SKIP_PROPERTIES or camel_key in SKIP_PROPERTIES:
            continue
        if _contains_ref(value):
            continue
        if vtkjs_type == "vtkCamera" and camel_key not in CAMERA_PROPERTIES:
            continue
        if camel_key in type_skips or camel_key in extra_skips:
            continue
        props[camel_key] = value

    # vtk.js Light expects string lightType, Python VTK uses integers.
    if vtkjs_type == "vtkLight" and "lightType" in props:
        props["lightType"] = VTK_LIGHT_TYPE_MAP.get(props["lightType"], "HeadLight")

    # vtk.js uses background[3] as alpha; merge BackgroundAlpha into background.
    if vtkjs_type == "vtkRenderer":
        background = props.get("background")
        if isinstance(background, list) and len(background) == 3:
            props["background"] = background + [state.get("BackgroundAlpha", 1.0)]

    return props


# ---------------------------------------------------------------------------
# Datasets
# ---------------------------------------------------------------------------


def _translate_polydata(
    reader: SceneReader, state: VtkState, vtkjs_type: str
) -> SceneNode:
    arrays = polydata_array_entries(reader, state)
    props = _scalar_props(state, vtkjs_type)
    return _make_node(vtkjs_type, props, {}, arrays, {})


# ---------------------------------------------------------------------------
# Mappers
# ---------------------------------------------------------------------------


def _mapper_input_port_ids(reader: SceneReader, state: VtkState) -> list[int]:
    """Dataset node id per input port.

    Stops at the first port with no node-worthy dataset so the list index
    always equals the port number. A port with several connections keeps the
    last one, matching the client's sequential ``setInputData`` semantics.
    """
    port_ids = []
    for port_value in state.get("InputDataObjects") or []:
        node_ids = _ref_node_ids(reader, port_value)
        if not node_ids:
            break
        port_ids.append(node_ids[-1])
    return port_ids


def _distance_to_camera_block(
    reader: SceneReader, vtkjs_type: str, vtk_mapper: vtkObjectBase
) -> DistanceToCameraBlock | None:
    """Distance-to-camera bypass block for a glyph mapper, or None."""
    if vtkjs_type != "vtkGlyph3DMapper":
        return None
    translation = dtc.distance_to_camera_mapper_translation(vtk_mapper)
    if not translation:
        return None
    input_id = dtc.ensure_registered_vtk_object(
        reader.object_manager,
        translation["inputDataObject"],
        reader.clear_state_cache,
    )
    if not input_id:
        return None
    config: DistanceToCameraBlock = {
        **translation["config"],
        "inputDataObjectId": str(input_id),
    }
    return config


def _translate_mapper(
    reader: SceneReader, state: VtkState, vtkjs_type: str
) -> SceneNode:
    vtk_mapper = reader.vtk_object(state["Id"])
    if vtk_mapper is None:
        raise RuntimeError(f"mapper state {state['Id']} has no live object")
    if vtkjs_type == "vtkPointGaussianMapper":
        validate_simple_points(cast(vtkPointGaussianMapper, vtk_mapper))
    props = _scalar_props(state, vtkjs_type, extra_skips=MAPPER_SKIP_PROPERTIES)
    refs: dict[str, RefSlot] = {}
    blocks: dict[str, Mapping[str, object]] = {}

    if vtkjs_type == "vtkGlyph3DMapper":
        props.update(glyph_mapper_array_props(vtk_mapper))

    input_ids = _mapper_input_port_ids(reader, state)
    dtc_block = _distance_to_camera_block(reader, vtkjs_type, vtk_mapper)
    if dtc_block:
        # Port 0 bypasses the vtkDistanceToCamera algorithm: the client feeds
        # the pre-filter dataset and applies screen-size scaling itself.
        props["scaleArray"] = dtc_block["arrayName"]
        blocks["distanceToCamera"] = dtc_block
        input_ids = [int(dtc_block["inputDataObjectId"]), *input_ids[1:]]
    if input_ids:
        refs["inputs"] = [str(input_id) for input_id in input_ids]

    lookup_table_ids = _ref_node_ids(reader, state.get("LookupTable"))
    if lookup_table_ids:
        refs["lookupTable"] = str(lookup_table_ids[0])

    pickable = pick.pickable_config(vtk_mapper)
    if pickable:
        blocks["pickable"] = pickable

    node_type = vtkjs_type
    projected_texture = ptx.projected_texture_config(vtk_mapper)
    if projected_texture:
        node_type = ptx.PROJECTED_TEXTURE_TYPE
        blocks[ptx.PROJECTED_TEXTURE_BLOCK] = projected_texture
    presentation = point_presentation.point_cloud_presentation_config(vtk_mapper)
    if presentation:
        blocks[point_presentation.POINT_CLOUD_PRESENTATION_BLOCK] = presentation

    return _make_node(node_type, props, refs, {}, blocks)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def _translate_generic(
    reader: SceneReader, state: VtkState, vtkjs_type: str
) -> SceneNode:
    props = _scalar_props(state, vtkjs_type)
    refs = _slot_refs(reader, state, vtkjs_type)
    blocks: dict[str, Mapping[str, object]] = {}

    if vtkjs_type == "vtkActor":
        vtkjs_type, props, refs, blocks = translate_actor(reader, state, props, refs)

    node = _make_node(vtkjs_type, props, refs, {}, blocks)
    if vtkjs_type == STREAMED_SCENE_TYPE:
        # Explicit empty map, not an omitted slot: it must clear a mapper ref.
        node["refs"] = {}
    return node


def _translate_node(reader: SceneReader, obj_id: int) -> SceneNode | None:
    state = reader.state(obj_id)
    class_name = state.get("ClassName", "")
    if not is_node_class(class_name, reader.camera_authority):
        return None

    vtkjs_type = map_class_name(class_name)
    if class_name == "vtkPolyData":
        return _translate_polydata(reader, state, vtkjs_type)
    if "Mapper" in class_name:
        return _translate_mapper(reader, state, vtkjs_type)
    return _translate_generic(reader, state, vtkjs_type)


def scene_reader(
    object_manager: vtkObjectManager,
    camera_authority: CameraAuthority = "server",
    state_cache: ParsedStateCache | None = None,
    class_names: Mapping[str, str] | None = None,
) -> SceneReader:
    """A cached state reader, shareable across several ``translate_object``
    calls in one pass so referenced states are JSON-parsed once."""
    return SceneReader(
        object_manager,
        camera_authority,
        state_cache=state_cache,
        class_names=class_names,
    )


def translate_object(
    object_manager: vtkObjectManager,
    obj_id: int | str,
    camera_authority: CameraAuthority = "server",
    reader: SceneReader | None = None,
) -> SceneNode | None:
    """Translate one object into its flat node.

    Returns ``None`` for objects that never become nodes (SKIP_TYPES,
    collections, data containers, client-authority cameras). Pass a shared
    ``reader`` (from :func:`scene_reader`) when translating several objects
    from the same refreshed states.
    """
    if reader is None:
        reader = SceneReader(object_manager, camera_authority)
    return _translate_node(reader, int(obj_id))


def translate_scene(
    object_manager: vtkObjectManager,
    root_id: int | str,
    camera_authority: CameraAuthority = "server",
    state_cache: ParsedStateCache | None = None,
    class_names: Mapping[str, str] | None = None,
) -> dict[str, SceneNode]:
    """Translate every node reachable from ``root_id`` into ``{id: node}``.

    Every id a node's ``refs`` mention is present in the result, so the map
    upserts into a :class:`~trame_vtklocal.store.SceneStore` without dangling
    refs.
    """
    reader = SceneReader(
        object_manager,
        camera_authority,
        state_cache=state_cache,
        class_names=class_names,
    )
    nodes: dict[str, SceneNode] = {}
    pending = [int(root_id)]
    while pending:
        obj_id = pending.pop()
        node_id = str(obj_id)
        if node_id in nodes:
            continue
        node = _translate_node(reader, obj_id)
        if node is None:
            continue
        nodes[node_id] = node
        pending.extend(
            int(ref_id) for ref_id in node_ref_ids(node) if ref_id not in nodes
        )
    return nodes
