import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

async function loadPresentationModule() {
  return loadModule("/src/components/pointCloudPresentation.js");
}

test("direct point-cloud mapper tracks device-pixel ratio for CSS sizing", async () => {
  const {
    applyPointCloudPresentationBlock,
    updatePointCloudPresentations,
  } = await loadPresentationModule();
  const previous = globalThis.devicePixelRatio;
  const values = [];
  const mapper = {
    isDeleted: () => false,
    setScaleFactor: (value) => values.push(value),
  };
  const registry = new Map();
  try {
    globalThis.devicePixelRatio = 2;
    applyPointCloudPresentationBlock(
      registry,
      "mapper-1",
      { mode: "fixed", diameterCssPx: 3 },
      mapper,
    );
    globalThis.devicePixelRatio = 1.25;
    updatePointCloudPresentations(registry);
  } finally {
    if (previous === undefined) delete globalThis.devicePixelRatio;
    else globalThis.devicePixelRatio = previous;
  }

  assert.deepEqual(values, [2, 1.25]);
  assert.equal(registry.size, 1);
});

test("invalid blocks and deleted mappers are removed", async () => {
  const {
    applyPointCloudPresentationBlock,
    updatePointCloudPresentations,
  } = await loadPresentationModule();
  const mapper = {
    deleted: false,
    isDeleted() {
      return this.deleted;
    },
    setScaleFactor: () => {},
  };
  const registry = new Map();
  applyPointCloudPresentationBlock(
    registry,
    "mapper-1",
    { mode: "fixed", diameterCssPx: 2 },
    mapper,
  );
  mapper.deleted = true;
  updatePointCloudPresentations(registry);
  assert.equal(registry.size, 0);

  applyPointCloudPresentationBlock(
    registry,
    "mapper-2",
    { mode: "auto", userScale: 1 },
    mapper,
  );
  assert.equal(registry.size, 0);
});
