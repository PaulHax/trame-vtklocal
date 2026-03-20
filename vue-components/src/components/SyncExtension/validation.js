/**
 * Validation utilities for synchronous sync operations.
 * Used to verify that state has all required inline array data.
 */

/**
 * Check if all arrays in state have inline content or are available in the cache.
 * This is required for synchronizeSync() to work.
 *
 * @param {Object} state - State object to validate
 * @param {Object} [context] - Synchronizer context with getCachedArray for cache lookups
 * @returns {boolean} - true if all arrays have inline data or are cached
 */
export function allArraysHaveInlineData(state, context) {
  function checkObj(obj) {
    if (!obj || typeof obj !== 'object') return true;

    // Check if this is an array descriptor (has hash and dataType)
    if (obj.hash && obj.dataType) {
      if (!obj.content && !context?.getCachedArray?.(obj.hash, context)) {
        console.warn('[validation] Missing array:', obj.hash, 'name:', obj.name);
        return false;
      }
    }

    // Check properties
    if (obj.properties) {
      const propsValid = Object.values(obj.properties).every((value) =>
        checkObj(value)
      );
      if (!propsValid) return false;
    }

    // Check dependencies
    if (obj.dependencies) {
      const depsValid = obj.dependencies.every((dep) => checkObj(dep));
      if (!depsValid) return false;
    }

    // Check arrays object
    if (obj.arrays) {
      const arraysValid = Object.values(obj.arrays).every((arr) =>
        checkObj(arr)
      );
      if (!arraysValid) return false;
    }

    return true;
  }

  return checkObj(state);
}

export default {
  allArraysHaveInlineData,
};
