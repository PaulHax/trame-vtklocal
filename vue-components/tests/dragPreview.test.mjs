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
