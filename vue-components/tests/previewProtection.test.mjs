import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

test("preview protection resolves a rebuilt pickable mapper", async () => {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");
  const blockHandlers = new Map();
  const protectedSlots = [];
  let engineCallbacks = null;
  let oldMapperDeleted = false;
  const oldPoints = {};
  const newPoints = {};
  const oldMapper = {
    isDeleted: () => oldMapperDeleted,
    getInputData: () => (oldMapperDeleted ? null : oldPoints),
  };
  const rebuiltMapper = {
    isDeleted: () => false,
    getInputData: () => newPoints,
  };
  const synchronizerContext = {
    getInstance: (id) => (id === "mapper" ? rebuiltMapper : null),
    getInstanceId: (instance) =>
      instance === oldPoints
        ? "points-old"
        : instance === newPoints
          ? "points-new"
          : null,
  };
  const reconciler = {
    registerBlockHandler(key, handler) {
      blockHandlers.set(key, handler);
      return () => {};
    },
    protectLocalWrites(id, key) {
      protectedSlots.push([id, key]);
    },
    teardown() {},
  };
  const scene = useSceneSync(
    {
      client: {},
      getRenderWindow: () => ({ getRenderers: () => [], getViews: () => [] }),
      renderScene() {},
    },
    {
      createManagedSyncContext: () => ({
        synchronizerContext,
        syncRenderWindow: null,
        cleanup() {},
      }),
      createMirrorStore: () => ({
        entries: () => [][Symbol.iterator](),
        get: () => null,
        clear() {},
      }),
      createReconciler: () => reconciler,
      createSceneEngine: ({ callbacks }) => {
        engineCallbacks = callbacks;
        return {
          start() {},
          stop() {},
          onCommand: () => () => {},
          getDiagnostics: () => ({}),
        };
      },
    },
  );
  scene.initialize({ contextName: "preview-protection", renderWindowId: 1 });
  blockHandlers.get("pickable")(
    "mapper",
    { grabPx: 8, preview: "screen" },
    oldMapper,
  );

  oldMapperDeleted = true;
  engineCallbacks.onApplied({ ops: [] });

  assert.deepEqual(protectedSlots, [["points-new", "points"]]);
  scene.cleanup();
});
