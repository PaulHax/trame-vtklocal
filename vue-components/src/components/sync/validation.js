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

  function isArrayDescriptor(value) {
    return (
      value &&
      typeof value === "object" &&
      value.hash !== undefined &&
      value.dataType !== undefined
    );
  }

  function isBinaryLike(value) {
    return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
  }

  function visitArrayDescriptors(value, callback) {
    if (!value || typeof value !== "object" || isBinaryLike(value)) {
      return true;
    }

    if (Array.isArray(value)) {
      return value.every((item) => visitArrayDescriptors(item, callback));
    }

    if (isArrayDescriptor(value)) {
      return callback(value) !== false;
    }

    return Object.values(value).every((child) =>
      visitArrayDescriptors(child, callback),
    );
  }

  visitArrayDescriptors(state, (descriptor) => {
    if (descriptor.content != null) {
      inlineHashes.add(descriptor.hash);
    }
    return true;
  });

  return visitArrayDescriptors(state, (descriptor) => {
    if (
      descriptor.content == null &&
      !inlineHashes.has(descriptor.hash) &&
      !pushCache?.has(descriptor.hash)
    ) {
      console.warn(
        "[validation] Missing array:",
        descriptor.hash,
        "name:",
        descriptor.name,
      );
      return false;
    }
    return true;
  });
}

export default {
  allArraysHaveInlineData,
};
