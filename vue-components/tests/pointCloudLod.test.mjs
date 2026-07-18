import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

async function loadLodModule() {
  return loadModule("/src/components/pointCloudLod.js");
}

const BLOCK = {
  assetId: "cloud-1",
  revision: "rev1",
  endpoint: "/pointcloud/cloud-1/rev1",
  rootCube: { center: [0, 0, 0], halfSize: 0.5 },
  rootSpacing: 0.1,
  pointCount: 2,
  hasRgb: true,
  pointBudget: 100000,
};

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function makePct1(positions, rgb) {
  const pointCount = positions.length / 3;
  const bytes = 40 + positions.length * 4 + (rgb ? rgb.length : 0);
  const buffer = new ArrayBuffer(bytes);
  const view = new DataView(buffer);
  for (let i = 0; i < 4; i += 1) view.setUint8(i, "PCT1".charCodeAt(i));
  view.setUint32(4, pointCount, true);
  view.setUint32(8, rgb ? 1 : 0, true);
  view.setFloat64(16, 0, true);
  view.setFloat64(24, 0, true);
  view.setFloat64(32, 0, true);
  new Float32Array(buffer, 40, positions.length).set(positions);
  if (rgb) new Uint8Array(buffer, 40 + positions.length * 4, rgb.length).set(rgb);
  return buffer;
}

function stubFetch() {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/hierarchy/")) {
      return new Response(
        JSON.stringify({
          nodes: {
            "0-0-0-0": { pointCount: 2, children: [], page: null },
          },
        }),
        { status: 200 },
      );
    }
    return new Response(
      makePct1([0.1, 0.1, 0.1, -0.1, -0.1, -0.1], [255, 0, 0, 0, 200, 0]),
      { status: 200 },
    );
  };
  return calls;
}

function makeSceneStubs() {
  const anchorMapper = { isDeleted: () => false };
  const anchorActor = {
    // Server-synced actors carry visibility as 0/1 ints, not booleans.
    visibility: 1,
    getMapper: () => anchorMapper,
    getVisibility() {
      return this.visibility;
    },
    getUserMatrix: () => null,
    getProperty: () => ({ getPointSize: () => 3 }),
  };
  const added = [];
  const removed = [];
  const renderer = {
    getActors: () => [anchorActor, ...added],
    addActor: (actor) => added.push(actor),
    removeActor: (actor) => {
      removed.push(actor);
      const at = added.indexOf(actor);
      if (at >= 0) added.splice(at, 1);
    },
    getActiveCamera: () => ({
      getCompositeProjectionMatrix: () => IDENTITY.slice(),
      getPosition: () => [0, 0, 0],
      getViewAngle: () => 90,
    }),
    getViewport: () => [0, 0, 1, 1],
  };
  const renderWindow = { getViews: () => [{ getSize: () => [200, 100] }] };
  return { anchorMapper, anchorActor, renderer, renderWindow, added, removed };
}

async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("block + update streams tiles into the renderer and mirrors anchor state", async () => {
  const { applyPointCloudLodBlock, updatePointCloudLods, disposePointCloudLods } =
    await loadLodModule();
  const fetchCalls = stubFetch();
  const { anchorMapper, anchorActor, renderer, renderWindow, added } = makeSceneStubs();

  let renders = 0;
  const scheduleRender = () => {
    renders += 1;
  };
  const registry = new Map();
  applyPointCloudLodBlock(registry, "42", BLOCK, anchorMapper, scheduleRender);
  assert.equal(registry.size, 1);

  updatePointCloudLods(registry, { renderers: [renderer], renderWindow, scheduleRender });
  await settle();

  assert.ok(
    fetchCalls.some((url) => url === "/pointcloud/cloud-1/rev1/hierarchy/0-0-0-0.json"),
    `hierarchy fetched (${fetchCalls})`,
  );
  assert.ok(
    fetchCalls.some((url) => url === "/pointcloud/cloud-1/rev1/tile/0-0-0-0.bin"),
    `tile fetched (${fetchCalls})`,
  );
  assert.equal(added.length, 1, "one tile actor added");
  assert.ok(renders > 0, "renders were scheduled");
  // Anchor point size fanned out to the streamed tile actor.
  assert.equal(added[0].getProperty().getPointSize(), 3);

  // Visibility fans out with the server's int encoding: 0 hides, 1 shows.
  anchorActor.visibility = 0;
  updatePointCloudLods(registry, { renderers: [renderer], renderWindow, scheduleRender });
  assert.equal(added[0].getVisibility(), false, "int 0 hides streamed tiles");
  anchorActor.visibility = 1;
  updatePointCloudLods(registry, { renderers: [renderer], renderWindow, scheduleRender });
  assert.equal(added[0].getVisibility(), true, "int 1 shows streamed tiles");

  disposePointCloudLods(registry);
  assert.equal(registry.size, 0);
  assert.equal(added.length, 0, "tile actors removed on dispose");
});

test("tiles are hosted in the renderer containing the anchor, not the first", async () => {
  const { applyPointCloudLodBlock, updatePointCloudLods, disposePointCloudLods } =
    await loadLodModule();
  stubFetch();
  const { anchorMapper, renderer, renderWindow, added } = makeSceneStubs();
  // A synced renderer ahead of the anchor's (e.g. the annotation layer).
  const otherAdded = [];
  const otherRenderer = {
    ...renderer,
    getActors: () => [...otherAdded],
    addActor: (actor) => otherAdded.push(actor),
    removeActor: (actor) => {
      const at = otherAdded.indexOf(actor);
      if (at >= 0) otherAdded.splice(at, 1);
    },
  };

  const registry = new Map();
  const scheduleRender = () => {};
  applyPointCloudLodBlock(registry, "42", BLOCK, anchorMapper, scheduleRender);
  updatePointCloudLods(registry, {
    renderers: [otherRenderer, renderer],
    renderWindow,
    scheduleRender,
  });
  await settle();

  assert.equal(added.length, 1, "tile actor hosted with the anchor");
  assert.equal(otherAdded.length, 0, "no tile actors in the other renderer");
  disposePointCloudLods(registry);
});

test("a null block disposes the entry and its actors", async () => {
  const { applyPointCloudLodBlock, updatePointCloudLods } = await loadLodModule();
  stubFetch();
  const { anchorMapper, renderer, renderWindow, added, removed } =
    makeSceneStubs();

  const registry = new Map();
  const scheduleRender = () => {};
  applyPointCloudLodBlock(registry, "42", BLOCK, anchorMapper, scheduleRender);
  updatePointCloudLods(registry, { renderers: [renderer], renderWindow, scheduleRender });
  await settle();
  assert.equal(added.length, 1);

  applyPointCloudLodBlock(registry, "42", null, anchorMapper, scheduleRender);
  assert.equal(registry.size, 0);
  assert.equal(added.length, 0);
  assert.equal(removed.length, 1);
});

test("a revision change swaps the tile source endpoint", async () => {
  const { applyPointCloudLodBlock, updatePointCloudLods } = await loadLodModule();
  const fetchCalls = stubFetch();
  const { anchorMapper, renderer, renderWindow } = makeSceneStubs();

  const registry = new Map();
  const scheduleRender = () => {};
  applyPointCloudLodBlock(registry, "42", BLOCK, anchorMapper, scheduleRender);
  updatePointCloudLods(registry, { renderers: [renderer], renderWindow, scheduleRender });
  await settle();

  applyPointCloudLodBlock(
    registry,
    "42",
    { ...BLOCK, revision: "rev2", endpoint: "/pointcloud/cloud-1/rev2" },
    anchorMapper,
    scheduleRender,
  );
  updatePointCloudLods(registry, { renderers: [renderer], renderWindow, scheduleRender });
  await settle();

  assert.ok(
    fetchCalls.some((url) => url.startsWith("/pointcloud/cloud-1/rev2/")),
    `rev2 fetched (${fetchCalls})`,
  );
});

test("malformed blocks are ignored", async () => {
  const { applyPointCloudLodBlock } = await loadLodModule();
  const registry = new Map();
  applyPointCloudLodBlock(registry, "42", { endpoint: 7 }, null, () => {});
  applyPointCloudLodBlock(
    registry,
    "43",
    { ...BLOCK, rootCube: { center: [0, 0], halfSize: 1 } },
    null,
    () => {},
  );
  assert.equal(registry.size, 0);
});

test("recordPointCloudLodFrame is a safe no-op on empty or invalid input", async () => {
  const { recordPointCloudLodFrame } = await loadLodModule();
  // No throw on missing registry, empty registry, null controller, or a
  // non-finite/negative duration.
  recordPointCloudLodFrame(null, 12);
  recordPointCloudLodFrame(new Map(), 12);
  const registry = new Map();
  registry.set("x", { controller: null });
  recordPointCloudLodFrame(registry, Number.NaN);
  recordPointCloudLodFrame(registry, -5);
  recordPointCloudLodFrame(registry, 12);
});

test("worldSizeFactor sizes streamed tile splats in world units", async () => {
  const { applyPointCloudLodBlock, updatePointCloudLods, disposePointCloudLods } =
    await loadLodModule();
  stubFetch();
  const { anchorMapper, renderer, renderWindow, added } = makeSceneStubs();

  const registry = new Map();
  const scheduleRender = () => {};
  applyPointCloudLodBlock(
    registry,
    "42",
    { ...BLOCK, worldSizeFactor: 1.5 },
    anchorMapper,
    scheduleRender,
  );
  updatePointCloudLods(registry, { renderers: [renderer], renderWindow, scheduleRender });
  await settle();

  assert.equal(added.length, 1, "world-sized cloud streams a tile");
  // Root tile (level 0): splat diameter = rootSpacing * factor world units.
  const worldSize = added[0].getMapper().getWorldSize();
  assert.ok(
    Math.abs(worldSize - BLOCK.rootSpacing * 1.5) < 1e-12,
    `tile mapper carries the world-unit diameter, got ${worldSize}`,
  );

  disposePointCloudLods(registry);
});

test("without worldSizeFactor tile splats stay in screen-pixel mode", async () => {
  const { applyPointCloudLodBlock, updatePointCloudLods, disposePointCloudLods } =
    await loadLodModule();
  stubFetch();
  const { anchorMapper, renderer, renderWindow, added } = makeSceneStubs();

  const registry = new Map();
  const scheduleRender = () => {};
  applyPointCloudLodBlock(registry, "42", BLOCK, anchorMapper, scheduleRender);
  updatePointCloudLods(registry, { renderers: [renderer], renderWindow, scheduleRender });
  await settle();

  assert.equal(added.length, 1);
  assert.equal(added[0].getMapper().getWorldSize(), 0);

  disposePointCloudLods(registry);
});

test("an adaptive block streams tiles and accepts frame timings", async () => {
  const {
    applyPointCloudLodBlock,
    updatePointCloudLods,
    recordPointCloudLodFrame,
    disposePointCloudLods,
  } = await loadLodModule();
  stubFetch();
  const { anchorMapper, renderer, renderWindow, added } = makeSceneStubs();

  const registry = new Map();
  const scheduleRender = () => {};
  // adaptive: true enables the frame-time budget loop under the shared
  // GPU-memory pool's cap; minBudget is parsed through. The happy path must
  // be unaffected.
  applyPointCloudLodBlock(
    registry,
    "42",
    { ...BLOCK, adaptive: true, minBudget: 50000, interactionTargetMs: 33 },
    anchorMapper,
    scheduleRender,
  );
  updatePointCloudLods(registry, { renderers: [renderer], renderWindow, scheduleRender });
  await settle();
  assert.equal(added.length, 1, "adaptive cloud still streams a tile");

  // Feeding paint durations reaches the controller's recordFrame without error.
  for (let i = 0; i < 30; i += 1) recordPointCloudLodFrame(registry, 40);
  updatePointCloudLods(registry, { renderers: [renderer], renderWindow, scheduleRender });
  await settle();
  assert.equal(added.length, 1, "still streaming after adaptive frame feedback");

  disposePointCloudLods(registry);
  assert.equal(registry.size, 0);
});
