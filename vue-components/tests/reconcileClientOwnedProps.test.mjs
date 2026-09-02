import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

function makeInstance(type, id) {
  let deleted = false;
  let viewProps = [];
  return {
    type,
    id,
    set() {},
    isDeleted: () => deleted,
    markDeleted: () => {
      deleted = true;
    },
    delete() {
      deleted = true;
    },
    modified() {},
    getReferenceByName: () => null,
    getViewProps: () => [...viewProps],
    addViewProp(value) {
      viewProps.push(value);
    },
    removeViewProp(value) {
      viewProps = viewProps.filter((item) => item !== value);
    },
  };
}

function node(type, refs = {}) {
  return { type, props: {}, refs, arrays: {}, blocks: {} };
}

async function makeHarness() {
  const { createReconciler } = await loadModule(
    "/src/components/engine/reconcile.js",
  );
  const { createMirrorStore } = await loadModule(
    "/src/components/engine/mirrorStore.js",
  );
  const instances = new Map();
  const reconciler = createReconciler({
    synchronizerContext: {
      getInstance: (id) => instances.get(String(id)),
      registerInstance: (id, instance) => instances.set(String(id), instance),
      unregisterInstance: (id) => instances.delete(String(id)),
    },
    objectManager: {
      build: (type, options) =>
        makeInstance(type, String(options.managedInstanceId)),
    },
    rootId: "root",
    rootInstance: null,
  });
  return {
    reconciler,
    mirror: createMirrorStore(),
    cache: new Map(),
    instances,
  };
}

// One server prop on a renderer, plus one the client attached itself. Adding a
// second server prop forces the renderer's viewProps slot to be re-applied.
async function sceneWithClientProp() {
  const harness = await makeHarness();
  harness.reconciler.applyMessage(
    [
      { op: "upsert", id: "propA", node: node("vtkActor") },
      {
        op: "upsert",
        id: "rend",
        node: node("vtkRenderer", { viewProps: ["propA"] }),
      },
    ],
    harness.mirror,
    harness.cache,
  );
  const renderer = harness.instances.get("rend");
  const clientProp = makeInstance("vtkActor", "client-owned");
  renderer.addViewProp(clientProp);
  return { ...harness, renderer, clientProp };
}

test("a client-owned view prop survives a forced slot re-apply", async () => {
  const harness = await sceneWithClientProp();

  harness.reconciler.applyMessage(
    [
      { op: "upsert", id: "propB", node: node("vtkActor") },
      {
        op: "upsert",
        id: "rend",
        node: node("vtkRenderer", { viewProps: ["propA", "propB"] }),
      },
    ],
    harness.mirror,
    harness.cache,
  );

  assert.deepEqual(
    harness.renderer.getViewProps(),
    [
      harness.clientProp,
      harness.instances.get("propA"),
      harness.instances.get("propB"),
    ],
    "the client prop stays attached and the server props end in server order",
  );
});

test("a replaced instance is detached even though its id is unchanged", async () => {
  const harness = await sceneWithClientProp();
  const oldPropA = harness.instances.get("propA");
  oldPropA.markDeleted();

  harness.reconciler.applyMessage(
    [
      { op: "upsert", id: "propA", node: node("vtkActor") },
      {
        op: "upsert",
        id: "rend",
        node: node("vtkRenderer", { viewProps: ["propA"] }),
      },
    ],
    harness.mirror,
    harness.cache,
  );

  const newPropA = harness.instances.get("propA");
  assert.notEqual(newPropA, oldPropA);
  assert.deepEqual(harness.renderer.getViewProps(), [
    harness.clientProp,
    newPropA,
  ]);
});

test("a removed view prop is detached without touching the client prop", async () => {
  const harness = await sceneWithClientProp();

  harness.reconciler.applyMessage(
    [
      {
        op: "upsert",
        id: "rend",
        node: node("vtkRenderer", { viewProps: [] }),
      },
      { op: "remove", id: "propA" },
    ],
    harness.mirror,
    harness.cache,
  );

  assert.deepEqual(harness.renderer.getViewProps(), [harness.clientProp]);
});
