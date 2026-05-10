/**
 * Synchronous updater functions for state synchronization.
 * These bypass all Promise/progress machinery for use in sync render callbacks
 * (e.g., MapLibre custom layer render function).
 *
 * The push cache is a flat `Map<hash, TypedArray>` owned by the caller.
 * Every array referenced by a state must be present in that map (either
 * carried over from a previous push or extracted from the current delta's
 * inline content).
 */

import { capitalize } from "@kitware/vtk.js/macros";
import vtkPoints from "@kitware/vtk.js/Common/Core/Points";
import vtkCellArray from "@kitware/vtk.js/Common/Core/CellArray";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import { viewAsTypedArray } from "./base64";
import { walkArrayDescriptors } from "./walk";
import BehaviorManager from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/BehaviorManager";

// ----------------------------------------------------------------------------
// Internal helpers (copied from ObjectManager to avoid circular deps)
// ----------------------------------------------------------------------------

const WRAPPED_ID_RE = /instance:\${([^}]+)}/;
const SKIPPED_INSTANCE_IDS = new Set();

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
    arraysToBind.shift()();
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
        arraysToBind.push(() => {
          previousArray.setData(values, arrayMetadata.numberOfComponents);
          previousArray.modified?.();
          instance.modified?.();
        });
      }
      return previousArray;
    }

    const vtkClass = arrayMetadata.vtkClass
      ? arrayMetadata.vtkClass
      : "vtkDataArray";
    // _-prefixed fields are stripped by the constructor; we collect the rest.
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

    arraysToBind.push(() => {
      location[regMethod](array);
      array.modified?.();
      location.modified?.();
      instance.modified?.();
    });
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

function inlineContentToTypedArray(arrayMetadata) {
  // Inline payloads are cached in pushCache for the lifetime of the session;
  // copy so the msgpack receive buffer can be GC'd and so cache consumers
  // can mutate without poisoning the original network payload.
  return viewAsTypedArray(arrayMetadata.content, arrayMetadata.dataType, {
    copy: true,
  });
}

function storeInlineArray(arrayMetadata, pushCache, options) {
  const { stripInlineData } = options;
  const hash = arrayMetadata.hash;
  if (!hash) {
    return;
  }

  pushCache.set(hash, inlineContentToTypedArray(arrayMetadata));

  if (stripInlineData) {
    delete arrayMetadata.content;
  }
}

/**
 * Walk a state tree and copy any inline array payloads into `pushCache`.
 * After this returns, `pushCache` contains every hash whose payload was
 * inlined in this delta (plus whatever was already in it).
 *
 * @param {Object} state         translated scene state
 * @param {Map}    pushCache     hash -> TypedArray map; mutated in place
 * @param {Object} [options]
 * @param {boolean} [options.stripInlineData=true] strip `content` after caching
 * @returns {Map} the same `pushCache` reference
 */
export function extractInlineArrays(state, pushCache, options = {}) {
  if (!pushCache) {
    return pushCache;
  }
  if (!state) {
    return pushCache;
  }

  const { stripInlineData = true } = options;
  walkArrayDescriptors(state, {
    onDescriptor(descriptor) {
      if (isInlineArrayMetadata(descriptor)) {
        storeInlineArray(descriptor, pushCache, { stripInlineData });
      }
    },
  });
  return pushCache;
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
 * without any async operations. Every array referenced by `state` must be
 * present in `pushCache`.
 */
export function genericUpdaterSync(
  instance,
  state,
  context,
  objectManager,
  pushCache
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
          pushCache
        );
      } else {
        genericUpdaterSync(
          childInstance,
          childState,
          context,
          objectManager,
          pushCache
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

  // Apply arrays SYNCHRONOUSLY - every value must be in pushCache.
  if (state.arrays) {
    const arraysToBind = [];

    Object.values(state.arrays).forEach((arrayMetadata) => {
      const hash = arrayMetadata.hash;
      const values = pushCache?.get(hash);

      if (!values) {
        throw new Error(
          `Array ${hash} missing from push cache. ` +
            "The server must inline payloads for hashes the client has not yet received."
        );
      }

      // Create handler and invoke immediately
      const handler = createNewArrayHandler(
        instance,
        arrayMetadata,
        arraysToBind
      );
      handler(values);
    });

    bindArrays(arraysToBind);
  }
}

/**
 * Synchronous render window update. Caller must have populated `pushCache`
 * with every hash referenced by `state`.
 */
export function updateRenderWindowSync(
  instance,
  state,
  context,
  objectManager,
  pushCache
) {
  SKIPPED_INSTANCE_IDS.clear();
  cleanupRemovedRendererDependencies(state, context);

  // Apply state synchronously (skip pre-render to avoid flicker in shared contexts)
  genericUpdaterSync(instance, state, context, objectManager, pushCache);

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
  return (instance, state, context, objectManager, pushCache) => {
    const localProperties = { ...state.properties };
    const localArrays = { ...(state.arrays || {}) };

    for (let i = 0; i < piecesToFetch.length; i++) {
      const key = piecesToFetch[i];
      if (state.properties[key]) {
        const arrayMeta = {
          ...state.properties[key],
          registration: `set${capitalize(key)}`,
        };
        const arrayKey = getArrayKey(arrayMeta);
        localArrays[arrayKey] = arrayMeta;
        delete localProperties[key];
      }
    }

    const fieldsArrays = state.properties.fields || [];
    for (let i = 0; i < fieldsArrays.length; i++) {
      const arrayMeta = fieldsArrays[i];
      const arrayKey = getArrayKey(arrayMeta);
      localArrays[arrayKey] = arrayMeta;
    }
    delete localProperties.fields;

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

    const cleanState = {
      ...state,
      properties: localProperties,
      arrays: localArrays,
    };
    genericUpdaterSync(
      instance,
      cleanState,
      context,
      objectManager,
      pushCache
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
