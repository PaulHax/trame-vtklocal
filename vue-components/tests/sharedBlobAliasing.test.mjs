import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

// Array refs are content-addressed (`c:<hash>`), so two nodes whose arrays hold
// identical bytes cite one ref and the client resolves both through a single
// blob-cache slot. Every in-place mutation path assumes the buffer belongs to
// the node it is patching.

const POINTS_ENTRY = {
  dataType: "Float32Array",
  size: 6,
  numberOfComponents: 3,
  registration: "setPoints",
  vtkClass: "vtkPoints",
};

function makePolyData() {
  let points = null;
  return {
    isDeleted: () => false,
    modified() {},
    getPoints: () => points,
    setPoints(value) {
      points = value;
    },
    getReferenceByName: () => null,
  };
}

async function makeScene(sharedRef, values, ids = ["a", "b"]) {
  const { createReconciler } = await loadModule(
    "/src/components/engine/reconcile.js",
  );
  const { createMirrorStore } = await loadModule(
    "/src/components/engine/mirrorStore.js",
  );
  const instances = new Map(ids.map((id) => [id, makePolyData()]));
  const reconciler = createReconciler({
    synchronizerContext: {
      getInstance: (id) => instances.get(String(id)),
      registerInstance: (id, instance) => instances.set(String(id), instance),
      unregisterInstance: (id) => instances.delete(String(id)),
    },
    objectManager: { build: () => null },
    rootId: "root",
    rootInstance: null,
  });
  const mirror = createMirrorStore();
  const cache = new Map([
    [sharedRef, new Uint8Array(new Float32Array(values).buffer)],
  ]);
  const node = (ref) => ({
    type: "vtkPolyData",
    props: {},
    arrays: { points: { ...POINTS_ENTRY, ref } },
  });
  reconciler.applyMessage(
    [
      ...ids.map((id) => ({ op: "upsert", id, node: node(sharedRef) })),
    ],
    mirror,
    cache,
  );
  return { reconciler, mirror, cache, instances };
}

test("a patchArray on one node leaves a content-identical sibling alone", async () => {
  const shared = "c:deadbeef";
  const { reconciler, mirror, cache, instances } = await makeScene(
    shared,
    [0, 0, 0, 1, 1, 1],
  );

  reconciler.applyMessage(
    [
      {
        op: "patchArray",
        id: "a",
        key: "points",
        offset: 0,
        data: new Float32Array([7, 8, 9]),
        dataType: "Float32Array",
        ref: "v:a:points:1",
      },
    ],
    mirror,
    cache,
  );

  const a = Array.from(instances.get("a").getPoints().getData());
  const b = Array.from(instances.get("b").getPoints().getData());
  assert.deepEqual(a, [7, 8, 9, 1, 1, 1]);
  assert.deepEqual(
    b,
    [0, 0, 0, 1, 1, 1],
    "node b never changed server-side; its rendered points must not move",
  );
});

test("a sibling keeps a resolvable blob ref after its twin is patched", async () => {
  const shared = "c:deadbeef";
  const { reconciler, mirror, cache } = await makeScene(
    shared,
    [0, 0, 0, 1, 1, 1],
  );

  reconciler.applyMessage(
    [
      {
        op: "patchArray",
        id: "a",
        key: "points",
        offset: 0,
        data: new Float32Array([7, 8, 9]),
        dataType: "Float32Array",
        ref: "v:a:points:1",
      },
    ],
    mirror,
    cache,
  );

  // b's mirror node still cites the shared ref; anything that forces a rebind
  // (a prop change on b, a resync) must still find its bytes.
  assert.equal(mirror.get("b").arrays.points.ref, shared);
  assert.ok(
    cache.has(shared),
    "the shared blob was evicted while node b still cites it",
  );
  assert.deepEqual(
    Array.from(cache.get(shared)),
    [0, 0, 0, 1, 1, 1],
    "the old ref retained the patched node's bytes",
  );
  assert.deepEqual(Array.from(cache.get("v:a:points:1")), [7, 8, 9, 1, 1, 1]);
});

test("patching the cache owner promotes its existing sibling without copying", async () => {
  const shared = "c:deadbeef";
  const { reconciler, mirror, cache, instances } = await makeScene(
    shared,
    [0, 0, 0, 1, 1, 1],
  );
  const siblingValues = instances.get("b").getPoints().getData();

  reconciler.applyMessage(
    [
      {
        op: "patchArray",
        id: "a",
        key: "points",
        offset: 0,
        data: new Float32Array([7, 8, 9]),
        dataType: "Float32Array",
        ref: "v:a:points:1",
      },
    ],
    mirror,
    cache,
  );

  assert.equal(cache.get(shared), siblingValues);
});

test("pure patches keep only the one live ref for a unique array", async () => {
  const { reconciler, mirror, cache, instances } = await makeScene(
    "c:unique",
    [0, 0, 0, 1, 1, 1],
    ["a"],
  );
  const runtime = instances.get("a").getPoints().getData();
  assert.equal(runtime, cache.get("c:unique"));

  for (let version = 1; version <= 20; version += 1) {
    reconciler.applyMessage(
      [
        {
          op: "patchArray",
          id: "a",
          key: "points",
          offset: 0,
          data: new Float32Array([version]),
          dataType: "Float32Array",
          ref: `v:a:points:${version}`,
        },
      ],
      mirror,
      cache,
    );
    assert.deepEqual([...cache.keys()], [`v:a:points:${version}`]);
    assert.equal(instances.get("a").getPoints().getData(), runtime);
    assert.equal(cache.get(`v:a:points:${version}`), runtime);
  }
});

test("a protected preview binding patches runtime and canonical cache separately", async () => {
  const { reconciler, mirror, cache, instances } = await makeScene(
    "c:unique",
    [0, 0, 0, 1, 1, 1],
    ["a"],
  );
  reconciler.protectLocalWrites("a", "points");
  const runtime = instances.get("a").getPoints().getData();
  assert.notEqual(runtime, cache.get("c:unique"));

  reconciler.applyMessage(
    [
      {
        op: "patchArray",
        id: "a",
        key: "points",
        offset: 0,
        data: new Float32Array([7, 8, 9]),
        dataType: "Float32Array",
        ref: "v:a:points:1",
      },
    ],
    mirror,
    cache,
  );

  assert.deepEqual(Array.from(runtime), [7, 8, 9, 1, 1, 1]);
  assert.deepEqual(
    Array.from(cache.get("v:a:points:1")),
    [7, 8, 9, 1, 1, 1],
  );
  assert.notEqual(runtime, cache.get("v:a:points:1"));
});

test("a drag preview writes only the node it grabbed", async () => {
  const { createDragPreview } = await loadModule(
    "/src/components/dragPreview.js",
  );
  const shared = "c:deadbeef";
  const { reconciler, cache, instances } = await makeScene(
    shared,
    [0, 0, 0, 1, 1, 1],
  );
  reconciler.protectLocalWrites("a", "points");

  const preview = createDragPreview({
    getCamera: () => ({
      getCompositeProjectionMatrix: () => [
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      ],
      getDirectionOfProjection: () => [0, 0, -1],
    }),
    getViewportMetrics: () => ({ width: 100, height: 100, aspect: 1 }),
    getBoundArray: reconciler.getBoundArray,
    getInstance: () => ({ modified() {} }),
    requestRender: () => {},
  });

  preview.start({
    pick: {
      nodeId: "a",
      pointsNodeId: "a",
      pointIndex: 0,
      world: [0, 0, 0],
      preview: "screen",
    },
  });
  preview.move({ pointer: { x: 75, y: 50 } });

  const b = Array.from(instances.get("b").getPoints().getData());
  assert.deepEqual(
    b,
    [0, 0, 0, 1, 1, 1],
    "dragging a point in node a moved node b's glyph too",
  );
  assert.deepEqual(
    Array.from(cache.get(shared)),
    [0, 0, 0, 1, 1, 1],
    "optimistic preview polluted canonical cache bytes",
  );
  preview.end();
  assert.deepEqual(
    Array.from(instances.get("a").getPoints().getData()),
    [0, 0, 0, 1, 1, 1],
  );
});
