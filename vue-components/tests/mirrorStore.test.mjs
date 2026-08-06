import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

async function loadMirrorStore() {
  const { createMirrorStore } = await loadModule(
    "/src/components/engine/mirrorStore.js",
  );
  return createMirrorStore;
}

// The op sequences and expected mirrors below are lifted from the Python
// reference vectors in tests/test_scene_store.py (basic_nodes and the
// structural/patch cases); the mirror must track store.snapshot()["nodes"].
const RW = "1";

function basicNodes() {
  return {
    [RW]: { type: "vtkRenderWindow", props: {}, refs: { renderers: ["2"] } },
    2: {
      type: "vtkRenderer",
      props: { background: [0, 0, 0, 1] },
      refs: { viewProps: ["3"], activeCamera: "6" },
    },
    3: {
      type: "vtkActor",
      props: { visibility: true },
      refs: { mapper: "4" },
    },
    4: {
      type: "vtkMapper",
      props: { scalarVisibility: false },
      refs: { input: "5" },
      blocks: { pickable: { tags: { rev: 1 }, ids: ["lm-1"] } },
    },
    5: {
      type: "vtkPolyData",
      props: {},
      arrays: {
        points: {
          ref: "c:pts-hash-1",
          dataType: "Float32Array",
          size: 9,
          numberOfComponents: 3,
        },
        verts: { ref: "c2:conn-1:off-1", dataType: "Uint32Array" },
      },
    },
    6: { type: "vtkCamera", props: { viewAngle: 30 } },
  };
}

function upsertAllOps(nodes) {
  return Object.entries(nodes).map(([id, node]) => ({
    op: "upsert",
    id,
    node,
  }));
}

test("first commit's upserts reproduce the full node graph", async () => {
  const createMirrorStore = await loadMirrorStore();
  const mirror = createMirrorStore();

  mirror.applyOps(upsertAllOps(basicNodes()));

  assert.deepEqual(mirror.toObject(), basicNodes());
  assert.equal(mirror.size(), 6);
  assert.deepEqual(
    [...mirror.liveRefs()].sort(),
    ["c2:conn-1:off-1", "c:pts-hash-1"],
  );
  assert.equal(mirror.refCount("c:pts-hash-1"), 1);
});

test("upserts deep-copy nodes so later message mutation cannot leak in", async () => {
  const createMirrorStore = await loadMirrorStore();
  const mirror = createMirrorStore();
  const nodes = basicNodes();

  mirror.applyOps(upsertAllOps(nodes));
  nodes["4"].blocks.pickable.tags.rev = 99;

  assert.equal(mirror.get("4").blocks.pickable.tags.rev, 1);
});

test("a key change upsert replaces exactly that node", async () => {
  const createMirrorStore = await loadMirrorStore();
  const mirror = createMirrorStore();
  mirror.applyOps(upsertAllOps(basicNodes()));

  // A feature-block change and a novel top-level key: the two shapes a
  // hand-maintained patch signature would miss but a generic diff must catch.
  const mapper = basicNodes()["4"];
  mapper.blocks.pickable.tags.rev = 2;
  mapper.authority = "server";
  mirror.applyOps([{ op: "upsert", id: "4", node: mapper }]);

  const expected = basicNodes();
  expected["4"].blocks.pickable.tags.rev = 2;
  expected["4"].authority = "server";
  assert.deepEqual(mirror.toObject(), expected);
});

test("remove ops drop the unreachable subtree and its refs leave", async () => {
  const createMirrorStore = await loadMirrorStore();
  const mirror = createMirrorStore();
  mirror.applyOps(upsertAllOps(basicNodes()));

  const renderer = basicNodes()["2"];
  renderer.refs.viewProps = [];
  mirror.applyOps([
    { op: "upsert", id: "2", node: renderer },
    { op: "remove", id: "3" },
    { op: "remove", id: "4" },
    { op: "remove", id: "5" },
  ]);

  assert.deepEqual([...mirror.ids()].sort(), [RW, "2", "6"]);
  assert.equal(mirror.liveRefs().size, 0);
});

test("patchArray re-refs the entry and preserves its other metadata", async () => {
  const createMirrorStore = await loadMirrorStore();
  const mirror = createMirrorStore();
  mirror.applyOps(upsertAllOps(basicNodes()));

  mirror.applyOps([
    {
      op: "patchArray",
      id: "5",
      key: "points",
      offset: 3,
      data: new Uint8Array(12),
      dataType: "Float32Array",
      ref: "v:5:points:1",
    },
  ]);

  assert.deepEqual(mirror.get("5").arrays.points, {
    ref: "v:5:points:1",
    dataType: "Float32Array",
    size: 9,
    numberOfComponents: 3,
  });
  assert.deepEqual(mirror.get("5").arrays.verts, {
    ref: "c2:conn-1:off-1",
    dataType: "Uint32Array",
  });
  assert.ok(mirror.liveRefs().has("v:5:points:1"));
  assert.ok(!mirror.liveRefs().has("c:pts-hash-1"));
  assert.equal(mirror.refCount("c:pts-hash-1"), 0);
  assert.equal(mirror.refCount("v:5:points:1"), 1);
});

test("ref counts track content aliases across patches and removal", async () => {
  const createMirrorStore = await loadMirrorStore();
  const mirror = createMirrorStore();
  const node = (ref) => ({
    type: "vtkPolyData",
    arrays: { points: { ref, dataType: "Float32Array" } },
  });
  mirror.applyOps([
    { op: "upsert", id: "a", node: node("c:shared") },
    { op: "upsert", id: "b", node: node("c:shared") },
  ]);
  assert.equal(mirror.refCount("c:shared"), 2);

  mirror.applyOp({
    op: "patchArray",
    id: "a",
    key: "points",
    offset: 0,
    data: new Float32Array([1]),
    dataType: "Float32Array",
    ref: "v:a:points:1",
  });
  assert.equal(mirror.refCount("c:shared"), 1);
  assert.equal(mirror.refCount("v:a:points:1"), 1);

  mirror.applyOp({ op: "remove", id: "b" });
  assert.equal(mirror.refCount("c:shared"), 0);
});

test("contract violations throw for the engine to resync on", async () => {
  const createMirrorStore = await loadMirrorStore();
  const mirror = createMirrorStore();
  mirror.applyOps(upsertAllOps(basicNodes()));

  assert.throws(() => mirror.applyOp({ op: "remove", id: "999" }));
  assert.throws(() =>
    mirror.applyOp({
      op: "patchArray",
      id: "5",
      key: "normals",
      offset: 0,
      data: new Uint8Array(0),
      dataType: "Float32Array",
      ref: "v:5:normals:1",
    }),
  );
  assert.throws(() => mirror.applyOp({ op: "explode", id: RW }));
});

test("gcBlobCache drops refs no mirror node references", async () => {
  const createMirrorStore = await loadMirrorStore();
  const mirror = createMirrorStore();
  mirror.applyOps(upsertAllOps(basicNodes()));

  const cache = new Map([
    ["c:pts-hash-1", new Float32Array(9)],
    ["c2:conn-1:off-1", new Uint32Array(2)],
    ["c:orphan", new Float32Array(3)],
  ]);
  mirror.gcBlobCache(cache);
  assert.deepEqual(
    [...cache.keys()].sort(),
    ["c2:conn-1:off-1", "c:pts-hash-1"],
  );

  const renderer = basicNodes()["2"];
  renderer.refs.viewProps = [];
  mirror.applyOps([
    { op: "upsert", id: "2", node: renderer },
    { op: "remove", id: "3" },
    { op: "remove", id: "4" },
    { op: "remove", id: "5" },
  ]);
  mirror.gcBlobCache(cache);
  assert.equal(cache.size, 0);
});
