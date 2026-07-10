import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

test("owned and external backends share every scene API key", async () => {
  const { COMMON_VIEW_API_KEYS, createViewApi } = await loadModule(
    "/src/components/viewApi.js",
  );
  const scene = Object.fromEntries(
    COMMON_VIEW_API_KEYS.map((key) => [key, () => key]),
  );
  const owned = createViewApi(scene, {
    container: {},
    render() {},
    resize() {},
  });
  const external = createViewApi(scene, {
    initializeForExternalContext() {},
    renderExternal() {},
    onRenderRequested() {},
    setRepaintCallback() {},
  });
  const backendKeys = new Set([
    "container",
    "render",
    "resize",
    "initializeForExternalContext",
    "renderExternal",
    "onRenderRequested",
    "setRepaintCallback",
  ]);
  const common = (api) =>
    Object.keys(api)
      .filter((key) => !backendKeys.has(key))
      .sort();

  assert.deepEqual(common(owned), [...COMMON_VIEW_API_KEYS].sort());
  assert.deepEqual(common(external), [...COMMON_VIEW_API_KEYS].sort());
});
