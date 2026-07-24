/**
 * Dump the client-applied scene in the flat node shape the server store
 * holds: `{ root, nodes: { id: { type, props, refs, arrays, blocks } } }`.
 *
 * The dump exists to support the push-sync oracle harness: after each step a
 * test dumps the cumulative applied state and compares it against the server
 * store snapshot. To make drift visible, values are read back from the LIVE
 * vtk.js instances wherever the instance exposes them — the mirror only
 * chooses which keys to read:
 *
 * - `props`: each mirror prop key is read from the instance model when the
 *   model has it, otherwise the mirror value is echoed.
 * - `refs`: each mirror slot is re-derived from the live wiring (getRenderers,
 *   getMapper, getInputData, ...) and mapped back to ids through the
 *   synchronizer context.
 * - `arrays`: the mirror entry (ref + metadata) plus base64 `content` of the
 *   data the bound vtk array actually holds.
 * - `blocks`: echoed from the mirror (consumed by client registries; there is
 *   no instance-side readback).
 */

import { isLiveInstance } from "./predicates";

const SINGLE_REF_GETTERS = {
  activeCamera: "getActiveCamera",
  mapper: "getMapper",
  property: "getProperty",
  lookupTable: "getLookupTable",
};

const LIST_REF_GETTERS = {
  renderers: "getRenderers",
  viewProps: "getViewProps",
  lights: "getLights",
  textures: "getTextures",
};

const INDEXED_REF_GETTERS = {
  rgbTransferFunction: "getRGBTransferFunction",
  grayTransferFunction: "getGrayTransferFunction",
  scalarOpacity: "getScalarOpacity",
};

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

function plainValue(value) {
  if (isTypedArray(value)) {
    return Array.from(value, Number);
  }
  if (Array.isArray(value)) {
    return value.map(plainValue);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = plainValue(child);
    }
    return out;
  }
  return value;
}

function dumpProps(instance, mirrorProps) {
  const model = typeof instance?.get === "function" ? instance.get() : null;
  const props = {};
  for (const [key, mirrorValue] of Object.entries(mirrorProps)) {
    const fromInstance =
      model && key in model && typeof model[key] !== "function"
        ? model[key]
        : undefined;
    props[key] = plainValue(
      fromInstance !== undefined ? fromInstance : mirrorValue,
    );
  }
  return props;
}

function instanceId(synchronizerContext, instance) {
  if (!instance) return null;
  const id = synchronizerContext.getInstanceId?.(instance);
  return id === undefined || id === null ? null : String(id);
}

function dumpRefs(instance, mirrorRefs, synchronizerContext) {
  const refs = {};
  for (const [slot, mirrorValue] of Object.entries(mirrorRefs)) {
    const singleGetter = SINGLE_REF_GETTERS[slot];
    if (singleGetter) {
      const child =
        typeof instance?.[singleGetter] === "function"
          ? instance[singleGetter]()
          : null;
      refs[slot] = instanceId(synchronizerContext, child) ?? mirrorValue;
      continue;
    }

    const listGetter = LIST_REF_GETTERS[slot];
    if (listGetter) {
      const children =
        typeof instance?.[listGetter] === "function"
          ? instance[listGetter]() || []
          : null;
      refs[slot] = children
        ? children
            .map((child) => instanceId(synchronizerContext, child))
            .filter((id) => id !== null)
        : [...mirrorValue];
      continue;
    }

    const indexedGetter = INDEXED_REF_GETTERS[slot];
    if (indexedGetter) {
      const ids = mirrorValue.map((mirrorId, index) => {
        const child =
          typeof instance?.[indexedGetter] === "function"
            ? instance[indexedGetter](index)
            : null;
        return instanceId(synchronizerContext, child) ?? mirrorId;
      });
      refs[slot] = ids;
      continue;
    }

    if (slot === "inputs") {
      refs[slot] = mirrorValue.map((mirrorId, port) => {
        const dataset =
          typeof instance?.getInputData === "function"
            ? instance.getInputData(port)
            : null;
        return instanceId(synchronizerContext, dataset) ?? mirrorId;
      });
      continue;
    }

    refs[slot] = plainValue(mirrorValue);
  }
  return refs;
}

function dumpArrays(nodeId, mirrorArrays, getBoundArray) {
  const arrays = {};
  for (const [key, entry] of Object.entries(mirrorArrays)) {
    const dumped = plainValue(entry);
    const bound = getBoundArray?.(nodeId, key);
    const data = bound?.getData?.();
    if (isTypedArray(data)) {
      dumped.content = bytesToBase64(data);
    }
    arrays[key] = dumped;
  }
  return arrays;
}

/**
 * @param {string} rootId       the render-window node id
 * @param {Object} mirror       the engine mirror store (id -> node)
 * @param {Object} synchronizerContext
 * @param {Function} [getBoundArray]  (nodeId, key) -> bound vtk data array
 */
export function dumpAppliedScene(
  rootId,
  mirror,
  synchronizerContext,
  getBoundArray = null,
) {
  if (!mirror || !synchronizerContext) return null;

  const nodes = {};
  for (const [id, node] of mirror.entries()) {
    const registered = synchronizerContext.getInstance?.(id) ?? null;
    const instance = isLiveInstance(registered) ? registered : null;
    const dumped = { type: node.type };
    if (node.props) {
      dumped.props = dumpProps(instance, node.props);
    }
    if (node.refs) {
      dumped.refs = dumpRefs(instance, node.refs, synchronizerContext);
    }
    if (node.arrays) {
      dumped.arrays = dumpArrays(id, node.arrays, getBoundArray);
    }
    if (node.blocks) {
      dumped.blocks = plainValue(node.blocks);
    }
    nodes[id] = dumped;
  }

  return { root: String(rootId), nodes };
}
