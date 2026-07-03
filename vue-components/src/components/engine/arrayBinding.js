// Binding node array entries to vtk.js data arrays (push sync v2).
//
// An `arrays` entry carries a blob ref plus construction metadata:
//   { ref, dataType, size, numberOfComponents, name?, registration?,
//     location?, vtkClass? }
// - topology entries (points/verts/...) have `registration` (setPoints, ...)
//   and `vtkClass` (vtkPoints / vtkCellArray) and bind on the dataset itself;
// - field entries have `location` (pointData/cellData/fieldData) and an
//   optional attribute `registration` (setScalars, ...), default addArray.
//
// The construction/reuse semantics are ported from v1's
// createNewArrayHandler: reuse the existing vtk array object when present and
// swap its data in place, otherwise build the right vtk class and register it.

import { TYPED_ARRAYS } from "@kitware/vtk.js/macros";
import vtkPoints from "@kitware/vtk.js/Common/Core/Points";
import vtkCellArray from "@kitware/vtk.js/Common/Core/CellArray";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";

const ARRAY_CLASSES = {
  vtkPoints,
  vtkCellArray,
  vtkDataArray,
};

export function typedArrayConstructor(dataType) {
  return TYPED_ARRAYS[dataType] || Float32Array;
}

// Blobs enter the cache as raw Uint8Array copies (dataType is a property of
// the referencing array entry, not the blob). The first bind converts the
// entry to its typed view and promotes the cache slot so later binds and
// in-place patches share the exact array the vtk data array holds.
export function cachedTypedArray(cache, ref, dataType) {
  const Ctor = typedArrayConstructor(dataType);
  let values = cache.get(ref);
  if (!values) {
    return null;
  }
  if (values.constructor !== Ctor) {
    const aligned =
      values.byteOffset === 0 &&
      values.byteLength === values.buffer.byteLength &&
      values.byteLength % Ctor.BYTES_PER_ELEMENT === 0;
    const buffer = aligned
      ? values.buffer
      : values.buffer.slice(
          values.byteOffset,
          values.byteOffset + values.byteLength,
        );
    values = new Ctor(buffer);
    cache.set(ref, values);
  }
  return values;
}

function findPreviousArray(instance, entry) {
  if (entry.location) {
    const container = instance.getReferenceByName?.(entry.location);
    return container?.getArray?.(entry.name) || null;
  }
  const regMethod = entry.registration || "addArray";
  const getter = `get${regMethod.substring(3)}`;
  return typeof instance[getter] === "function" ? instance[getter]() : null;
}

export function bindArrayEntry(instance, entry, values) {
  const previousArray = findPreviousArray(instance, entry);
  if (previousArray) {
    if (previousArray.getData() !== values) {
      previousArray.setData(values, entry.numberOfComponents);
      previousArray.modified?.();
      instance.modified?.();
    }
    return previousArray;
  }

  const regMethod = entry.registration || "addArray";
  const location = entry.location
    ? instance.getReferenceByName?.(entry.location)
    : instance;
  if (!location || typeof location[regMethod] !== "function") {
    throw new Error(
      `cannot register array (location=${entry.location}, ` +
        `registration=${regMethod})`,
    );
  }

  const vtkClass = entry.vtkClass || "vtkDataArray";
  const arrayClass = ARRAY_CLASSES[vtkClass];
  if (!arrayClass) {
    throw new Error(`unknown array class ${vtkClass}`);
  }
  // _-prefixed fields are engine bookkeeping, not constructor props.
  /* eslint-disable no-unused-vars */
  const {
    ref: _ref,
    registration: _registration,
    location: _location,
    vtkClass: _vtkClass,
    ...constructorProps
  } = entry;
  /* eslint-enable no-unused-vars */
  const array = arrayClass.newInstance({ ...constructorProps, values });
  location[regMethod](array);
  array.modified?.();
  location.modified?.();
  instance.modified?.();
  return array;
}

// An array key left the node. Field arrays are removed from their container;
// topology arrays have no unset call, so the bound array collapses to empty.
export function removeArrayEntry(instance, entry) {
  if (entry.location) {
    const container = instance.getReferenceByName?.(entry.location);
    if (container?.getArray?.(entry.name)) {
      container.removeArray(entry.name);
      container.modified?.();
      instance.modified?.();
    }
    return;
  }
  const previousArray = findPreviousArray(instance, entry);
  if (previousArray) {
    const Ctor = typedArrayConstructor(entry.dataType);
    previousArray.setData(new Ctor(0), entry.numberOfComponents || 1);
    previousArray.modified?.();
    instance.modified?.();
  }
}
