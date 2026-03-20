/**
 * Base64 decoding utilities for inline array data in synchronous sync operations.
 */
import { TYPED_ARRAYS } from "@kitware/vtk.js/macros";

export function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export function createTypedArray(dataType, buffer) {
  const TypedArrayClass = TYPED_ARRAYS[dataType] || Float32Array;
  return new TypedArrayClass(buffer);
}

export default {
  base64ToArrayBuffer,
  createTypedArray,
};
