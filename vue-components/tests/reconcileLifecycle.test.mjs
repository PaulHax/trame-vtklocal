import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

const POINTS_ENTRY = {
  ref: "c:points",
  dataType: "Float32Array",
  size: 6,
  numberOfComponents: 3,
  registration: "setPoints",
  vtkClass: "vtkPoints",
};

function node(type, extra = {}) {
  return {
    type,
    props: {},
    refs: {},
    arrays: {},
    blocks: {},
    ...extra,
  };
}

function makeInstance(type, id) {
  let deleted = false;
  let mapper = null;
  let points = null;
  let viewProps = [];
  const inputs = [];
  const indexed = [];
  return {
    type,
    id,
    setCalls: [],
    blockCalls: [],
    deleteCalls: 0,
    set(props) {
      this.setCalls.push({ ...props });
    },
    isDeleted: () => deleted,
    markDeleted: () => {
      deleted = true;
    },
    delete() {
      this.deleteCalls += 1;
      deleted = true;
    },
    modified() {},
    getReferenceByName: () => null,
    getPoints: () => points,
    setPoints(value) {
      points = value;
    },
    getMapper: () => mapper,
    setMapper(value) {
      mapper = value;
    },
    getViewProps: () => [...viewProps],
    addViewProp(value) {
      viewProps.push(value);
    },
    removeViewProp(value) {
      viewProps = viewProps.filter((item) => item !== value);
    },
    setScalarOpacity(index, value) {
      indexed[index] = value;
    },
    getScalarOpacity: (index) => indexed[index],
    setInputData(value, port) {
      inputs[port] = value;
    },
    getInputData: (port) => inputs[port],
  };
}

async function makeHarness({ build = null } = {}) {
  const { createReconciler } = await loadModule(
    "/src/components/engine/reconcile.js",
  );
  const { createMirrorStore } = await loadModule(
    "/src/components/engine/mirrorStore.js",
  );
  const instances = new Map();
  const builds = [];
  const context = {
    getInstance: (id) => instances.get(String(id)),
    registerInstance: (id, instance) => instances.set(String(id), instance),
    unregisterInstance: (id) => instances.delete(String(id)),
  };
  const objectManager = {
    build(type, options) {
      builds.push({ type, id: String(options.managedInstanceId) });
      return build
        ? build(type, String(options.managedInstanceId), builds.length)
        : makeInstance(type, String(options.managedInstanceId));
    },
  };
  const reconciler = createReconciler({
    synchronizerContext: context,
    objectManager,
    rootId: "root",
    rootInstance: null,
  });
  const mirror = createMirrorStore();
  const cache = new Map([
    ["c:points", new Uint8Array(new Float32Array([0, 0, 0, 1, 1, 1]).buffer)],
  ]);
  return { reconciler, mirror, cache, instances, builds };
}

const targetNode = node("vtkTarget");
const ownerNode = node("vtkOwner", {
  props: { opacity: 0.4, visible: true },
  refs: { mapper: "target" },
  arrays: { points: POINTS_ENTRY },
  blocks: { feature: { enabled: true } },
});
const actorNode = node("vtkActor", { refs: { mapper: "owner" } });

async function applyOwnerScene(harness) {
  harness.reconciler.registerBlockHandler("feature", (id, block, instance) => {
    instance.blockCalls.push({ id, block });
  });
  harness.reconciler.applyMessage(
    [
      { op: "upsert", id: "target", node: targetNode },
      { op: "upsert", id: "owner", node: ownerNode },
      { op: "upsert", id: "actor", node: actorNode },
    ],
    harness.mirror,
    harness.cache,
  );
}

function assertFullyHydrated(owner, target) {
  assert.deepEqual(owner.setCalls, [{ opacity: 0.4, visible: true }]);
  assert.equal(owner.getMapper(), target);
  assert.deepEqual(Array.from(owner.getPoints().getData()), [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(owner.blockCalls, [
    { id: "owner", block: { enabled: true } },
  ]);
}

test("a deleted same-type instance is fully hydrated and referrers adopt it", async () => {
  const harness = await makeHarness();
  await applyOwnerScene(harness);
  const record = harness.reconciler.getAppliedRecord("owner");
  const oldOwner = harness.instances.get("owner");
  const actor = harness.instances.get("actor");
  oldOwner.markDeleted();

  harness.reconciler.applyMessage(
    [{ op: "upsert", id: "owner", node: ownerNode }],
    harness.mirror,
    harness.cache,
  );

  const replacement = harness.instances.get("owner");
  assert.notEqual(replacement, oldOwner);
  assert.equal(harness.reconciler.getAppliedRecord("owner"), record);
  assertFullyHydrated(replacement, harness.instances.get("target"));
  assert.equal(actor.getMapper(), replacement);
  assert.equal(record.status, "live");
  assert.equal(record.appliedType, "vtkOwner");
});

test("the widget-owned root is represented and hydrated without a build", async () => {
  const { createReconciler } = await loadModule(
    "/src/components/engine/reconcile.js",
  );
  const { createMirrorStore } = await loadModule(
    "/src/components/engine/mirrorStore.js",
  );
  const root = makeInstance("vtkRenderWindow", "root");
  const instances = new Map();
  const reconciler = createReconciler({
    synchronizerContext: {
      getInstance: (id) => instances.get(String(id)),
      registerInstance: (id, instance) => instances.set(String(id), instance),
      unregisterInstance: (id) => instances.delete(String(id)),
    },
    objectManager: {
      build: () => {
        throw new Error("the root must not be built");
      },
    },
    rootId: "root",
    rootInstance: root,
  });
  const mirror = createMirrorStore();
  reconciler.applyMessage(
    [
      {
        op: "upsert",
        id: "root",
        node: node("vtkRenderWindow", { props: { numberOfLayers: 2 } }),
      },
    ],
    mirror,
    new Map(),
  );

  assert.deepEqual(root.setCalls, [{ numberOfLayers: 2 }]);
  assert.equal(reconciler.getAppliedRecord("root").instance, root);
  assert.equal(reconciler.getAppliedRecord("root").status, "live");
});

test("a missing registered instance rebuilds with complete state", async () => {
  const harness = await makeHarness();
  await applyOwnerScene(harness);
  const oldOwner = harness.instances.get("owner");
  harness.instances.delete("owner");

  harness.reconciler.applyMessage(
    [{ op: "upsert", id: "owner", node: ownerNode }],
    harness.mirror,
    harness.cache,
  );

  const replacement = harness.instances.get("owner");
  assert.notEqual(replacement, oldOwner);
  assertFullyHydrated(replacement, harness.instances.get("target"));
  assert.equal(oldOwner.deleteCalls, 1);
});

test("private array ownership survives an owner rebuild", async () => {
  const harness = await makeHarness();
  await applyOwnerScene(harness);
  harness.reconciler.protectLocalWrites("owner", "points");
  const firstValues = harness.instances.get("owner").getPoints().getData();
  assert.notEqual(firstValues, harness.cache.get("c:points"));
  harness.instances.get("owner").markDeleted();

  harness.reconciler.applyMessage(
    [{ op: "upsert", id: "owner", node: ownerNode }],
    harness.mirror,
    harness.cache,
  );

  const replacementValues = harness.instances
    .get("owner")
    .getPoints()
    .getData();
  assert.notEqual(replacementValues, firstValues);
  assert.notEqual(replacementValues, harness.cache.get("c:points"));
  replacementValues[0] = 99;
  assert.equal(harness.cache.get("c:points")[0], 0);
});

test("a type-changing replacement uses the same full-hydration contract", async () => {
  const harness = await makeHarness();
  await applyOwnerScene(harness);
  const record = harness.reconciler.getAppliedRecord("owner");
  const oldOwner = harness.instances.get("owner");
  const replacementNode = { ...ownerNode, type: "vtkReplacementOwner" };

  harness.reconciler.applyMessage(
    [{ op: "upsert", id: "owner", node: replacementNode }],
    harness.mirror,
    harness.cache,
  );

  const replacement = harness.instances.get("owner");
  assertFullyHydrated(replacement, harness.instances.get("target"));
  assert.equal(oldOwner.deleteCalls, 1);
  assert.equal(harness.reconciler.getAppliedRecord("owner"), record);
  assert.equal(record.appliedType, "vtkReplacementOwner");
});

test("a superseded instance is retired when replacement hydration fails", async () => {
  const harness = await makeHarness();
  await applyOwnerScene(harness);
  const oldOwner = harness.instances.get("owner");
  const replacementNode = node("vtkReplacementOwner", {
    arrays: {
      points: { ...POINTS_ENTRY, ref: "c:missing" },
    },
  });

  assert.throws(
    () =>
      harness.reconciler.applyMessage(
        [{ op: "upsert", id: "owner", node: replacementNode }],
        harness.mirror,
        harness.cache,
      ),
    /blob c:missing missing from cache/,
  );

  const partial = harness.instances.get("owner");
  assert.notEqual(partial, oldOwner);
  assert.equal(oldOwner.deleteCalls, 1);
  assert.equal(partial.deleteCalls, 0);
  assert.equal(harness.mirror.get("owner").type, "vtkOwner");

  harness.reconciler.reset(harness.mirror);
  assert.equal(oldOwner.deleteCalls, 1, "the retired predecessor stays exact");
  assert.equal(partial.deleteCalls, 1);
});

test("a superseded instance is retired when replacement block setup throws", async () => {
  const harness = await makeHarness();
  await applyOwnerScene(harness);
  const oldOwner = harness.instances.get("owner");
  harness.reconciler.registerBlockHandler("feature", (_id, block) => {
    if (block) throw new Error("feature setup failed");
  });

  assert.throws(
    () =>
      harness.reconciler.applyMessage(
        [
          {
            op: "upsert",
            id: "owner",
            node: { ...ownerNode, type: "vtkReplacementOwner" },
          },
        ],
        harness.mirror,
        harness.cache,
      ),
    /feature setup failed/,
  );

  const partial = harness.instances.get("owner");
  assert.notEqual(partial, oldOwner);
  assert.equal(oldOwner.deleteCalls, 1);
  harness.reconciler.reset(harness.mirror);
  assert.equal(oldOwner.deleteCalls, 1);
  assert.equal(partial.deleteCalls, 1);
});

test("snapshot reconciliation rebuilds dead instances and rewires refs", async () => {
  const harness = await makeHarness();
  await applyOwnerScene(harness);
  const oldOwner = harness.instances.get("owner");
  const actor = harness.instances.get("actor");
  oldOwner.markDeleted();

  harness.reconciler.applySnapshot(
    harness.mirror.toObject(),
    harness.mirror,
    harness.cache,
  );

  const replacement = harness.instances.get("owner");
  assert.notEqual(replacement, oldOwner);
  assertFullyHydrated(replacement, harness.instances.get("target"));
  assert.equal(actor.getMapper(), replacement);
});

test("create-after-remove reattaches every supported ref-slot shape", async () => {
  const harness = await makeHarness();
  const refs = [
    { id: "single", node: node("vtkSingle", { refs: { mapper: "target" } }) },
    {
      id: "list",
      node: node("vtkList", { refs: { viewProps: ["target"] } }),
    },
    {
      id: "indexed",
      node: node("vtkIndexed", { refs: { scalarOpacity: ["target"] } }),
    },
    { id: "input", node: node("vtkInput", { refs: { inputs: ["target"] } }) },
  ];
  harness.reconciler.applyMessage(
    [
      { op: "upsert", id: "target", node: targetNode },
      ...refs.map(({ id, node: refNode }) => ({
        op: "upsert",
        id,
        node: refNode,
      })),
    ],
    harness.mirror,
    harness.cache,
  );
  const record = harness.reconciler.getAppliedRecord("target");
  const oldTarget = harness.instances.get("target");

  harness.reconciler.applyMessage(
    [{ op: "remove", id: "target" }],
    harness.mirror,
    harness.cache,
  );
  assert.equal(record.status, "removed");
  assert.equal(harness.reconciler.getAppliedRecord("target"), null);
  harness.reconciler.applyMessage(
    [{ op: "upsert", id: "target", node: targetNode }],
    harness.mirror,
    harness.cache,
  );

  const replacement = harness.instances.get("target");
  assert.notEqual(replacement, oldTarget);
  assert.notEqual(harness.reconciler.getAppliedRecord("target"), record);
  assert.equal(harness.instances.get("single").getMapper(), replacement);
  assert.deepEqual(harness.instances.get("list").getViewProps(), [replacement]);
  assert.equal(
    harness.instances.get("indexed").getScalarOpacity(0),
    replacement,
  );
  assert.equal(harness.instances.get("input").getInputData(0), replacement);
});

test("duplicate upserts fail before builds, callbacks, or mirror mutation", async () => {
  const harness = await makeHarness();
  const callbacks = [];
  harness.reconciler.registerBlockHandler("feature", (...args) =>
    callbacks.push(args),
  );

  assert.throws(
    () =>
      harness.reconciler.applyMessage(
        [
          { op: "upsert", id: 7, node: ownerNode },
          { op: "upsert", id: "7", node: ownerNode },
        ],
        harness.mirror,
        harness.cache,
      ),
    /duplicate upsert for node 7/,
  );
  assert.deepEqual(harness.builds, []);
  assert.deepEqual(callbacks, []);
  assert.equal(harness.mirror.size(), 0);
  assert.equal(harness.reconciler.getAppliedRecord("7"), null);
});

test("reset retires an applied-only instance left by failed hydration", async () => {
  const harness = await makeHarness();
  const missingBlobNode = node("vtkOwner", {
    arrays: {
      points: { ...POINTS_ENTRY, ref: "c:missing" },
    },
  });

  assert.throws(
    () =>
      harness.reconciler.applyMessage(
        [{ op: "upsert", id: "partial", node: missingBlobNode }],
        harness.mirror,
        harness.cache,
      ),
    /blob c:missing missing from cache/,
  );
  const partial = harness.instances.get("partial");
  const record = harness.reconciler.getAppliedRecord("partial");
  assert.ok(partial);
  assert.equal(harness.mirror.get("partial"), undefined);

  harness.reconciler.reset(harness.mirror);
  assert.equal(harness.instances.has("partial"), false);
  assert.equal(partial.deleteCalls, 1);
  assert.equal(record.status, "removed");
  assert.equal(record.instance, null);
  assert.equal(harness.reconciler.getAppliedRecord("partial"), null);
});

test("a pending build records desired/applied divergence and later recovers", async () => {
  let fail = true;
  const harness = await makeHarness({
    build: (type, id) => (fail ? null : makeInstance(type, id)),
  });
  const desired = node("vtkEventuallyAvailable", { props: { value: 12 } });

  harness.reconciler.applyMessage(
    [{ op: "upsert", id: "late", node: desired }],
    harness.mirror,
    harness.cache,
  );
  const record = harness.reconciler.getAppliedRecord("late");
  assert.equal(record.status, "pending");
  assert.equal(harness.mirror.get("late").type, "vtkEventuallyAvailable");
  assert.equal(record.appliedType, null);
  assert.equal(record.instance, null);

  fail = false;
  harness.reconciler.applyMessage(
    [{ op: "upsert", id: "late", node: desired }],
    harness.mirror,
    harness.cache,
  );
  assert.equal(harness.reconciler.getAppliedRecord("late"), record);
  assert.equal(record.status, "live");
  assert.equal(record.appliedType, "vtkEventuallyAvailable");
  assert.deepEqual(record.instance.setCalls, [{ value: 12 }]);
});
