import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

function buildScene(instances) {
  return async () => {
    const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");
    const synchronizerContext = {
      getInstance: (id) => instances.get(String(id)),
    };
    const scene = useSceneSync(
      {
        client: {},
        emit() {},
        getRenderWindow: () => ({ id: "render-window" }),
        renderScene() {},
        syncErrorLabel: "UseSceneSyncGetInstanceTest",
      },
      {
        createManagedSyncContext: () => ({
          synchronizerContext,
          syncRenderWindow: { id: "sync-render-window" },
          cleanup() {},
        }),
        withSyncCapability: () => () => true,
        createPushSync() {
          return {
            cleanup() {},
            requestResync() {},
            getQueueLength() {
              return 0;
            },
            takeNextMessage() {
              return null;
            },
            markMessageApplied() {},
          };
        },
        createSyncController() {
          return {
            async requestSync() {
              return false;
            },
          };
        },
      },
    );
    scene.initialize({ contextName: "ctx", renderWindowId: 1, syncMode: "push" });
    return scene;
  };
}

test("getInstance resolves instance ids through the synchronizer context", async () => {
  const drape = { name: "drape-actor" };
  const imagePlane = { name: "image-plane-actor" };
  const instances = new Map([
    ["5", drape],
    ["12", imagePlane],
  ]);
  const scene = await buildScene(instances)();

  assert.equal(scene.getInstance("5"), drape);
  assert.equal(scene.getInstance("12"), imagePlane);
  // Numeric ids are coerced to the string key the synchronizer context uses.
  assert.equal(scene.getInstance(5), drape);
});

test("getInstance returns null for unknown or nullish ids", async () => {
  const scene = await buildScene(new Map())();

  assert.equal(scene.getInstance("999"), null);
  assert.equal(scene.getInstance(null), null);
  assert.equal(scene.getInstance(undefined), null);
});

test("getInstance returns null before the sync context is initialized", async () => {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");
  const scene = useSceneSync({
    client: {},
    emit() {},
    getRenderWindow: () => null,
    renderScene() {},
  });

  assert.equal(scene.getInstance("5"), null);
});
