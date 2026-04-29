import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

test("installSyncArrayCache polyfills cacheArray/getCachedArray on contexts that lack them, including zero-length arrays", async () => {
  const { installSyncArrayCache } = await loadModule(
    "/src/components/vtkJsSync.js",
  );

  const calls = [];
  const context = {
    activeViewId: "rw",
    mtime: 1,
    emptyCachedArrays() {
      calls.push("empty");
    },
    freeOldArrays() {
      calls.push("free");
    },
    getActiveViewId() {
      return this.activeViewId;
    },
    getMTime() {
      return this.mtime;
    },
  };

  installSyncArrayCache(context);

  const emptyArray = new Float32Array(0);
  context.cacheArray("empty", emptyArray, context);

  assert.equal(context.getCachedArray("empty", context), emptyArray);

  context.mtime = 200;
  context.freeOldArrays(100, context);

  assert.equal(context.getCachedArray("empty", context), null);
  assert.deepEqual(calls, ["free"]);

  context.cacheArray("empty", emptyArray, context);
  context.emptyCachedArrays();

  assert.equal(context.getCachedArray("empty", context), null);
  assert.deepEqual(calls, ["free", "empty"]);
});
