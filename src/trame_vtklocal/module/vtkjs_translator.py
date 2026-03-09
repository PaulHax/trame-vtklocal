"""
Translator from vtkObjectManager flat state format to vtk.js nested state format.

vtkObjectManager format (flat):
- Each object has its own JSON state with Id, ClassName, MTime
- Properties are at top level
- References to other objects are {"Id": N}
- Arrays have Hash field for blob data
- Collection objects have Items array with [{"Id": N}, ...]

vtk.js format (nested):
- id: string version of the ID
- type: mapped class name (vtkOpenGLRenderer → vtkRenderer)
- mtime: modification time
- properties: object containing primitive properties
- dependencies: array of nested child states
- calls: array like ["addRenderer", ["instance:${2}"]]
- arrays: object with array metadata including hash, dataType, etc.
"""

import hashlib
import json

import numpy as np
from vtkmodules.util.numpy_support import numpy_to_vtk

_scene_mtime_counter = [0]

CLASS_NAME_MAP = {
    "vtkXOpenGLRenderWindow": "vtkRenderWindow",
    "vtkCocoaRenderWindow": "vtkRenderWindow",
    "vtkWin32OpenGLRenderWindow": "vtkRenderWindow",
    "vtkOpenGLRenderWindow": "vtkRenderWindow",
    "vtkGenericOpenGLRenderWindow": "vtkRenderWindow",
    "vtkOpenGLRenderer": "vtkRenderer",
    "vtkOpenGLCamera": "vtkCamera",
    "vtkOpenGLActor": "vtkActor",
    "vtkOpenGLPolyDataMapper": "vtkMapper",
    "vtkOpenGLProperty": "vtkProperty",
    "vtkOpenGLLight": "vtkLight",
    "vtkOpenGLTexture": "vtkTexture",
    "vtkOpenGLShaderProperty": "vtkShaderProperty",
    "vtkPVLODActor": "vtkActor",
    "vtkPVLight": "vtkLight",
    "vtkCompositePolyDataMapper2": "vtkMapper",
    "vtkDataSetMapper": "vtkMapper",
    "vtkPVDiscretizableColorTransferFunction": "vtkColorTransferFunction",
    "vtkOpenGLImageSliceMapper": "vtkImageMapper",
    "vtkFixedPointVolumeRayCastMapper": "vtkVolumeMapper",
}

COLLECTION_TYPES = {
    "vtkRendererCollection",
    "vtkPropCollection",
    "vtkLightCollection",
    "vtkCullerCollection",
    "vtkActorCollection",
    "vtkVolumeCollection",
}

SKIP_TYPES = {
    "vtkInformation",
    "vtkFXAAOptions",
    "vtkCullerCollection",
    "vtkFrustumCoverageCuller",
    "vtkPBRLUTTexture",
    "vtkPBRIrradianceTexture",
    "vtkPBRPrefilterTexture",
    "vtkMatrix4x4",
    "vtkOpenGLShaderProperty",
}

PROPERTY_RELATIONS = {
    "vtkRenderWindow": {
        "Renderers": ("addRenderer", "vtkRendererCollection"),
    },
    "vtkRenderer": {
        "ViewProps": ("addViewProp", "vtkPropCollection"),
        "ActiveCamera": ("setActiveCamera", None),
        "Lights": ("addLight", "vtkLightCollection"),
    },
    "vtkActor": {
        "Mapper": ("setMapper", None),
        "Property": ("setProperty", None),
        "Texture": ("addTexture", None),
    },
    "vtkVolume": {
        "Mapper": ("setMapper", None),
        "Property": ("setProperty", None),
    },
    "vtkImageSlice": {
        "Mapper": ("setMapper", None),
        "Property": ("setProperty", None),
    },
    "vtkMapper": {
        "LookupTable": ("setLookupTable", None),
    },
    "vtkVolumeMapper": {
        "LookupTable": ("setLookupTable", None),
    },
    "vtkVolumeProperty": {
        "RGBTransferFunction": ("setRGBTransferFunction", None),
        "ScalarOpacity": ("setScalarOpacity", None),
    },
    "vtkTexture": {
        "LookupTable": ("setLookupTable", None),
    },
}

ATTRIBUTE_REGISTRATIONS = {
    "Scalars": "setScalars",
    "Vectors": "setVectors",
    "Normals": "setNormals",
    "TCoords": "setTCoords",
    "Tensors": "setTensors",
    "GlobalIds": "setGlobalIds",
    "PedigreeIds": "setPedigreeIds",
}

FIELD_DATA_GETTERS = {
    "PointData": "GetPointData",
    "CellData": "GetCellData",
    "FieldData": "GetFieldData",
}

POLYDATA_ARRAYS = {
    "Points": {"registration": "setPoints", "vtkClass": "vtkPoints"},
    "Verts": {"registration": "setVerts", "vtkClass": "vtkCellArray"},
    "Lines": {"registration": "setLines", "vtkClass": "vtkCellArray"},
    "Polys": {"registration": "setPolys", "vtkClass": "vtkCellArray"},
    "Strips": {"registration": "setStrips", "vtkClass": "vtkCellArray"},
}

SKIP_PROPERTIES = {
    # Core VTK object properties not needed in vtk.js
    "Id",
    "ClassName",
    "MTime",
    "SuperClassNames",
    "GlobalWarningDisplay",
    "ObjectName",
    "vtk-object-manager-kept-alive",
    # CoordinateSystem enums are incompatible between Python VTK and vtk.js:
    # - Python VTK (vtkProp3D): WORLD=0, PHYSICAL=1, DEVICE=2 (for VR positioning)
    # - vtk.js: DISPLAY=0, WORLD=1 (DISPLAY is for 2D screen-space overlays)
    # Python VTK uses vtkActor2D + vtkCoordinate for 2D overlays, not CoordinateSystem.
    # Skipping lets vtk.js default to WORLD mode. This is a limitation - PHYSICAL and
    # DEVICE coordinate systems (VR) are not supported.
    "CoordinateSystem",
    "CoordinateSystemDevice",
    # Properties below exist in Python VTK but have no setters in vtk.js.
    # Skipping them avoids console warnings and reduces network traffic.
    # RenderWindow properties
    "abortRender",
    "alphaBitPlanes",
    "anaglyphColorMask",
    "anaglyphColorSaturation",
    "borders",
    "coverable",
    "currentCursor",
    "desiredUpdateRate",
    "deviceIndex",
    "doubleBuffer",
    "erase",
    "frameBlitMode",
    "framebufferFlipY",
    "fullScreen",
    "globalMaximumNumberOfMultiSamples",
    "inAbortCheck",
    "lineSmoothing",
    "multiSamples",
    "pointSmoothing",
    "polygonSmoothing",
    "renderBufferTargetDepthSize",
    "showWindow",
    "stencilCapable",
    "stereoCapableWindow",
    "stereoRender",
    "stereoType",
    "swapBuffers",
    "tileScale",
    "tileViewport",
    "useOffScreenBuffers",
    "useSRGBColorSpace",
    "windowName",
    # Renderer properties
    "allocatedRenderTime",
    "aspect",
    "displayPoint",
    "ditherGradient",
    "environmentRight",
    "environmentUp",
    "environmentalBG",
    "environmentalBG2",
    "gradientBackground",
    "gradientEnvironmentalBG",
    "gradientMode",
    "pixelAspect",
    "sSAOBias",
    "sSAOBlur",
    "sSAOKernelSize",
    "sSAORadius",
    "safeGetZ",
    "useDepthPeelingForVolumes",
    "useFXAA",
    "useHiddenLineRemoval",
    "useOIT",
    "useSSAO",
    "viewPoint",
    "worldPoint",
    # Property (actor appearance) properties
    "allTextures",
    "ambientColor",
    "anisotropy",
    "anisotropyRotation",
    "coatColor",
    "coatIOR",
    "coatNormalScale",
    "coatRoughness",
    "coatStrength",
    "diffuseColor",
    "edgeOpacity",
    "edgeTint",
    "edgeWidth",
    "emissiveFactor",
    "lineStipplePattern",
    "lineStippleRepeatFactor",
    "normalScale",
    "occlusionStrength",
    "point2DShape",
    "renderLinesAsTubes",
    "renderPointsAsSpheres",
    "selectionColor",
    "selectionLineWidth",
    "selectionPointSize",
    "shading",
    "showTexturesOnBackface",
    "specularColor",
    "useLineWidthForEdgeThickness",
    "vertexColor",
    "vertexVisibility",
    # Mapper properties
    "abortExecute",
    "arrayComponent",
    "arrayId",
    "arrayName",
    "ghostLevel",
    "numberOfSubPieces",
    "pauseShiftScale",
    "piece",
    "resolveCoincidentTopologyZShift",
    "seamlessU",
    "seamlessV",
    "useProgramPointSize",
    "vBOShiftScaleMethod",
    # LookupTable properties
    "annotatedValues",
    "editable",
    "globalReleaseDataFlag",
    "ramp",
    "tableRange",
    # VR/Physical properties (not supported in vtk.js web context)
    "physicalScale",
    "physicalTranslation",
    "physicalViewDirection",
    "physicalViewUp",
    # Misc
    "enableTranslucentSurface",
}

RENDERWINDOW_SKIP_PROPERTIES = {
    "position",
    "size",
}

RENDERER_SKIP_PROPERTIES = {
    "ambient",
    "backgroundAlpha",
    "texturedBackground",
    "automaticLightCreation",
    "backingStore",
    "preserveColorBuffer",
    "preserveDepthBuffer",
    "useImageBasedLighting",
    "useSphericalHarmonics",
}

LOOKUPTABLE_SKIP_PROPERTIES = {
    "scale",
    "tableValue",
}

MAPPER_SKIP_PROPERTIES = {
    "numberOfPieces",
}

PROPERTY_SKIP_PROPERTIES = {
    "lineJoin",
}

# Properties vtk.js Camera expects
CAMERA_PROPERTIES = {
    "position",
    "focalPoint",
    "viewUp",
    "clippingRange",
    "viewAngle",
    "parallelProjection",
    "parallelScale",
    "physicalScale",
    "physicalTranslation",
    "physicalViewDirection",
    "physicalViewUp",
}

VTK_DATATYPE_MAP = {
    1: "Int8Array",  # VTK_BIT (approximate)
    2: "Int8Array",  # VTK_CHAR
    3: "Int8Array",  # VTK_SIGNED_CHAR
    4: "Uint8Array",  # VTK_UNSIGNED_CHAR
    5: "Int16Array",  # VTK_SHORT
    6: "Int32Array",  # VTK_INT
    7: "Uint32Array",  # VTK_UNSIGNED_INT
    8: "BigInt64Array",  # VTK_LONG
    9: "BigUint64Array",  # VTK_UNSIGNED_LONG
    10: "Float32Array",  # VTK_FLOAT
    11: "Float64Array",  # VTK_DOUBLE
    12: "BigInt64Array",  # VTK_ID_TYPE
    15: "Uint16Array",  # VTK_UNSIGNED_SHORT
    16: "BigInt64Array",  # VTK_LONG_LONG
    17: "BigUint64Array",  # VTK_UNSIGNED_LONG_LONG
}

CLASS_TO_DATATYPE = {
    "vtkFloatArray": "Float32Array",
    "vtkDoubleArray": "Float64Array",
    "vtkIntArray": "Int32Array",
    "vtkUnsignedIntArray": "Uint32Array",
    "vtkShortArray": "Int16Array",
    "vtkUnsignedShortArray": "Uint16Array",
    "vtkCharArray": "Int8Array",
    "vtkSignedCharArray": "Int8Array",
    "vtkUnsignedCharArray": "Uint8Array",
    "vtkLongArray": "BigInt64Array",
    "vtkUnsignedLongArray": "BigUint64Array",
    "vtkLongLongArray": "BigInt64Array",
    "vtkUnsignedLongLongArray": "BigUint64Array",
    "vtkIdTypeArray": "BigInt64Array",
    "vtkTypeInt64Array": "BigInt64Array",
    "vtkTypeUInt64Array": "BigUint64Array",
    "vtkTypeInt32Array": "Int32Array",
    "vtkTypeUInt32Array": "Uint32Array",
    "vtkTypeFloat32Array": "Float32Array",
    "vtkTypeFloat64Array": "Float64Array",
}


def map_class_name(class_name):
    return CLASS_NAME_MAP.get(class_name, class_name)


def to_camel_case(name):
    """Convert PascalCase to camelCase for vtk.js property names."""
    if not name:
        return name
    return name[0].lower() + name[1:]


def is_ref(value):
    return isinstance(value, dict) and "Id" in value and len(value) == 1


def get_ref_id(value):
    if is_ref(value):
        return value["Id"]
    return None


def wrap_id(obj_id):
    return f"instance:${{{obj_id}}}"


class VtkJsTranslator:
    def __init__(self, object_manager):
        self.object_manager = object_manager
        self._states_cache = {}
        self._visited = set()

    def _get_state(self, obj_id):
        if obj_id not in self._states_cache:
            state_json = self.object_manager.GetState(obj_id)
            self._states_cache[obj_id] = json.loads(state_json)
        return self._states_cache[obj_id]

    def _get_vtk_object(self, obj_id):
        """Get the actual VTK Python object for an ID."""
        return self.object_manager.GetObjectAtId(obj_id)

    def _get_collection_items(self, ref_id, ref_class):
        """Get items from a VTK collection using Python API."""
        vtk_obj = self._get_vtk_object(ref_id)
        if vtk_obj is None:
            ref_state = self._get_state(ref_id)
            return ref_state.get("Items", [])

        items = []
        for i in range(vtk_obj.GetNumberOfItems()):
            item = vtk_obj.GetItemAsObject(i)
            if item:
                item_id = self.object_manager.GetId(item)
                if item_id >= 0:
                    items.append({"Id": item_id})
        return items

    def _build_array_metadata(self, state):
        class_name = state.get("ClassName", "")

        if "Array" in class_name and class_name not in ("vtkCellArray",):
            hash_val = state.get("Hash")
            if hash_val:
                if class_name in CLASS_TO_DATATYPE:
                    js_type = CLASS_TO_DATATYPE[class_name]
                else:
                    data_type = state.get("DataType", 10)
                    js_type = VTK_DATATYPE_MAP.get(data_type, "Float32Array")

                num_components = state.get("NumberOfComponents", 1)
                num_tuples = state.get("NumberOfTuples", 0)
                name = state.get("Name", "")

                return {
                    "hash": hash_val,
                    "dataType": js_type,
                    "numberOfComponents": num_components,
                    "size": num_tuples * num_components,
                    "name": name,
                }
        return None

    def _translate_polydata(self, state, vtkjs_type):
        props = {}
        dependencies = []
        calls = []
        fields = []

        for key, value in state.items():
            if key in SKIP_PROPERTIES or to_camel_case(key) in SKIP_PROPERTIES:
                continue

            if key in POLYDATA_ARRAYS:
                ref_id = get_ref_id(value)
                if ref_id:
                    container_state = self._get_state(ref_id)
                    container_class = container_state.get("ClassName", "")

                    if container_class == "vtkPoints":
                        data_ref = get_ref_id(container_state.get("Data"))
                        if data_ref:
                            data_state = self._get_state(data_ref)
                            array_meta = self._build_array_metadata(data_state)
                            if array_meta:
                                array_meta["vtkClass"] = "vtkPoints"
                                props["points"] = array_meta

                    elif container_class == "vtkCellArray":
                        num_cells = container_state.get("NumberOfCells", 0)
                        if num_cells > 0:
                            conn_ref = get_ref_id(container_state.get("Connectivity"))
                            off_ref = get_ref_id(container_state.get("Offsets"))
                            if conn_ref and off_ref:
                                conn_state = self._get_state(conn_ref)
                                off_state = self._get_state(off_ref)
                                conn_hash = conn_state.get("Hash")
                                off_hash = off_state.get("Hash")
                                if conn_hash and off_hash:
                                    combined_hash = f"cell:{conn_hash}:{off_hash}"
                                    num_conn = conn_state.get("NumberOfTuples", 0)
                                    array_meta = {
                                        "hash": combined_hash,
                                        "dataType": "Uint32Array",
                                        "numberOfComponents": 1,
                                        "size": num_conn + num_cells,
                                        "name": key.lower(),
                                        "vtkClass": "vtkCellArray",
                                    }
                                    props[key.lower()] = array_meta

            elif key in ("PointData", "CellData", "FieldData"):
                # Read arrays directly from VTK Python objects since
                # vtkObjectManager doesn't serialize DataSetAttributes arrays
                vtk_polydata = self._get_vtk_object(state["Id"])
                if vtk_polydata:
                    fields.extend(
                        self._extract_field_arrays(vtk_polydata, key)
                    )
            elif not is_ref(value):
                props[to_camel_case(key)] = value

        if fields:
            props["fields"] = fields

        return {
            "id": str(state["Id"]),
            "type": vtkjs_type,
            "mtime": state.get("MTime", 0),
            "properties": props,
            "dependencies": dependencies,
            "calls": calls,
        }

    def _extract_field_arrays(self, vtk_polydata, field_name):
        """Extract arrays from PointData/CellData/FieldData using VTK Python API.

        vtkObjectManager doesn't serialize vtkDataSetAttributes arrays,
        so we read them directly and register blobs manually.
        """
        getter = FIELD_DATA_GETTERS.get(field_name)
        if not getter:
            return []

        field_data = getattr(vtk_polydata, getter)()
        if not field_data or field_data.GetNumberOfArrays() == 0:
            return []

        location = to_camel_case(field_name)

        # Build attribute map: array_name -> registration method
        attr_map = {}
        for vtk_attr, reg_method in ATTRIBUTE_REGISTRATIONS.items():
            get_attr = f"Get{vtk_attr}"
            if hasattr(field_data, get_attr):
                attr_arr = getattr(field_data, get_attr)()
                if attr_arr:
                    attr_map[attr_arr.GetName()] = reg_method

        results = []
        for i in range(field_data.GetNumberOfArrays()):
            arr = field_data.GetArray(i)
            if not arr:
                continue

            num_tuples = arr.GetNumberOfTuples()
            num_components = arr.GetNumberOfComponents()
            if num_tuples == 0:
                continue

            # Use ravel() for zero-copy view when data is contiguous
            np_arr = np.array(arr).ravel()
            raw_bytes = np_arr.view(np.uint8)
            hash_val = hashlib.md5(raw_bytes).hexdigest()

            # RegisterBlob requires a vtkTypeUInt8Array (= vtkUnsignedCharArray).
            blob = numpy_to_vtk(raw_bytes, deep=True)
            self.object_manager.RegisterBlob(hash_val, blob)

            data_type = arr.GetDataType()
            js_type = VTK_DATATYPE_MAP.get(data_type, "Float32Array")
            name = arr.GetName() or ""

            meta = {
                "hash": hash_val,
                "dataType": js_type,
                "numberOfComponents": num_components,
                "size": num_tuples * num_components,
                "name": name,
                "location": location,
            }
            if name in attr_map:
                meta["registration"] = attr_map[name]
            results.append(meta)

        return results

    def _translate_mapper(self, state, vtkjs_type):
        props = {}
        dependencies = []
        calls = []

        for key, value in state.items():
            if key in SKIP_PROPERTIES or to_camel_case(key) in SKIP_PROPERTIES:
                continue

            if key == "InputDataObjects":
                input_list = value
                if input_list and isinstance(input_list, list):
                    for port_inputs in input_list:
                        if isinstance(port_inputs, list):
                            for input_ref in port_inputs:
                                input_id = get_ref_id(input_ref)
                                if input_id:
                                    input_dep = self._translate_object(input_id)
                                    if input_dep:
                                        dependencies.append(input_dep)
                                        calls.append(
                                            ["setInputData", [wrap_id(input_id)]]
                                        )
            elif key == "LookupTable":
                lut_id = get_ref_id(value)
                if lut_id:
                    lut_dep = self._translate_object(lut_id)
                    if lut_dep:
                        dependencies.append(lut_dep)
                        calls.append(["setLookupTable", [wrap_id(lut_id)]])
            elif not is_ref(value):
                camel_key = to_camel_case(key)
                if camel_key in MAPPER_SKIP_PROPERTIES:
                    continue
                props[camel_key] = value

        return {
            "id": str(state["Id"]),
            "type": vtkjs_type,
            "mtime": state.get("MTime", 0),
            "properties": props,
            "dependencies": dependencies,
            "calls": calls,
        }

    def _translate_generic(self, state, vtkjs_type, relation_map=None):
        props = {}
        dependencies = []
        calls = []

        is_camera = vtkjs_type == "vtkCamera"
        is_renderer = vtkjs_type == "vtkRenderer"
        is_renderwindow = vtkjs_type == "vtkRenderWindow"
        is_lookuptable = vtkjs_type == "vtkLookupTable"
        is_property = vtkjs_type == "vtkProperty"

        for key, value in state.items():
            if key in SKIP_PROPERTIES or to_camel_case(key) in SKIP_PROPERTIES:
                continue

            ref_id = get_ref_id(value)
            if ref_id:
                if relation_map and key in relation_map:
                    method, collection_type = relation_map[key]
                    ref_state = self._get_state(ref_id)
                    ref_class = ref_state.get("ClassName", "")

                    if ref_class in COLLECTION_TYPES:
                        items = self._get_collection_items(ref_id, ref_class)
                        for item_ref in items:
                            item_id = get_ref_id(item_ref)
                            if item_id:
                                item_dep = self._translate_object(item_id)
                                if item_dep:
                                    dependencies.append(item_dep)
                                    calls.append([method, [wrap_id(item_id)]])
                    else:
                        dep = self._translate_object(ref_id)
                        if dep:
                            dependencies.append(dep)
                            calls.append([method, [wrap_id(ref_id)]])
            elif isinstance(value, list) and value and is_ref(value[0]):
                pass
            else:
                camel_key = to_camel_case(key)
                if is_camera and camel_key not in CAMERA_PROPERTIES:
                    continue
                if is_renderwindow and camel_key in RENDERWINDOW_SKIP_PROPERTIES:
                    continue
                if is_renderer and camel_key in RENDERER_SKIP_PROPERTIES:
                    continue
                if is_lookuptable and camel_key in LOOKUPTABLE_SKIP_PROPERTIES:
                    continue
                if is_property and camel_key in PROPERTY_SKIP_PROPERTIES:
                    continue
                props[camel_key] = value

        # vtk.js uses background[3] as alpha; merge BackgroundAlpha into background
        if is_renderer and "background" in props:
            bg = props["background"]
            alpha = state.get("BackgroundAlpha", 1.0)
            if isinstance(bg, list) and len(bg) == 3:
                props["background"] = bg + [alpha]

        return {
            "id": str(state["Id"]),
            "type": vtkjs_type,
            "mtime": state.get("MTime", 0),
            "properties": props,
            "dependencies": dependencies,
            "calls": calls,
        }

    def _translate_object(self, obj_id):
        if obj_id in self._visited:
            return None
        self._visited.add(obj_id)

        state = self._get_state(obj_id)
        class_name = state.get("ClassName", "")

        if class_name in SKIP_TYPES:
            return None

        if class_name in COLLECTION_TYPES:
            return None

        vtkjs_type = map_class_name(class_name)

        if class_name == "vtkPolyData":
            return self._translate_polydata(state, vtkjs_type)

        if "Mapper" in class_name and "Volume" not in class_name:
            return self._translate_mapper(state, vtkjs_type)

        relation_map = PROPERTY_RELATIONS.get(vtkjs_type)
        return self._translate_generic(state, vtkjs_type, relation_map)

    def translate(self, root_id):
        self._visited.clear()
        self._states_cache.clear()

        root_state = self._get_state(root_id)
        root_class = root_state.get("ClassName", "")
        vtkjs_type = map_class_name(root_class)

        self._visited.add(root_id)

        relation_map = PROPERTY_RELATIONS.get(vtkjs_type)
        result = self._translate_generic(root_state, vtkjs_type, relation_map)

        result["mtime"] = root_state.get("MTime", 0)

        return result


def translate_scene(object_manager, root_id):
    _scene_mtime_counter[0] += 1
    translator = VtkJsTranslator(object_manager)
    result = translator.translate(root_id)
    result["mtime"] = _scene_mtime_counter[0]
    return result
