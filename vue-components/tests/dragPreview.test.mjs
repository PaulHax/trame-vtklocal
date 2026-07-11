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
  values[0] = -1;
  values[3] = 9;
  preview.reapply();
  assert.ok(Math.abs(values[0] - 0.5) < 1e-6);
  assert.equal(values[3], 9);

  preview.end();
  values[0] = 2;
  assert.equal(preview.reapply(), false);
  assert.equal(values[0], 2);
  assert.equal(preview.targets("mapper"), false);
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

  values = new Float32Array([9, 9, 9]); // shrunk: index 0 is now B
  assert.equal(preview.reapply(), false);
  assert.deepEqual(Array.from(values), [9, 9, 9]);
  assert.equal(preview.isActive(), false);
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
  ids = ["B", "C"];
  values.set([9, 9, 9, 8, 8, 8]);
  assert.equal(preview.reapply(), false);
  assert.deepEqual(Array.from(values), [9, 9, 9, 8, 8, 8]);
  assert.equal(preview.isActive(), false);

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
  assert.equal(preview.isActive(), true);

  // But a structural size change still ends it: without a pick-time id
  // there is no identity to re-target by, ids or not.
  const grown = new Float32Array([1, 1, 1, 9, 9, 9, 8, 8, 8]);
  array.getData = () => grown;
  assert.equal(preview.move({ pointer: { x: 85, y: 50 } }), false);
  assert.equal(preview.isActive(), false);
  assert.deepEqual(Array.from(grown), [1, 1, 1, 9, 9, 9, 8, 8, 8]);
});

test("plane drag preview honors vtk.js row-major composite matrices", async () => {
  const { createDragPreview } = await loadModule(
    "/src/components/dragPreview.js",
  );
  // vtk.js returns composites row-major: a world->clip translation of +5 in x
  // carries its offset at index 3, not 12. An identity matrix (the test
  // above) cannot see a transpose mistake; this one can.
  const ROW_MAJOR_TRANSLATE_X = [
    1, 0, 0, 5,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
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
