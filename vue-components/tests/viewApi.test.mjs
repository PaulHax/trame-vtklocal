// The scene API contract: every key the view API promises must be backed by a
// real function on the scene useSceneSync returns. A key named here but never
// implemented (or later renamed on one side) makes the whole channel a silent
// no-op — `api[key] = undefined` throws nothing until a user drives it.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

async function buildScene() {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");
  const scene = useSceneSync(
    {
      client: {},
      emit() {},
      getRenderWindow: () => ({ id: "rw-view-api" }),
      renderScene() {},
    },
    {
      createManagedSyncContext: () => ({
        synchronizerContext: { getInstance: () => null },
        syncRenderWindow: { id: "sync-render-window" },
        cleanup() {},
      }),
      createReconciler: () => ({
        registerBlockHandler: () => () => {},
        teardown() {},
      }),
      createSceneEngine: () => ({
        start() {},
        stop() {},
        resync() {},
        onCommand: () => () => {},
        getDiagnostics: () => ({}),
      }),
    },
  );
  scene.initialize({ contextName: "ctx", renderWindowId: 1 });
  return scene;
}

test("every promised view API key is implemented by the scene", async () => {
  const { COMMON_VIEW_API_KEYS } = await loadModule(
    "/src/components/viewApi.js",
  );
  const scene = await buildScene();

  const missing = COMMON_VIEW_API_KEYS.filter(
    (key) => typeof scene[key] !== "function",
  );
  assert.deepEqual(missing, [], `scene is missing: ${missing.join(", ")}`);
});

test("a backend may add methods but never shadow a common API key", async () => {
  const { COMMON_VIEW_API_KEYS, createViewApi } = await loadModule(
    "/src/components/viewApi.js",
  );
  const scene = await buildScene();
  const api = createViewApi(scene, {
    container: {},
    render() {},
    resize() {},
  });

  for (const key of COMMON_VIEW_API_KEYS) {
    assert.equal(api[key], scene[key], `${key} is not the scene's own method`);
  }
  assert.equal(typeof api.render, "function");
});
