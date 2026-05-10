/**
 * Validation utilities for synchronous sync operations.
 * Used to verify that state has all required inline array data.
 */

import { walkArrayDescriptors } from "./walk";

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
  walkArrayDescriptors(state, {
    onDescriptor(descriptor) {
      if (descriptor.content != null) {
        inlineHashes.add(descriptor.hash);
      }
    },
  });

  return walkArrayDescriptors(state, {
    onDescriptor(descriptor) {
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
    },
  });
}

export default {
  allArraysHaveInlineData,
};
