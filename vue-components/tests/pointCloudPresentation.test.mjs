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

function makeMapper() {
  return {
    deleted: false,
    scaleFactors: [],
    isDeleted() {
      return this.deleted;
    },
    setScaleFactor(value) {
      this.scaleFactors.push(value);
    },
  };
}

test("a mapper deleted after registration is dropped on the next update", async () => {
  const {
    applyPointCloudPresentationBlock,
    updatePointCloudPresentations,
  } = await loadPresentationModule();
  const mapper = makeMapper();
  const registry = new Map();
  applyPointCloudPresentationBlock(
    registry,
    "mapper-1",
    { mode: "fixed", diameterCssPx: 2 },
    mapper,
  );
  assert.equal(registry.size, 1);

  mapper.deleted = true;
  updatePointCloudPresentations(registry);
  assert.equal(registry.size, 0);
});

test("a live mapper is registered only for a fixed block with a positive diameter", async () => {
  const { applyPointCloudPresentationBlock } = await loadPresentationModule();
  const registry = new Map();

  for (const block of [
    { mode: "auto", userScale: 1 },
    { mode: "fixed", diameterCssPx: 0 },
    { mode: "fixed" },
    null,
  ]) {
    const mapper = makeMapper();
    applyPointCloudPresentationBlock(registry, "mapper-1", block, mapper);
    assert.equal(registry.size, 0, `registered for ${JSON.stringify(block)}`);
    assert.deepEqual(mapper.scaleFactors, []);
  }

  const mapper = makeMapper();
  applyPointCloudPresentationBlock(
    registry,
    "mapper-1",
    { mode: "fixed", diameterCssPx: 2 },
    mapper,
  );
  assert.equal(registry.size, 1);

  // Switching a registered mapper back to auto releases it.
  applyPointCloudPresentationBlock(
    registry,
    "mapper-1",
    { mode: "auto", userScale: 1 },
    mapper,
  );
  assert.equal(registry.size, 0);
});
