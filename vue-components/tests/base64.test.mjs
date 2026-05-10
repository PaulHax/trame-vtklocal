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

test("applyPartialArrayUpdate applies an unaligned Float32 view", async () => {
  const { applyPartialArrayUpdate } = await loadModule(
    "/src/components/pushSync.js",
  );

  const targetValues = new Float32Array([0, 0, 0]);
  const target = {
    getData: () => targetValues,
    modified() {
      this._modifiedCount = (this._modifiedCount || 0) + 1;
    },
  };
  const points = {
    getData: () => targetValues,
    modified: target.modified,
  };
  const instance = {
    getPoints: () => points,
    modified() {},
  };
  const synchronizerContext = {
    getInstance: (id) => (id === 7 ? instance : null),
  };

  const unaligned = unalignedFloat32View([1.5, 2.25, 3.125]);
  const ok = applyPartialArrayUpdate(
    {
      instanceId: 7,
      arrayPath: "points",
      offset: 0,
      data: unaligned,
      dataType: "Float32Array",
    },
    synchronizerContext,
  );

  assert.equal(ok, true);
  assert.deepEqual(Array.from(targetValues), [1.5, 2.25, 3.125]);
});

test("extractInlineArrays caches an unaligned Float32 view as a Float32Array", async () => {
  const { extractInlineArrays } = await loadModule(
    "/src/components/sync/syncUpdaters.js",
  );

  const unaligned = unalignedFloat32View([4.5, 5.25, 6.125]);
  const state = {
    id: "rw",
    properties: {
      payload: {
        hash: "h1",
        dataType: "Float32Array",
        content: unaligned,
      },
    },
  };

  const cache = new Map();
  extractInlineArrays(state, cache, { stripInlineData: false });

  const cached = cache.get("h1");
  assert.ok(cached, "cache should contain hash h1");
  assert.equal(cached.constructor.name, "Float32Array");
  assert.deepEqual(Array.from(cached), [4.5, 5.25, 6.125]);
});
