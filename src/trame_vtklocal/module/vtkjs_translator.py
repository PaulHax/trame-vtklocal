"""Shared VTK -> vtk.js translation tables.

Pure lookup tables (class-name mapping, skip lists, property allowlists,
array dtype maps) plus a few tiny stateless helpers. The flat-node
translator (``node_translator``) and dataset array bridging
(``node_arrays``) consume these, and
``vue-components/scripts/gen_translation_schema.py`` AST-parses this file to
emit the JS mirror (``translationSchema.js``) — table edits must re-run
``npm run gen-schema``.
"""

from vtkmodules.util import vtkConstants

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
    "vtkOpenGLGlyph3DMapper": "vtkGlyph3DMapper",
    "vtkOpenGLPointGaussianMapper": "vtkPointGaussianMapper",
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
        "RGBTransferFunction": {"method": "setRGBTransferFunction", "indexed": True},
        "GrayTransferFunction": {"method": "setGrayTransferFunction", "indexed": True},
        "ScalarOpacity": {"method": "setScalarOpacity", "indexed": True},
    },
    "vtkImageProperty": {
        "RGBTransferFunction": {"method": "setRGBTransferFunction", "indexed": True},
        "ScalarOpacity": {"method": "setScalarOpacity", "indexed": True},
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
    "useImageBasedLighting",
    "useSphericalHarmonics",
}

LOOKUPTABLE_SKIP_PROPERTIES = {
    "scale",
    "tableValue",
    # Property name mismatch between Python VTK and vtk.js
    # (vtk.js uses ``annotatedValueMap`` / ``mappingRange`` / ``table`` instead).
    "annotations",
    "range",
}

MAPPER_SKIP_PROPERTIES = {
    "numberOfPieces",
    "clamping",
    "cullingAndLOD",
    "lODColoring",
    "masking",
    "range",
    "selectionColorId",
    "sourceIndexing",
    "useSelectionIds",
    "useSourceTableTree",
    # Server-side coincident-topology offsets — vtk.js doesn't expose these
    # via instance.get(), so emitting them only creates dump/shadow drift.
    "relativeCoincidentTopologyLineOffsetParameters",
    "relativeCoincidentTopologyPolygonOffsetParameters",
    "resolveCoincidentTopologyLineOffsetParameters",
    "resolveCoincidentTopologyPolygonOffsetFaces",
    "resolveCoincidentTopologyPolygonOffsetParameters",
    # vtkPointGaussianMapper-only fields the client mapper does not implement
    # (it keeps only scaleFactor + the shared vtkMapper surface). These exist on
    # no other mapper, so skipping them here is a no-op elsewhere.
    "anisotropic",
    "boundScale",
    "emissive",
    "lowpassMatrix",
    "opacityArrayComponent",
    "opacityTableSize",
    "scaleArrayComponent",
    "scaleTableSize",
}

PROPERTY_SKIP_PROPERTIES = {
    "lineJoin",
    # vtk.js's ``setSpecularPower`` recomputes ``roughness = 1/max(1,p)`` and
    # overwrites whatever value ``setRoughness`` just applied — see
    # vtk-js/Sources/Rendering/Core/Property/index.js setSpecularPower.
    # Skipping specularPower lets the explicit roughness/metallic round-trip.
    "specularPower",
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

# JS typed-array constructor per VTK scalar type, keyed by the type *constant
# name*; the numeric GetDataType() ids are resolved from vtkConstants below,
# never hand-written (VTK 9.x transposes them — UNSIGNED_CHAR=3, SHORT=4,
# UNSIGNED_SHORT=5, SIGNED_CHAR=15 — and a stale literal advertised uint8 RGB as
# Int8Array). gen_translation_schema.py resolves the same names for the JS mirror.
VTK_DATATYPE_JS_BY_NAME = {
    "VTK_BIT": "Uint8Array",  # packed bits; unsigned storage on the client
    "VTK_CHAR": "Int8Array",
    "VTK_SIGNED_CHAR": "Int8Array",
    "VTK_UNSIGNED_CHAR": "Uint8Array",
    "VTK_SHORT": "Int16Array",
    "VTK_UNSIGNED_SHORT": "Uint16Array",
    "VTK_INT": "Int32Array",
    "VTK_UNSIGNED_INT": "Uint32Array",
    "VTK_LONG": "BigInt64Array",
    "VTK_UNSIGNED_LONG": "BigUint64Array",
    "VTK_FLOAT": "Float32Array",
    "VTK_DOUBLE": "Float64Array",
    "VTK_ID_TYPE": "BigInt64Array",
    "VTK_LONG_LONG": "BigInt64Array",
    "VTK_UNSIGNED_LONG_LONG": "BigUint64Array",
}

VTK_DATATYPE_MAP = {
    getattr(vtkConstants, name): js_type
    for name, js_type in VTK_DATATYPE_JS_BY_NAME.items()
    if hasattr(vtkConstants, name)
}

VTK_LIGHT_TYPE_MAP = {
    1: "HeadLight",
    2: "CameraLight",
    3: "SceneLight",
}

# Concrete VTK array class -> JS typed array; preferred over the numeric map
# (unambiguous, version-independent). numpy_to_vtk emits the fixed-width
# vtkType* classes (uint8 RGB -> vtkTypeUInt8Array), so keep them all present.
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
    "vtkTypeInt8Array": "Int8Array",
    "vtkTypeUInt8Array": "Uint8Array",
    "vtkTypeInt16Array": "Int16Array",
    "vtkTypeUInt16Array": "Uint16Array",
    "vtkTypeInt32Array": "Int32Array",
    "vtkTypeUInt32Array": "Uint32Array",
    "vtkTypeInt64Array": "BigInt64Array",
    "vtkTypeUInt64Array": "BigUint64Array",
    "vtkTypeFloat32Array": "Float32Array",
    "vtkTypeFloat64Array": "Float64Array",
}


def js_datatype(class_name, data_type):
    """JS typed-array constructor for a VTK array: prefer the concrete class
    name, fall back to the numeric GetDataType() id, default Float32Array."""
    return CLASS_TO_DATATYPE.get(class_name) or VTK_DATATYPE_MAP.get(
        data_type, "Float32Array"
    )


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


def actor_user_matrix_property(vtk_obj):
    matrix = vtk_obj.GetUserMatrix() if vtk_obj is not None else None
    if matrix is None:
        return None

    return [
        float(matrix.GetElement(row, col))
        for col in range(4)
        for row in range(4)
    ]
