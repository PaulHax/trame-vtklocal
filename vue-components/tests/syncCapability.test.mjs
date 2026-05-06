import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

function createRenderWindowStub() {
  let synchronizedViewId = null;
  const propertySets = [];

  return {
    propertySets,
    set(values) {
      if (Object.hasOwn(values, "synchronizedViewId")) {
        synchronizedViewId = values.synchronizedViewId;
        return;
      }
      propertySets.push(values);
    },
    get(name) {
      if (name === "synchronizedViewId") {
        return { synchronizedViewId };
      }
      return {};
    },
    render() {},
  };
}

test("prepared push states apply even when root mtime is unchanged", async () => {
  const { withSyncCapability } = await loadModule(
    "/src/components/sync/syncCapability.js",
  );

  const renderWindow = createRenderWindowStub();
  const context = {
    setActiveViewId() {},
    incrementMTime() {},
  };

  const sync = withSyncCapability(renderWindow, context, {}, new Map());

  const firstState = {
    id: "rw",
    mtime: 1,
    properties: { marker: "first" },
  };
  const secondState = {
    id: "rw",
    mtime: 1,
    properties: { marker: "second" },
  };

  assert.equal(sync.synchronizePreparedStateSync(firstState, true), true);
  assert.equal(sync.synchronizePreparedStateSync(secondState, true), true);
  assert.deepEqual(renderWindow.propertySets, [
    { marker: "first" },
    { marker: "second" },
  ]);
});

test("array validation finds descriptors nested in arbitrary state objects", async () => {
  const { allArraysHaveInlineData } = await loadModule(
    "/src/components/sync/syncCapability.js",
  );

  const state = {
    id: "rw",
    properties: {
      custom: {
        arbitrary: {
          payload: {
            hash: "nested-hash",
            dataType: "Float32Array",
            numberOfComponents: 3,
            size: 3,
          },
        },
      },
    },
  };

  assert.equal(allArraysHaveInlineData(state, new Map()), false);
  assert.equal(
    allArraysHaveInlineData(
      state,
      new Map([["nested-hash", new Float32Array([1, 2, 3])]]),
    ),
    true,
  );
});
