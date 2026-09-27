// The scene API contract: every key the view API promises must be backed by a
// real function on both views. A key named here but never implemented (or
// later renamed on one side) makes the whole channel a silent no-op:
// `api[key] = undefined` throws nothing until a user drives it.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";
import { mountScene } from "./sceneHarness.mjs";

after(async () => {
  await closeModuleLoader();
});

// Both views' setups run outside a mounted Vue instance here (lifecycle hooks
// warn and no-op), which is enough: the returned object is the exact api each
// registers for consumers.
test("both views expose every common view API key", async () => {
  const { COMMON_VIEW_API_KEYS } = await loadModule(
    "/src/components/viewApi.js",
  );
  const props = { renderWindow: 1, wsClient: {}, viewKey: null };
  for (const path of [
    "/src/components/VtkJsLocal.js",
    "/src/components/VtkJsShared.js",
  ]) {
    const component = (await loadModule(path)).default;
    const api = component.setup(props, { emit() {} });
    const missing = COMMON_VIEW_API_KEYS.filter(
      (key) => typeof api[key] !== "function",
    );
    assert.deepEqual(missing, [], `${path} is missing: ${missing.join(", ")}`);
  }
});

// The backend layer composes over the scene: it contributes the view-specific
// entries, and any common key it names wins over the scene's method.
test("a backend adds its own entries and overrides the common keys it names", async () => {
  const { COMMON_VIEW_API_KEYS, createViewApi } = await loadModule(
    "/src/components/viewApi.js",
  );
  const { scene } = await mountScene();
  const backendGetRenderer = () => {};
  const api = createViewApi(scene, {
    container: {},
    render() {},
    resize() {},
    getRenderer: backendGetRenderer,
  });

  assert.equal(api.getRenderer, backendGetRenderer);
  const unnamed = COMMON_VIEW_API_KEYS.filter((key) => key !== "getRenderer");
  for (const key of unnamed) {
    assert.equal(api[key], scene[key], `${key} is not the scene's own method`);
  }
  assert.equal(typeof api.render, "function");
  assert.deepEqual(
    Object.keys(api).sort(),
    [...COMMON_VIEW_API_KEYS, "container", "render", "resize"].sort(),
  );
  scene.cleanup();
});
