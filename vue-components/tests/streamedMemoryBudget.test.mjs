import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(closeModuleLoader);

test("an explicit memory allowance stays shared across views", async () => {
  const { createStreamedSceneHost } = await loadModule(
    "/src/components/streamedSceneHost.js",
  );
  const totalBytes = 4 * 1024 ** 3;
  const options = { streamedMemoryBudgetBytes: totalBytes, workers: {} };
  const one = createStreamedSceneHost(options);
  const two = createStreamedSceneHost(options);
  assert.equal(one.describe().pageMemory.totalBytes, totalBytes);
  assert.equal(two.describe().pageMemory.totalBytes, totalBytes);
  assert.throws(
    () => createStreamedSceneHost({ ...options, streamedMemoryBudgetBytes: 1 }),
    /same streamedMemoryBudgetBytes/,
  );
  for (const value of [0, -1, 1.5, Infinity]) {
    assert.throws(
      () =>
        createStreamedSceneHost({
          ...options,
          streamedMemoryBudgetBytes: value,
        }),
      /positive safe integer/,
    );
  }
  one.dispose();
  two.dispose();
});
