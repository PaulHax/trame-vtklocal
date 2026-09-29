import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test("screen drag preview updates one bound point and remains an overlay", async () => {
  const { createDragPreview } = await loadModule(
    "/src/components/dragPreview.js",
  );
  const values = new Float32Array([0, 0, 0, 1, 0, 0]);
  let arrayModified = 0;
  let renders = 0;
  const array = {
    getData: () => values,
    modified: () => {
      arrayModified += 1;
    },
  };
  const preview = createDragPreview({
    getCamera: () => ({
      getCompositeProjectionMatrix: () => IDENTITY,
      getDirectionOfProjection: () => [0, 0, -1],
    }),
    getViewportMetrics: () => ({ width: 100, height: 100, aspect: 1 }),
    getBoundArray: (id, key) =>
      id === "points" && key === "points" ? array : null,
    getInstance: () => ({ modified() {} }),
    requestRender: () => {
      renders += 1;
    },
  });
  const pick = {
    nodeId: "mapper",
    pointsNodeId: "points",
    pointIndex: 0,
    world: [0, 0, 0],
    preview: "screen",
  };

  assert.equal(preview.start({ pick }), true);
  assert.equal(preview.move({ pointer: { x: 75, y: 50 } }), true);
  assert.ok(Math.abs(values[0] - 0.5) < 1e-6);
  assert.deepEqual(Array.from(values.slice(1, 3)), [0, 0]);
  assert.equal(arrayModified, 1);
  assert.equal(renders, 1);

  // A server patch for another point applies normally; reapply only restores
  // the optimistically dragged point.
  preview.beforeApply();
  values[0] = -1;
  values[3] = 9;
  preview.reapply();
  assert.ok(Math.abs(values[0] - 0.5) < 1e-6);
  assert.equal(values[3], 9);

  preview.end();
  preview.beforeApply();
  values[0] = 2;
  assert.equal(preview.reapply(), false);
  assert.equal(values[0], 2);
});

test("ending a preview restores the last server-confirmed point", async () => {
  const { createDragPreview } = await loadModule(
    "/src/components/dragPreview.js",
  );
  const values = new Float32Array([0, 0, 0, 9, 9, 9]);
  const array = { getData: () => values, modified() {} };
  const preview = createDragPreview({
    getCamera: () => ({
      getCompositeProjectionMatrix: () => IDENTITY,
      getDirectionOfProjection: () => [0, 0, -1],
    }),
    getViewportMetrics: () => ({ width: 100, height: 100, aspect: 1 }),
    getBoundArray: () => array,
    getInstance: () => ({ modified() {} }),
    requestRender: () => {},
  });
  const pick = {
    nodeId: "mapper",
    pointsNodeId: "points",
    pointIndex: 0,
    world: [0, 0, 0],
    preview: "screen",
  };

  assert.equal(preview.start({ pick }), true);
  assert.equal(preview.move({ pointer: { x: 75, y: 50 } }), true);
  assert.ok(Math.abs(values[0] - 0.5) < 1e-6);

  // The server confirms a cloud-depth point. It remains hidden by the active
  // screen-plane preview, then becomes authoritative when the drag ends even
  // if drag.end itself is a server-side no-op because the point is unchanged.
  preview.beforeApply();
  values.set([2, 3, 4], 0);
  preview.reapply({
    ops: [
      {
        op: "patchArray",
        id: "points",
        key: "points",
        offset: 0,
        data: new Float32Array([2, 3, 4]),
        dataType: "Float32Array",
      },
    ],
  });
  assert.ok(Math.abs(values[0] - 0.5) < 1e-6);

  // A patch to another point must not replace the saved confirmation with the
  // optimistic coordinate currently occupying this point's array slot.
  preview.beforeApply();
  values.set([7, 8, 9], 3);
  preview.reapply({
    ops: [
      {
        op: "patchArray",
        id: "points",
        key: "points",
        offset: 3,
        data: new Float32Array([7, 8, 9]),
        dataType: "Float32Array",
      },
    ],
  });
  preview.end();

  assert.deepEqual(Array.from(values.slice(0, 3)), [2, 3, 4]);
  assert.deepEqual(Array.from(values.slice(3, 6)), [7, 8, 9]);
});

test("partial server patches confirm only the covered point components", async () => {
  const { createDragPreview } = await loadModule(
    "/src/components/dragPreview.js",
  );
  const values = new Float32Array([0, 0, 0]);
  const array = { getData: () => values, modified() {} };
  const preview = createDragPreview({
    getBoundArray: () => array,
    getInstance: () => ({ modified() {} }),
    requestRender: () => {},
  });
  const pick = {
    nodeId: "mapper",
    pointsNodeId: "points",
    pointIndex: 0,
    world: [0, 0, 0],
    preview: "cloud",
  };

  preview.start({ pick });
  preview.move({ cloud_solve: { status: "hit", world: [5, 6, 7] } });
  preview.beforeApply();
  values[0] = 2;
  preview.reapply({
    ops: [
      {
        op: "patchArray",
        id: "points",
        key: "points",
        offset: 0,
        data: new Float32Array([2]),
        dataType: "Float32Array",
      },
    ],
  });
  assert.deepEqual(Array.from(values), [5, 6, 7]);

  preview.end();
  assert.deepEqual(Array.from(values), [2, 0, 0]);
});

test("cloud drag uses solved world hits instead of a screen plane", async () => {
  const { createDragPreview } = await loadModule(
    "/src/components/dragPreview.js",
  );
  const values = new Float32Array([0, 0, 0]);
  const array = { getData: () => values, modified() {} };
  const preview = createDragPreview({
    getBoundArray: () => array,
    getInstance: () => ({ modified() {} }),
    requestRender: () => {},
  });
  const pick = {
    nodeId: "mapper",
    pointsNodeId: "points",
    pointIndex: 0,
    world: [0, 0, 0],
    preview: "cloud",
  };

  assert.equal(preview.start({ pick }), true);
  assert.equal(
    preview.move({
      pointer: { x: 75, y: 50 },
      cloud_solve: { status: "hit", world: [2, 3, 4] },
    }),
    true,
  );
  assert.deepEqual(Array.from(values), [2, 3, 4]);

  preview.beforeApply();
  values.set([2, 3, 4]);
  preview.reapply({
    ops: [
      {
        op: "patchArray",
        id: "points",
        key: "points",
        offset: 0,
        data: new Float32Array([2, 3, 4]),
        dataType: "Float32Array",
      },
    ],
  });
  preview.move({
    pointer: { x: 80, y: 55 },
    cloud_solve: { status: "hit", world: [5, 6, 7] },
  });
  assert.deepEqual(Array.from(values), [5, 6, 7]);

  assert.equal(
    preview.move({
      pointer: { x: 85, y: 60 },
      cloud_solve: { status: "miss" },
    }),
    false,
  );
  assert.deepEqual(Array.from(values), [2, 3, 4]);

  preview.end({
    cloud_solve: { status: "hit", world: [8, 9, 10] },
  });
  // The terminal solve is still sent to the server, but it is not server
  // truth yet. Ending the overlay restores the last confirmed point.
  assert.deepEqual(Array.from(values), [2, 3, 4]);
});

test("ending after a lost cloud solve does not request another render", async () => {
  const { createDragPreview } = await loadModule(
    "/src/components/dragPreview.js",
  );
  const values = new Float32Array([0, 0, 0]);
  const array = { getData: () => values, modified() {} };
  let renders = 0;
  const preview = createDragPreview({
    getBoundArray: () => array,
    getInstance: () => ({ modified() {} }),
    requestRender: () => {
      renders += 1;
    },
  });

  preview.start({
    pick: {
      nodeId: "mapper",
      pointsNodeId: "points",
      pointIndex: 0,
      world: [0, 0, 0],
      preview: "cloud",
    },
  });
  preview.move({ cloud_solve: { status: "hit", world: [2, 3, 4] } });
  preview.move({ cloud_solve: { status: "miss" } });
  assert.equal(renders, 2);

  preview.end();
  assert.equal(renders, 2);
});

test("preview ends when the bound points array is structurally replaced", async () => {
  const { createDragPreview } = await loadModule(
    "/src/components/dragPreview.js",
  );
  // Two points [A, B]; the drag grabs A (index 0). Mid-drag the app
  // re-buckets A to another node, shrinking this array to [B]. With no point
  // identities available, writing through the stale index would move B.
  let values = new Float32Array([0, 0, 0, 9, 9, 9]);
  const array = { getData: () => values, modified() {} };
  const preview = createDragPreview({
    getCamera: () => ({
      getCompositeProjectionMatrix: () => IDENTITY,
      getDirectionOfProjection: () => [0, 0, -1],
    }),
    getViewportMetrics: () => ({ width: 100, height: 100, aspect: 1 }),
    getBoundArray: () => array,
    getInstance: () => ({ modified() {} }),
    requestRender: () => {},
  });
  const pick = {
    nodeId: "mapper",
    pointsNodeId: "points",
    pointIndex: 0,
    world: [0, 0, 0],
    preview: "screen",
  };

  assert.equal(preview.start({ pick }), true);
  assert.equal(preview.move({ pointer: { x: 75, y: 50 } }), true);
  assert.ok(Math.abs(values[0] - 0.5) < 1e-6);

  preview.beforeApply();
  values = new Float32Array([9, 9, 9]); // shrunk: index 0 is now B
  assert.equal(preview.reapply(), false);
  assert.deepEqual(Array.from(values), [9, 9, 9]);
  assert.equal(preview.move({ pointer: { x: 80, y: 50 } }), false);
});

test("preview follows the grabbed point id through same-size re-buckets", async () => {
  const { createDragPreview } = await loadModule(
    "/src/components/dragPreview.js",
  );
  // Bucket holds [A, B]; the drag grabs A (index 0, id "A"). Mid-drag the
  // app selects A away and backfills: the bucket becomes [B, C] — same
  // size, new membership. The stale index 0 now addresses B; the id list
  // says "A" is gone, so the preview must stop without touching B.
  const values = new Float32Array([0, 0, 0, 9, 9, 9]);
  const array = { getData: () => values, modified() {} };
  let ids = ["A", "B"];
  const preview = createDragPreview({
    getCamera: () => ({
      getCompositeProjectionMatrix: () => IDENTITY,
      getDirectionOfProjection: () => [0, 0, -1],
    }),
    getViewportMetrics: () => ({ width: 100, height: 100, aspect: 1 }),
    getBoundArray: () => array,
    getInstance: () => ({ modified() {} }),
    getPickableIds: () => ids,
    requestRender: () => {},
  });
  const pick = {
    nodeId: "mapper",
    pointsNodeId: "points",
    pointIndex: 0,
    pointId: "A",
    world: [0, 0, 0],
    preview: "screen",
  };

  assert.equal(preview.start({ pick }), true);
  assert.equal(preview.move({ pointer: { x: 75, y: 50 } }), true);
  assert.ok(Math.abs(values[0] - 0.5) < 1e-6);

  // Same-size membership swap: A left, C joined. Index 0 is now B.
  preview.beforeApply();
  ids = ["B", "C"];
  values.set([9, 9, 9, 8, 8, 8]);
  assert.equal(preview.reapply(), false);
  assert.deepEqual(Array.from(values), [9, 9, 9, 8, 8, 8]);
  assert.equal(preview.move({ pointer: { x: 80, y: 50 } }), false);
  assert.deepEqual(Array.from(values), [9, 9, 9, 8, 8, 8]);

  // Reorder WITHOUT eviction re-targets instead of ending: grab A again,
  // then swap A to index 1 — the preview writes A's new slot, not B's.
  ids = ["A", "B"];
  values.set([0, 0, 0, 9, 9, 9]);
  assert.equal(preview.start({ pick }), true);
  ids = ["B", "A"];
  values.set([9, 9, 9, 0, 0, 0]);
  assert.equal(preview.move({ pointer: { x: 75, y: 50 } }), true);
  assert.deepEqual(Array.from(values.slice(0, 3)), [9, 9, 9]);
  assert.ok(Math.abs(values[3] - 0.5) < 1e-6);
});

test("index-fallback pick survives ids arriving mid-drag", async () => {
  const { createDragPreview } = await loadModule(
    "/src/components/dragPreview.js",
  );
  // The pickable had no ids at pick time, so pointId is the numeric index
  // fallback (0). If the app publishes an ids block mid-drag, indexOf(0)
  // over string ids would return -1 and kill the preview — the pick must
  // stay on the index path instead.
  const values = new Float32Array([0, 0, 0, 9, 9, 9]);
  const array = { getData: () => values, modified() {} };
  let ids = null;
  const preview = createDragPreview({
    getCamera: () => ({
      getCompositeProjectionMatrix: () => IDENTITY,
      getDirectionOfProjection: () => [0, 0, -1],
    }),
    getViewportMetrics: () => ({ width: 100, height: 100, aspect: 1 }),
    getBoundArray: () => array,
    getInstance: () => ({ modified() {} }),
    getPickableIds: () => ids,
    requestRender: () => {},
  });
  const pick = {
    nodeId: "mapper",
    pointsNodeId: "points",
    pointIndex: 0,
    pointId: 0, // numeric fallback: no ids block at pick time
    world: [0, 0, 0],
    preview: "screen",
  };

  assert.equal(preview.start({ pick }), true);
  assert.equal(preview.move({ pointer: { x: 75, y: 50 } }), true);
  assert.ok(Math.abs(values[0] - 0.5) < 1e-6);

  // Ids arrive mid-drag (re-bucketing added identities); the index-fallback
  // pick keeps following index 0.
  ids = ["A", "B"];
  assert.equal(preview.move({ pointer: { x: 80, y: 50 } }), true);
  assert.ok(Math.abs(values[0] - 0.6) < 1e-6);

  // But a structural size change still ends it: without a pick-time id
  // there is no identity to re-target by, ids or not.
  const grown = new Float32Array([1, 1, 1, 9, 9, 9, 8, 8, 8]);
  array.getData = () => grown;
  assert.equal(preview.move({ pointer: { x: 85, y: 50 } }), false);
  assert.deepEqual(Array.from(grown), [1, 1, 1, 9, 9, 9, 8, 8, 8]);
  // The preview ended: back at its original size it still writes nothing.
  array.getData = () => values;
  assert.equal(preview.move({ pointer: { x: 90, y: 50 } }), false);
});

test("plane drag preview honors vtk.js row-major composite matrices", async () => {
  const { createDragPreview } = await loadModule(
    "/src/components/dragPreview.js",
  );
  // vtk.js returns composites row-major: a world->clip translation of +5 in x
  // carries its offset at index 3, not 12. An identity matrix (the test
  // above) cannot see a transpose mistake; this one can.
  const ROW_MAJOR_TRANSLATE_X = [
    1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ];
  const values = new Float32Array([-5, 0, 0]);
  const array = { getData: () => values, modified() {} };
  const preview = createDragPreview({
    getCamera: () => ({
      getCompositeProjectionMatrix: () => ROW_MAJOR_TRANSLATE_X,
      getDirectionOfProjection: () => [0, 0, -1],
    }),
    getViewportMetrics: () => ({ width: 100, height: 100, aspect: 1 }),
    getBoundArray: () => array,
    getInstance: () => ({ modified() {} }),
    requestRender: () => {},
  });
  const pick = {
    nodeId: "mapper",
    pointsNodeId: "points",
    pointIndex: 0,
    world: [-5, 0, 0],
    preview: "plane",
    plane: { origin: [0, 0, 0], normal: [0, 0, 1] },
  };

  assert.equal(preview.start({ pick }), true);
  // Pointer at canvas center unprojects through the translated frustum to
  // world x = -5; a column-major misread of the matrix lands near x = 0.
  assert.equal(preview.move({ pointer: { x: 50, y: 50 } }), true);
  assert.ok(Math.abs(values[0] + 5) < 1e-6, `x was ${values[0]}`);
  assert.ok(Math.abs(values[1]) < 1e-6, `y was ${values[1]}`);
  assert.ok(Math.abs(values[2]) < 1e-6, `z was ${values[2]}`);
});

test("release holds the drop point through delayed updates until its acknowledgement", async () => {
  const { createDragPreview } = await loadModule(
    "/src/components/dragPreview.js",
  );
  const values = new Float32Array([0, 0, 0]);
  const array = { getData: () => values, modified() {} };
  const preview = createDragPreview({ getBoundArray: () => array });
  const pick = {
    nodeId: "mapper",
    pointsNodeId: "points",
    pointIndex: 0,
    world: [0, 0, 0],
    preview: "cloud",
  };
  const hit = (x) => ({ cloud_solve: { status: "hit", world: [x, 0, 0] } });
  const command = (id) => ({
    name: "pointer.drag.end",
    payload: { gesture_id: id },
  });
  const patch = (x, commands = []) => {
    preview.beforeApply();
    values[0] = x;
    preview.reapply({
      ops: [
        {
          op: "patchArray",
          id: "points",
          key: "points",
          offset: 0,
          data: new Float32Array([x, 0, 0]),
          dataType: "Float32Array",
        },
      ],
      commands,
    });
  };

  preview.start({ pick, gesture_id: "first" });
  preview.move(hit(8));
  preview.release(hit(10));
  assert.equal(values[0], 10, "release must use the final pointer position");
  patch(2);
  assert.equal(values[0], 10);
  patch(5, [command("another-client")]);
  assert.equal(values[0], 10);
  // Server constraints may adjust the drop point: acknowledgement, not
  // coordinate equality, decides when server truth becomes visible.
  patch(9, [command("first")]);
  assert.equal(values[0], 9);
  patch(11);
  assert.equal(values[0], 11);

  preview.start({ pick, gesture_id: "second" });
  preview.move(hit(20));
  preview.release(hit(20));
  preview.beforeApply();
  preview.reapply({ commands: [command("first")] });
  assert.equal(
    values[0],
    20,
    "a stale acknowledgement must not end another drag",
  );
  preview.beforeApply();
  preview.reapply({ commands: [command("second")] });
  assert.equal(
    values[0],
    11,
    "a rejected or unchanged drop needs no point patch",
  );

  preview.start({ pick, gesture_id: "third" });
  preview.move(hit(30));
  preview.release(hit(30));
  preview.end();
  assert.equal(values[0], 11, "teardown must clear a pending release");

  preview.start({ pick, gesture_id: "fourth" });
  preview.move(hit(40));
  preview.release(hit(40));
  preview.start({ pick, gesture_id: "fifth" });
  assert.equal(
    values[0],
    40,
    "regrabbing must preserve the held drop position",
  );
  patch(35, [command("fourth")]);
  assert.equal(values[0], 40, "the previous drop must not move the new grab");
  preview.move(hit(50));
  preview.release(hit(50));
  patch(50, [command("fifth")]);
  assert.equal(values[0], 50);
});

test("independent releases retain both points through interleaved server replies", async () => {
  const { createDragPreview } = await loadModule(
    "/src/components/dragPreview.js",
  );
  const { createSceneEngine } = await loadModule(
    "/src/components/engine/sceneEngine.js",
  );
  const values = new Float32Array([0, 0, 0, 1, 0, 0]);
  const array = { getData: () => values, modified() {} };
  const preview = createDragPreview({ getBoundArray: () => array });
  const hit = (x) => ({ cloud_solve: { status: "hit", world: [x, 0, 0] } });
  const start = (index, gesture_id) =>
    preview.start({
      gesture_id,
      pick: {
        nodeId: "m",
        pointsNodeId: "p",
        pointIndex: index,
        preview: "cloud",
      },
    });
  let receive;
  let snapshotApplied;
  const ready = new Promise((resolve) => {
    snapshotApplied = resolve;
  });
  const session = {
    subscribe(_topic, callback) {
      receive = callback;
      return {};
    },
    unsubscribe() {},
    async call() {
      return { v: 2, rw: "1", seq: 0, root: "1", nodes: {}, blobs: {} };
    },
  };
  const engine = createSceneEngine({
    client: { getConnection: () => ({ getSession: () => session }) },
    rwId: "1",
    reconciler: {
      reset() {},
      applySnapshot() {},
      applyMessage(ops) {
        for (const op of ops) values.set(op.data, op.offset);
      },
    },
    mirror: { gcBlobCache() {}, size: () => 0 },
    cache: new Map(),
    callbacks: {
      beforeSnapshot: preview.end,
      onSnapshotApplied: snapshotApplied,
      beforeApply: preview.beforeApply,
      onApplied: preview.reapply,
    },
  });
  engine.start();
  await ready;
  let seq = 0;
  const patch = (ops, gesture_id = null) =>
    receive([
      {
        v: 2,
        rw: "1",
        baseSeq: seq++,
        seq,
        ops,
        blobs: {},
        commands: gesture_id
          ? [{ name: "pointer.drag.end", payload: { gesture_id } }]
          : [],
      },
    ]);
  start(0, "a");
  preview.move(hit(10));
  preview.release(hit(10));
  start(1, "b");
  preview.move(hit(20));
  preview.release(hit(20));
  assert.deepEqual(Array.from(values), [10, 0, 0, 20, 0, 0]);
  patch([{ op: "patchArray", offset: 0, data: [2] }]);
  assert.deepEqual(Array.from(values), [10, 0, 0, 20, 0, 0]);
  patch([{ op: "patchArray", offset: 0, data: [9] }], "a");
  assert.deepEqual(Array.from(values), [9, 0, 0, 20, 0, 0]);
  patch([{ op: "patchArray", offset: 4, data: [3] }], "foreign-client");
  assert.deepEqual(Array.from(values), [9, 0, 0, 20, 0, 0]);
  patch([], "b");
  assert.deepEqual(Array.from(values), [9, 0, 0, 1, 3, 0]);
  start(0, "cancel");
  preview.move(hit(40));
  preview.release({ cancelled: true });
  patch([], "cancel");
  assert.equal(values[0], 9);
  engine.stop();
});

test("a grouped preview follows bucket changes without touching another dataset", async () => {
  const { createDragPreview } = await loadModule(
    "/src/components/dragPreview.js",
  );
  const { applyPickableBlock, resolvePreviewTarget } = await loadModule(
    "/src/components/pickables.js",
  );
  const registry = new Map();
  const buffers = new Map();
  function bucket(nodeId, ids, values, group = "dataset-one") {
    const buffer = { getData: () => new Float32Array(values), modified() {} };
    const data = new Float32Array(values);
    buffer.getData = () => data;
    buffers.set(nodeId, buffer);
    applyPickableBlock(
      registry,
      nodeId,
      {
        ids,
        grabPx: 10,
        preview: "cloud",
        previewGroup: group,
      },
      { getInputData: () => nodeId },
    );
    return data;
  }
  const instances = { getInstanceId: (id) => id };
  const normal = bucket("normal", ["A", "B"], [0, 0, 0, 1, 0, 0]);
  const other = bucket("other", ["A"], [99, 0, 0], "dataset-two");
  const preview = createDragPreview({
    getBoundArray: (id) => buffers.get(id),
    getPickableIds: (id) => registry.get(id)?.ids,
    resolveTarget: (pick) => resolvePreviewTarget(registry, pick, instances),
  });
  const pick = {
    nodeId: "normal",
    pointsNodeId: "normal",
    pointIndex: 0,
    pointId: "A",
    preview: "cloud",
    previewGroup: "dataset-one",
  };
  const hit = (x) => ({ cloud_solve: { status: "hit", world: [x, 0, 0] } });
  preview.start({ pick, gesture_id: "drag" });
  preview.move(hit(10));
  preview.beforeApply();
  assert.equal(normal[0], 0);
  const remaining = bucket("normal", ["B"], [1, 0, 0]);
  const selected = bucket("selected", ["A"], [2, 0, 0]);
  preview.reapply();
  preview.move(hit(20));
  preview.release(hit(30));
  assert.deepEqual(Array.from(remaining), [1, 0, 0]);
  assert.deepEqual(Array.from(selected), [30, 0, 0]);
  assert.deepEqual(Array.from(other), [99, 0, 0]);
  preview.beforeApply();
  selected[0] = 25;
  preview.reapply({
    commands: [{ name: "pointer.drag.end", payload: { gesture_id: "drag" } }],
  });
  assert.equal(selected[0], 25);

  // Duplicate identities within one declared scope are unsafe to retarget.
  bucket("duplicate", ["A"], [55, 0, 0]);
  assert.equal(resolvePreviewTarget(registry, pick, instances), null);
  registry.delete("duplicate");
  preview.start({
    pick: { ...pick, nodeId: "selected", pointsNodeId: "selected" },
    gesture_id: "deleted",
  });
  preview.move(hit(40));
  preview.beforeApply();
  registry.delete("selected");
  preview.reapply();
  assert.equal(preview.move(hit(50)), false);
  assert.equal(other[0], 99);
});
