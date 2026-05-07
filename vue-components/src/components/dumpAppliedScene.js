/**
 * Walk a live ``vtk.js`` ``synchronizerContext`` starting from the render
 * window id and produce a nested-tree state in the same shape the Python
 * ``vtkjs_translator.translate_scene`` emits server-side.
 *
 * The dump exists to support the push-sync JS-oracle harness: a pytest test
 * dumps the cumulative client-applied state after each oracle step, then
 * compares it against the server's shadow snapshot using
 * ``tests/push_oracle/normalize.py``. Drift between this dump and
 * ``translate_scene`` is a mismatch the harness will report.
 *
 * The static lookup tables (skip lists, class-name mapping, dependency
 * relations, polydata array config) are imported from the generated
 * translation schema. Imperative special cases mirror Python source by
 * comment.
 *
 * Bytes for arrays are inlined as base64 in ``descriptor.content`` so that
 * the comparator's ``inline_resolver`` can return raw bytes without consulting
 * a hash registry. The dump never computes md5 / synthetic hashes; the bytes
 * themselves are the comparison key.
 */

import {
  CLASS_NAME_MAP,
  COLLECTION_TYPES,
  SKIP_TYPES,
  PROPERTY_RELATIONS,
  SKIP_PROPERTIES,
  RENDERWINDOW_SKIP_PROPERTIES,
  RENDERER_SKIP_PROPERTIES,
  LOOKUPTABLE_SKIP_PROPERTIES,
  MAPPER_SKIP_PROPERTIES,
  PROPERTY_SKIP_PROPERTIES,
  CAMERA_PROPERTIES,
  VTK_LIGHT_TYPE_MAP,
} from "./generated/translationSchema";

const TYPED_ARRAY_NAMES = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

function wrapId(id) {
  return `instance:\${${id}}`;
}

function isVtkInstance(value) {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.getClassName === "function" &&
    typeof value.isDeleted === "function"
  );
}

function isLiveInstance(instance) {
  return !!instance && !(instance.isDeleted?.() === true);
}

function isTypedArray(value) {
  if (!value) return false;
  return TYPED_ARRAY_NAMES.has(value.constructor?.name);
}

function bytesToBase64(arrayBufferView) {
  const bytes = new Uint8Array(
    arrayBufferView.buffer,
    arrayBufferView.byteOffset,
    arrayBufferView.byteLength,
  );
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + chunk, bytes.length)),
    );
  }
  // btoa is available in browser + node 16+
  return btoa(binary);
}

function descriptorForTypedArray(values, opts = {}) {
  const dataType = values.constructor.name;
  const numberOfComponents = opts.numberOfComponents ?? 1;
  return {
    dataType,
    numberOfComponents,
    size: values.length,
    name: opts.name ?? "",
    ...(opts.vtkClass ? { vtkClass: opts.vtkClass } : {}),
    content: bytesToBase64(values),
  };
}

function getInstanceClassMapped(instance) {
  const className = instance.getClassName?.();
  if (!className) return null;
  return CLASS_NAME_MAP[className] || className;
}

function getterFor(propertyName) {
  if (!propertyName) return null;
  return `get${propertyName}`;
}

function readProperties(instance, type) {
  if (typeof instance.get !== "function") {
    return {};
  }
  const model = instance.get();
  const out = {};
  for (const [key, value] of Object.entries(model)) {
    if (SKIP_PROPERTIES.has(key)) continue;
    if (type === "vtkRenderWindow" && RENDERWINDOW_SKIP_PROPERTIES.has(key))
      continue;
    if (type === "vtkRenderer" && RENDERER_SKIP_PROPERTIES.has(key)) continue;
    if (type === "vtkLookupTable" && LOOKUPTABLE_SKIP_PROPERTIES.has(key))
      continue;
    if (type === "vtkMapper" && MAPPER_SKIP_PROPERTIES.has(key)) continue;
    if (type === "vtkProperty" && PROPERTY_SKIP_PROPERTIES.has(key)) continue;
    if (type === "vtkCamera" && !CAMERA_PROPERTIES.has(key)) continue;

    if (isVtkInstance(value)) continue;
    if (Array.isArray(value) && value.some(isVtkInstance)) continue;
    if (typeof value === "function") continue;

    out[key] = value;
  }
  return out;
}

function applyClassSpecificPropertyTransforms(type, props, state) {
  // Mirror vtkjs_translator behavior: emit background as 4-component with
  // alpha merged from BackgroundAlpha (vtkjs_translator.py line ~805).
  if (type === "vtkRenderer") {
    const bg = props.background;
    if (Array.isArray(bg) && bg.length === 3) {
      const alpha = state.backgroundAlpha;
      props.background = [bg[0], bg[1], bg[2], alpha ?? 1.0];
    }
  }

  // vtkjs_translator.py line ~799: convert integer light type to vtk.js string.
  if (type === "vtkLight" && typeof props.lightType === "number") {
    props.lightType = VTK_LIGHT_TYPE_MAP[String(props.lightType)] || "HeadLight";
  }
}

function dumpDescriptorFromVtkArray(vtkArr, opts = {}) {
  if (!vtkArr) return null;
  const data = vtkArr.getData?.();
  if (!isTypedArray(data)) return null;
  return descriptorForTypedArray(data, {
    numberOfComponents:
      opts.numberOfComponents ?? vtkArr.getNumberOfComponents?.() ?? 1,
    name: opts.name ?? vtkArr.getName?.() ?? "",
    vtkClass: opts.vtkClass,
  });
}

function dumpPolydataArrays(instance) {
  // Mirror _translate_polydata in vtkjs_translator.py.
  const arrays = {};
  const points = instance.getPoints?.();
  const pointsDescriptor = dumpDescriptorFromVtkArray(points, {
    numberOfComponents: 3,
    name: "Coordinates",
    vtkClass: "vtkPoints",
  });
  if (pointsDescriptor) {
    arrays.points = pointsDescriptor;
  }

  const cellGetters = [
    ["polys", "getPolys"],
    ["lines", "getLines"],
    ["verts", "getVerts"],
    ["strips", "getStrips"],
  ];
  for (const [propName, getter] of cellGetters) {
    const cellArray = instance[getter]?.();
    if (!cellArray) continue;
    const descriptor = dumpDescriptorFromVtkArray(cellArray, {
      numberOfComponents: 1,
      name: propName,
      vtkClass: "vtkCellArray",
    });
    if (descriptor && descriptor.size > 0) {
      arrays[propName] = descriptor;
    }
  }
  return arrays;
}

function dumpPolydataFields(instance) {
  // Mirror _extract_field_arrays in vtkjs_translator.py:
  // walk pointData/cellData/fieldData and emit one descriptor per array.
  const fields = [];
  const sources = [
    ["pointData", instance.getPointData?.(), {
      Scalars: "setScalars",
      Vectors: "setVectors",
      Normals: "setNormals",
      TCoords: "setTCoords",
      Tensors: "setTensors",
      GlobalIds: "setGlobalIds",
      PedigreeIds: "setPedigreeIds",
    }],
    ["cellData", instance.getCellData?.(), {
      Scalars: "setScalars",
      Vectors: "setVectors",
      Normals: "setNormals",
      TCoords: "setTCoords",
      Tensors: "setTensors",
      GlobalIds: "setGlobalIds",
      PedigreeIds: "setPedigreeIds",
    }],
    ["fieldData", instance.getFieldData?.(), {}],
  ];

  for (const [location, container, attrToReg] of sources) {
    if (!container || typeof container.getNumberOfArrays !== "function")
      continue;

    const attrMap = {};
    for (const [attrName, regMethod] of Object.entries(attrToReg)) {
      const getter = `get${attrName}`;
      if (typeof container[getter] === "function") {
        const attrArr = container[getter]();
        if (attrArr && typeof attrArr.getName === "function") {
          attrMap[attrArr.getName()] = regMethod;
        }
      }
    }

    const count = container.getNumberOfArrays();
    for (let i = 0; i < count; i += 1) {
      const arr = container.getArrayByIndex?.(i) || container.getArray?.(i);
      if (!arr) continue;
      const desc = dumpDescriptorFromVtkArray(arr, {
        numberOfComponents: arr.getNumberOfComponents?.() ?? 1,
        name: arr.getName?.() ?? "",
      });
      if (!desc) continue;
      desc.location = location;
      const name = desc.name;
      if (name && attrMap[name]) {
        desc.registration = attrMap[name];
      }
      fields.push(desc);
    }
  }
  return fields;
}

function getInstanceIdsFromCollection(collection, synchronizerContext) {
  if (!collection) return [];
  if (Array.isArray(collection)) {
    return collection
      .map((inst) => synchronizerContext.getInstanceId?.(inst))
      .filter((id) => id !== undefined && id !== null);
  }
  if (typeof collection.getNumberOfItems === "function") {
    const ids = [];
    const count = collection.getNumberOfItems();
    for (let i = 0; i < count; i += 1) {
      const item = collection.getItemAsObject?.(i);
      if (item) {
        const id = synchronizerContext.getInstanceId?.(item);
        if (id !== undefined && id !== null) ids.push(id);
      }
    }
    return ids;
  }
  return [];
}

function dumpInstance(instance, synchronizerContext, visited) {
  if (!isLiveInstance(instance)) return null;
  const id = synchronizerContext.getInstanceId?.(instance);
  if (id === undefined || id === null) return null;
  if (visited.has(id)) return null;
  visited.add(id);

  const type = getInstanceClassMapped(instance);
  if (!type) return null;
  if (SKIP_TYPES.has(type)) return null;
  if (COLLECTION_TYPES.has(type)) return null;

  const className = instance.getClassName();
  if (className === "vtkPolyData") {
    return dumpPolydata(instance, synchronizerContext, visited, id, type);
  }
  if (className.endsWith("Mapper") && !className.includes("Volume")) {
    return dumpMapper(instance, synchronizerContext, visited, id, type);
  }
  return dumpGeneric(instance, synchronizerContext, visited, id, type);
}

function dumpGeneric(instance, synchronizerContext, visited, id, type) {
  const model = typeof instance.get === "function" ? instance.get() : {};
  const props = readProperties(instance, type);
  applyClassSpecificPropertyTransforms(type, props, model);

  const dependencies = [];
  const calls = [];
  const relations = PROPERTY_RELATIONS[type] || {};

  for (const [propName, relation] of Object.entries(relations)) {
    const getter = getterFor(propName);
    const value = instance[getter]?.();
    if (value == null) continue;

    if (relation.collectionType) {
      const ids = getInstanceIdsFromCollection(value, synchronizerContext);
      for (const childId of ids) {
        const childInst = synchronizerContext.getInstance?.(childId);
        if (!childInst) continue;
        const childDump = dumpInstance(childInst, synchronizerContext, visited);
        if (childDump) dependencies.push(childDump);
        calls.push([relation.method, [wrapId(childId)]]);
      }
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((child, idx) => {
        if (!child) return;
        const childId = synchronizerContext.getInstanceId?.(child);
        if (childId === undefined || childId === null) return;
        const childDump = dumpInstance(child, synchronizerContext, visited);
        if (childDump) dependencies.push(childDump);
        const callArgs = [wrapId(childId)];
        if (relation.indexed) callArgs.unshift(idx);
        calls.push([relation.method, callArgs]);
      });
      continue;
    }

    if (isVtkInstance(value)) {
      const childId = synchronizerContext.getInstanceId?.(value);
      if (childId === undefined || childId === null) return;
      const childDump = dumpInstance(value, synchronizerContext, visited);
      if (childDump) dependencies.push(childDump);
      const callArgs = [wrapId(childId)];
      if (relation.indexed) callArgs.unshift(0);
      calls.push([relation.method, callArgs]);
    }
  }

  return {
    id: String(id),
    type,
    mtime: instance.getMTime?.() ?? 0,
    properties: props,
    dependencies,
    calls,
  };
}

function dumpMapper(instance, synchronizerContext, visited, id, type) {
  // Mirror _translate_mapper in vtkjs_translator.py.
  const props = readProperties(instance, type);
  const dependencies = [];
  const calls = [];

  // Inputs: vtk.js mappers have getInputData(port=0); we walk all input ports.
  const inputs = [];
  let port = 0;
  while (port < 8) {
    let input = null;
    try {
      input = instance.getInputData?.(port);
    } catch {
      input = null;
    }
    if (!input) break;
    inputs.push([port, input]);
    port += 1;
    if (typeof instance.getNumberOfInputPorts !== "function") break;
    if (port >= instance.getNumberOfInputPorts()) break;
  }
  for (const [portIdx, input] of inputs) {
    const inputId = synchronizerContext.getInstanceId?.(input);
    if (inputId === undefined || inputId === null) continue;
    const dep = dumpInstance(input, synchronizerContext, visited);
    if (dep) dependencies.push(dep);
    const args = [wrapId(inputId)];
    if (portIdx) args.push(portIdx);
    calls.push(["setInputData", args]);
  }

  const lut = instance.getLookupTable?.();
  if (lut) {
    const lutId = synchronizerContext.getInstanceId?.(lut);
    if (lutId !== undefined && lutId !== null) {
      const dep = dumpInstance(lut, synchronizerContext, visited);
      if (dep) dependencies.push(dep);
      calls.push(["setLookupTable", [wrapId(lutId)]]);
    }
  }

  return {
    id: String(id),
    type,
    mtime: instance.getMTime?.() ?? 0,
    properties: props,
    dependencies,
    calls,
  };
}

function dumpPolydata(instance, synchronizerContext, visited, id, type) {
  // Mirror _translate_polydata in vtkjs_translator.py.
  const props = readProperties(instance, type);
  // PolyData translation drops point/cell array refs from properties since
  // they go into descriptors below.
  delete props.points;
  delete props.polys;
  delete props.lines;
  delete props.verts;
  delete props.strips;
  delete props.pointData;
  delete props.cellData;
  delete props.fieldData;

  const arrays = dumpPolydataArrays(instance);
  Object.assign(props, arrays);

  const fields = dumpPolydataFields(instance);
  if (fields.length > 0) {
    props.fields = fields;
  }

  return {
    id: String(id),
    type,
    mtime: instance.getMTime?.() ?? 0,
    properties: props,
    dependencies: [],
    calls: [],
  };
}

/**
 * Produce a nested-tree dump rooted at ``rwId`` that mirrors the shape of
 * ``vtkjs_translator.translate_scene``. Returns ``null`` if no live instance
 * is registered for that id in the synchronizer context.
 */
export function dumpAppliedScene(rwId, synchronizerContext) {
  if (!synchronizerContext) return null;
  const root = synchronizerContext.getInstance?.(rwId);
  if (!root) return null;

  const visited = new Set();
  const dump = dumpInstance(root, synchronizerContext, visited);
  return dump;
}

export const __test = {
  bytesToBase64,
  descriptorForTypedArray,
};
