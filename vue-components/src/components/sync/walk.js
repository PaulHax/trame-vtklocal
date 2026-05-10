/**
 * Shared descriptor-tree walker for translated scene states.
 *
 * Translated states are nested {id, type, properties, dependencies, arrays}
 * trees with array-payload "descriptor" leaves: {hash, dataType, content?}.
 * Walkers stop descending into descriptors (their `content` is binary-like)
 * and into binary-like values themselves.
 */

export function isArrayDescriptor(value) {
  return (
    value &&
    typeof value === "object" &&
    value.hash !== undefined &&
    value.dataType !== undefined
  );
}

export function isBinaryLike(value) {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

/**
 * Walk a state tree.
 *
 * - `onObject(value)` runs for every non-array, non-descriptor object before
 *   recursion. Return `false` to abort the walk early.
 * - `onDescriptor(descriptor)` runs for every array descriptor leaf. Return
 *   `false` to abort the walk early. The walk does not descend into a
 *   descriptor's properties.
 *
 * Returns `true` when the walk completed and `false` when a visitor aborted.
 */
export function walkArrayDescriptors(state, { onObject, onDescriptor } = {}) {
  function walk(value) {
    if (!value || typeof value !== "object" || isBinaryLike(value)) {
      return true;
    }
    if (Array.isArray(value)) {
      return value.every((item) => walk(item));
    }
    if (isArrayDescriptor(value)) {
      return onDescriptor ? onDescriptor(value) !== false : true;
    }
    if (onObject && onObject(value) === false) {
      return false;
    }
    return Object.values(value).every((child) => walk(child));
  }
  return walk(state);
}
