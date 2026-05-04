/**
 * Validation utilities for synchronous sync operations.
 * Used to verify that state has all required inline array data.
 */

/**
 * Check if every array referenced by state has either an inline `content`
 * payload or a previously cached entry in `pushCache`.
 *
 * @param {Object} state     translated scene state
 * @param {Map}    pushCache Map<hash, TypedArray> for previously cached arrays
 * @returns {boolean} true when every array is resolvable
 */
export function allArraysHaveInlineData(state, pushCache) {
  const inlineHashes = new Set();

  function collectInlineHashes(obj) {
    if (!obj || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      obj.forEach((item) => collectInlineHashes(item));
      return;
    }

    if (obj.hash && obj.dataType && obj.content != null) {
      inlineHashes.add(obj.hash);
    }

    if (obj.properties) {
      Object.values(obj.properties).forEach((value) => collectInlineHashes(value));
    }

    if (obj.dependencies) {
      obj.dependencies.forEach((dep) => collectInlineHashes(dep));
    }

    if (obj.arrays) {
      Object.values(obj.arrays).forEach((arr) => collectInlineHashes(arr));
    }
  }

  function checkObj(obj) {
    if (!obj || typeof obj !== 'object') return true;

    if (Array.isArray(obj)) {
      return obj.every((item) => checkObj(item));
    }

    if (obj.hash && obj.dataType) {
      if (
        obj.content == null &&
        !inlineHashes.has(obj.hash) &&
        !pushCache?.has(obj.hash)
      ) {
        console.warn('[validation] Missing array:', obj.hash, 'name:', obj.name);
        return false;
      }
    }

    if (obj.properties) {
      const propsValid = Object.values(obj.properties).every((value) =>
        checkObj(value)
      );
      if (!propsValid) return false;
    }

    if (obj.dependencies) {
      const depsValid = obj.dependencies.every((dep) => checkObj(dep));
      if (!depsValid) return false;
    }

    if (obj.arrays) {
      const arraysValid = Object.values(obj.arrays).every((arr) =>
        checkObj(arr)
      );
      if (!arraysValid) return false;
    }

    return true;
  }

  collectInlineHashes(state);
  return checkObj(state);
}

export default {
  allArraysHaveInlineData,
};
