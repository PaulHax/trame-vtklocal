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

export function viewAsTypedArray(data, dataType) {
  const Ctor = TYPED_ARRAYS[dataType] || Float32Array;
  if (data instanceof ArrayBuffer) {
    return new Ctor(data);
  }
  if (ArrayBuffer.isView(data)) {
    // msgpack may place binary data at offsets that are not aligned to the
    // target element size; alias when the offset is aligned, copy otherwise.
    if (data.byteOffset % Ctor.BYTES_PER_ELEMENT === 0) {
      return new Ctor(
        data.buffer,
        data.byteOffset,
        data.byteLength / Ctor.BYTES_PER_ELEMENT,
      );
    }
    return new Ctor(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    );
  }
  if (typeof data === "string") {
    return new Ctor(base64ToArrayBuffer(data));
  }
  return new Ctor(data);
}

export default {
  base64ToArrayBuffer,
  createTypedArray,
  viewAsTypedArray,
};
