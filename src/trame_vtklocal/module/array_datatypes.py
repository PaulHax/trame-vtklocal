"""VTK array scalar type -> JS typed-array constructor.

The one place that decides how a dataset array's bytes are reinterpreted
on the client; a wrong answer here silently corrupts every value in the
array rather than failing.
"""

from __future__ import annotations

from vtkmodules.util import vtkConstants

# JS typed-array constructor per VTK scalar type, keyed by the type *constant
# name*; the numeric GetDataType() ids are resolved from vtkConstants below,
# never hand-written (VTK 9.x transposes them — UNSIGNED_CHAR=3, SHORT=4,
# UNSIGNED_SHORT=5, SIGNED_CHAR=15).
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


def js_datatype(class_name, data_type, *, missing_default=None):
    """JS typed-array constructor for a VTK array.

    A concrete VTK class wins over its numeric id.  Unknown numeric ids must
    not silently reinterpret their payload as Float32.  Callers handling
    genuinely absent serializer metadata can deliberately provide a default.
    """
    class_type = CLASS_TO_DATATYPE.get(class_name)
    if class_type is not None:
        return class_type

    numeric_type = VTK_DATATYPE_MAP.get(data_type)
    if numeric_type is not None:
        return numeric_type

    if data_type is None and missing_default is not None:
        return missing_default

    if data_type is None:
        raise ValueError(
            "VTK array datatype metadata is missing "
            f"for class {class_name!r}; no client typed-array contract is available"
        )
    raise ValueError(
        "unsupported VTK numeric array datatype "
        f"{data_type!r} for class {class_name!r}"
    )
