/**
 * Synchronous updater functions for state synchronization.
 * These bypass all Promise/progress machinery for use in sync render callbacks
 * (e.g., MapLibre custom layer render function).
 *
 * All arrays must have inline data (content field) for these to work.
 */

import { capitalize } from "@kitware/vtk.js/macros";
import vtkPoints from "@kitware/vtk.js/Common/Core/Points";
import vtkCellArray from "@kitware/vtk.js/Common/Core/CellArray";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import { base64ToArrayBuffer, createTypedArray } from "./base64";
import BehaviorManager from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/BehaviorManager";

// ----------------------------------------------------------------------------
// Internal helpers (copied from ObjectManager to avoid circular deps)
// ----------------------------------------------------------------------------

const WRAPPED_ID_RE = /instance:\${([^}]+)}/;
const WRAP_ID = (id) => `instance:$\{${id}}`;
const SKIPPED_INSTANCE_IDS = new Set();
const EXCLUDE_INSTANCE_MAP = {};

const DATA_ARRAY_MAPPER = {
  vtkPoints,
  vtkCellArray,
  vtkDataArray,
};

export function isLiveInstance(instance) {
  return !!instance && !(typeof instance.isDeleted === "function" && instance.isDeleted());
}

function getOrPurgeInstance(context, id) {
  const instance = context.getInstance(id);
  if (!isLiveInstance(instance)) {
    if (instance) {
      context.unregisterInstance?.(id);
    }
    return null;
  }
  return instance;
}

function getDataArrayMapper() {
  return DATA_ARRAY_MAPPER;
}

function extractCallArgs(synchronizerContext, argList) {
  return argList.map((arg) => {
    const m = WRAPPED_ID_RE.exec(arg);
    if (m) {
      return synchronizerContext.getInstance(m[1]);
    }
    return arg;
  });
}

function extractInstanceIds(argList) {
  return argList
    .map((arg) => WRAPPED_ID_RE.exec(arg))
    .filter((m) => m)
    .map((m) => m[1]);
}

function notSkippedInstance(call) {
  if (call[1].length === 1) {
    return !SKIPPED_INSTANCE_IDS.has(call[1][0]);
  }
  for (let i = 0; i < call[1].length; i++) {
    if (!SKIPPED_INSTANCE_IDS.has(call[1][i])) return true;
  }
  return false;
}

function bindArrays(arraysToBind) {
  while (arraysToBind.length) {
    const [fn, args] = arraysToBind.shift();
    fn(...args);
  }
}

function createNewArrayHandler(instance, arrayMetadata, arraysToBind) {
  return (values) => {
    const regMethod = arrayMetadata.registration
      ? arrayMetadata.registration
      : "addArray";
    const location = arrayMetadata.location
      ? instance.getReferenceByName(arrayMetadata.location)
      : instance;

    // Try to prevent unnecessary modified
    let previousArray = null;
    if (arrayMetadata.location) {
      previousArray = instance
        .getReferenceByName(arrayMetadata.location)
        .getArray(arrayMetadata.name);
    } else {
      previousArray = instance[`get${regMethod.substring(3)}`]();
    }

    if (previousArray) {
      if (previousArray.getData() !== values) {
        arraysToBind.push([
          previousArray.setData,
          [values, arrayMetadata.numberOfComponents],
        ]);
      }
      return previousArray;
    }

    const vtkClass = arrayMetadata.vtkClass
      ? arrayMetadata.vtkClass
      : "vtkDataArray";
    // Filter out metadata fields that shouldn't be passed to the constructor
    /* eslint-disable no-unused-vars */
    const {
      content: _content,
      hash: _hash,
      registration: _registration,
      location: _location,
      ranges: _ranges,
      vtkClass: _vtkClass,
      ...constructorProps
    } = arrayMetadata;
    /* eslint-enable no-unused-vars */

    const dataArrayMapper = getDataArrayMapper();
    const array = dataArrayMapper[vtkClass].newInstance({
      ...constructorProps,
      values,
    });

    arraysToBind.push([location[regMethod], [array]]);
    return array;
  };
}

function removeUnavailableArrays(fields, availableNames) {
  const namesToDelete = [];
  const size = fields.getNumberOfArrays();
  for (let i = 0; i < size; i++) {
    const array = fields.getArray(i);
    const name = array.getName();
    if (!availableNames.has(name)) {
      namesToDelete.push(name);
    }
  }
  for (let i = 0; i < namesToDelete.length; i++) {
    fields.removeArray(namesToDelete[i]);
  }
}

function getArrayKey(arrayMeta) {
  const namePart = arrayMeta.name ? `_${arrayMeta.name}` : "";
  return `${arrayMeta.hash}_${arrayMeta.dataType}${namePart}`;
}

function isInlineArrayMetadata(value) {
  return (
    value &&
    typeof value === "object" &&
    value.content != null &&
    value.hash !== undefined &&
    value.dataType !== undefined
  );
}

function storeInlineArray(arrayMetadata, context, inlineValues, options) {
  const { stripInlineData } = options;
  const hash = arrayMetadata.hash;
  if (!hash) {
    return;
  }

  let values = inlineValues.get(hash);
  if (!values) {
    // Handle both binary (ArrayBuffer/Uint8Array) and base64 string
    const content = arrayMetadata.content;
    let buffer;
    if (content instanceof ArrayBuffer) {
      buffer = content;
    } else if (ArrayBuffer.isView(content)) {
      buffer = content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength
      );
    } else {
      buffer = base64ToArrayBuffer(content);
    }
    values = createTypedArray(arrayMetadata.dataType, buffer);
    inlineValues.set(hash, values);
  }

  if (context?.cacheArray) {
    context.cacheArray(hash, values, context);
  }

  if (stripInlineData) {
    delete arrayMetadata.content;
  }
}

function isArrayDescriptor(value) {
  return (
    value &&
    typeof value === "object" &&
    value.hash !== undefined &&
    value.dataType !== undefined
  );
}

function populateFromCache(value, context, inlineValues) {
  if (!context?.getCachedArray || !isArrayDescriptor(value)) return;
  if (value.content != null || inlineValues.has(value.hash)) return;
  const cached = context.getCachedArray(value.hash, context);
  if (cached) {
    inlineValues.set(value.hash, cached);
  }
}

function extractInlineArrays(state, context, inlineValues, options = {}) {
  const resolvedInlineValues = inlineValues || new Map();
  if (!state) {
    return resolvedInlineValues;
  }

  const { stripInlineData = true } = options;
  const extractFromValue = (value) => {
    if (Array.isArray(value)) {
      value.forEach((item) => extractFromValue(item));
      return;
    }
    if (isInlineArrayMetadata(value)) {
      storeInlineArray(value, context, resolvedInlineValues, {
        stripInlineData,
      });
    } else {
      populateFromCache(value, context, resolvedInlineValues);
    }
  };

  if (state.arrays) {
    Object.values(state.arrays).forEach((arrayMetadata) => {
      if (isInlineArrayMetadata(arrayMetadata)) {
        storeInlineArray(arrayMetadata, context, resolvedInlineValues, {
          stripInlineData,
        });
      } else {
        populateFromCache(arrayMetadata, context, resolvedInlineValues);
      }
    });
  }

  if (state.properties) {
    Object.values(state.properties).forEach((value) => {
      extractFromValue(value);
    });
  }

  if (state.dependencies) {
    state.dependencies.forEach((childState) => {
      extractInlineArrays(childState, context, resolvedInlineValues, {
        stripInlineData,
      });
    });
  }

  return resolvedInlineValues;
}

// ----------------------------------------------------------------------------
// Sync updater registry
// ----------------------------------------------------------------------------

const SYNC_UPDATERS = {};

export function registerSyncUpdater(type, updater) {
  SYNC_UPDATERS[type] = updater;
}

export function getSyncUpdater(type) {
  return SYNC_UPDATERS[type];
}

// ----------------------------------------------------------------------------
// Core sync updater functions
// ----------------------------------------------------------------------------

/**
 * Synchronous generic updater - applies properties, dependencies, and arrays
 * without any async operations. All arrays must have inline data.
 */
export function genericUpdaterSync(
  instance,
  state,
  context,
  objectManager,
  inlineValues
) {
  if (!isLiveInstance(instance)) {
    return;
  }

  if (state.properties) {
    instance.set(state.properties);
  }

  // Now handle dependencies synchronously
  if (state.dependencies) {
    state.dependencies.forEach((childState) => {
      const { id, type } = childState;

      if (EXCLUDE_INSTANCE_MAP[type]) {
        const { key, value } = EXCLUDE_INSTANCE_MAP[type];
        if (!key || childState.properties[key] === value) {
          SKIPPED_INSTANCE_IDS.add(WRAP_ID(id));
          return;
        }
      }

      let childInstance = getOrPurgeInstance(context, id);
      if (!childInstance) {
        // Need objectManager to build new instances
        if (objectManager && objectManager.build) {
          childInstance = objectManager.build(type, { managedInstanceId: id });
          context.registerInstance(id, childInstance);
        } else {
          console.warn(
            `Cannot build instance of type ${type} - no objectManager provided`
          );
          return;
        }
      }
      // Use type-specific sync updater if available, otherwise recurse
      const syncUpdater = SYNC_UPDATERS[type];
      if (syncUpdater) {
        syncUpdater(
          childInstance,
          childState,
          context,
          objectManager,
          inlineValues
        );
      } else {
        genericUpdaterSync(
          childInstance,
          childState,
          context,
          objectManager,
          inlineValues
        );
      }
    });
  }

  // Apply method calls (already sync)
  if (state.calls) {
    state.calls.filter(notSkippedInstance).forEach((call) => {
      instance[call[0]].apply(null, extractCallArgs(context, call[1]));
    });
  }

  // Apply arrays SYNCHRONOUSLY - the key difference from async version
  if (state.arrays) {
    const arraysToBind = [];

    Object.values(state.arrays).forEach((arrayMetadata) => {
      const hash = arrayMetadata.hash;
      let values = inlineValues?.get(hash);
      if (!values && arrayMetadata.content) {
        // Handle both binary (ArrayBuffer/Uint8Array) and base64 string
        const content = arrayMetadata.content;
        let buffer;
        if (content instanceof ArrayBuffer) {
          buffer = content;
        } else if (ArrayBuffer.isView(content)) {
          buffer = content.buffer.slice(
            content.byteOffset,
            content.byteOffset + content.byteLength
          );
        } else {
          buffer = base64ToArrayBuffer(content);
        }
        values = createTypedArray(arrayMetadata.dataType, buffer);
        if (inlineValues && hash) {
          inlineValues.set(hash, values);
        }
      }

      if (!values && context?.getCachedArray) {
        values = context.getCachedArray(hash, context);
      }

      if (!values) {
        throw new Error(
          `Array ${arrayMetadata.hash} missing inline data and not in cache. ` +
            "synchronizeSync requires all arrays to have inline data or be previously cached."
        );
      }

      // Cache for future reference
      if (context.cacheArray) {
        context.cacheArray(arrayMetadata.hash, values, context);
      }

      // Create handler and invoke immediately
      const handler = createNewArrayHandler(
        instance,
        arrayMetadata,
        arraysToBind
      );
      handler(values);
    });

    // Bind all arrays (already sync)
    if (arraysToBind.length) {
      instance.modified();
    }
    bindArrays(arraysToBind);
  }
}

/**
 * Synchronous render window update - no Promises, no progress tracking.
 * Requires all arrays to have inline data.
 */
export function updateRenderWindowSync(
  instance,
  state,
  context,
  objectManager
) {
  SKIPPED_INSTANCE_IDS.clear();
  const inlineValues = extractInlineArrays(state, context);
  cleanupRemovedRendererDependencies(state, context);

  // Apply state synchronously (skip pre-render to avoid flicker in shared contexts)
  genericUpdaterSync(instance, state, context, objectManager, inlineValues);

  // Manage any associated behaviors
  BehaviorManager.applyBehaviors(instance, state, context);
}

export function cleanupRemovedRendererDependencies(state, context) {
  if (!state?.calls) {
    return;
  }

  state.calls
    .filter(notSkippedInstance)
    .filter((call) => call[0] === "removeRenderer")
    .forEach((call) => {
      extractInstanceIds(call[1]).forEach((renId) => {
        const renderer = context.getInstance(renId);
        if (!renderer) {
          return;
        }

        const viewProps = renderer.getViewProps?.();
        if (!Array.isArray(viewProps)) {
          return;
        }

        viewProps.forEach((viewProp) => {
          const deps = viewProp?.get?.("flattenedDepIds")?.flattenedDepIds;
          if (Array.isArray(deps)) {
            deps.forEach((depId) => context.unregisterInstance(depId));
          }

          const viewPropId = context.getInstanceId(viewProp);
          if (viewPropId !== undefined) {
            context.unregisterInstance(viewPropId);
          }
        });
      });
    });
}

/**
 * Factory for creating dataset-specific sync updaters.
 * Handles the conversion of old format (points, polys, etc.) to generic state.arrays.
 */
export function createDataSetUpdateSync(piecesToFetch = []) {
  return (instance, state, context, objectManager, inlineValues) => {
    // Make sure we provide container for std arrays
    const localProperties = { ...state.properties };
    if (!state.arrays) {
      state.arrays = {};
    }

    // Array members
    // => convert old format to generic state.arrays
    for (let i = 0; i < piecesToFetch.length; i++) {
      const key = piecesToFetch[i];
      if (state.properties[key]) {
        const arrayMeta = state.properties[key];
        arrayMeta.registration = `set${capitalize(key)}`;
        const arrayKey = getArrayKey(arrayMeta);
        state.arrays[arrayKey] = arrayMeta;
        delete localProperties[key];
      }
    }

    // Extract dataset fields
    const fieldsArrays = state.properties.fields || [];
    for (let i = 0; i < fieldsArrays.length; i++) {
      const arrayMeta = fieldsArrays[i];
      const arrayKey = getArrayKey(arrayMeta);
      state.arrays[arrayKey] = arrayMeta;
    }
    delete localProperties.fields;

    // Reset any pre-existing fields array
    const arrayToKeep = {
      pointData: new Set(),
      cellData: new Set(),
      fieldData: new Set(),
    };
    fieldsArrays.forEach(({ location, name }) => {
      arrayToKeep[location].add(name);
    });
    removeUnavailableArrays(instance.getPointData(), arrayToKeep.pointData);
    removeUnavailableArrays(instance.getCellData(), arrayToKeep.cellData);

    // Generic handling - use sync version
    const cleanState = { ...state };
    cleanState.properties = localProperties;
    genericUpdaterSync(
      instance,
      cleanState,
      context,
      objectManager,
      inlineValues
    );
  };
}

// Create dataset-specific sync updaters
export const polydataUpdaterSync = createDataSetUpdateSync([
  "points",
  "polys",
  "verts",
  "lines",
  "strips",
]);

export const imageDataUpdaterSync = createDataSetUpdateSync([]);

// Register default sync updaters
registerSyncUpdater("vtkPolyData", polydataUpdaterSync);
registerSyncUpdater("vtkImageData", imageDataUpdaterSync);

export default {
  genericUpdaterSync,
  updateRenderWindowSync,
  createDataSetUpdateSync,
  polydataUpdaterSync,
  imageDataUpdaterSync,
  registerSyncUpdater,
  getSyncUpdater,
};
