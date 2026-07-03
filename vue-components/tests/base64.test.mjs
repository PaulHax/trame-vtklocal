import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

function unalignedFloat32View(values) {
  const bytes = new Uint8Array(1 + values.length * 4);
  const view = new Float32Array(values);
  bytes.set(new Uint8Array(view.buffer), 1);
  return new Uint8Array(bytes.buffer, 1, values.length * 4);
}

function alignedFloat32View(values) {
  const buffer = new ArrayBuffer(values.length * 4);
  new Float32Array(buffer).set(values);
  return new Uint8Array(buffer);
}

test("viewAsTypedArray aliases an aligned ArrayBuffer view", async () => {
  const { viewAsTypedArray } = await loadModule(
    "/src/components/sync/base64.js",
  );

  const view = alignedFloat32View([1.5, 2.25, 3.125]);
  const result = viewAsTypedArray(view, "Float32Array");

  assert.equal(result.constructor.name, "Float32Array");
  assert.equal(result.buffer, view.buffer);
  assert.deepEqual(Array.from(result), [1.5, 2.25, 3.125]);
});

test("viewAsTypedArray copies an unaligned ArrayBuffer view", async () => {
  const { viewAsTypedArray } = await loadModule(
    "/src/components/sync/base64.js",
  );

  const view = unalignedFloat32View([1.5, 2.25, 3.125]);
  assert.notEqual(view.byteOffset % 4, 0);

  const result = viewAsTypedArray(view, "Float32Array");

  assert.equal(result.constructor.name, "Float32Array");
  assert.notEqual(result.buffer, view.buffer);
  assert.deepEqual(Array.from(result), [1.5, 2.25, 3.125]);
});

test("viewAsTypedArray accepts ArrayBuffer / base64 / array inputs", async () => {
  const { viewAsTypedArray } = await loadModule(
    "/src/components/sync/base64.js",
  );

  const buffer = new ArrayBuffer(8);
  new Float32Array(buffer).set([7, 8]);
  assert.deepEqual(
    Array.from(viewAsTypedArray(buffer, "Float32Array")),
    [7, 8],
  );

  const base64 = Buffer.from(new Float32Array([9, 10]).buffer).toString(
    "base64",
  );
  assert.deepEqual(
    Array.from(viewAsTypedArray(base64, "Float32Array")),
    [9, 10],
  );

  assert.deepEqual(
    Array.from(viewAsTypedArray([1, 2, 3], "Float32Array")),
    [1, 2, 3],
  );
});

test("viewAsTypedArray with copy:true does not alias an aligned ArrayBuffer view", async () => {
  const { viewAsTypedArray } = await loadModule(
    "/src/components/sync/base64.js",
  );

  const view = alignedFloat32View([1.5, 2.25, 3.125]);
  const result = viewAsTypedArray(view, "Float32Array", { copy: true });

  assert.notEqual(result.buffer, view.buffer);
  assert.deepEqual(Array.from(result), [1.5, 2.25, 3.125]);
});
