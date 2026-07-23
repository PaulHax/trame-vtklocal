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
  pointCount: 2,
  presentation: { mode: "fixed", diameterCssPx: 3 },
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
  if (rgb)
    new Uint8Array(buffer, 40 + positions.length * 4, rgb.length).set(rgb);
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
            "0-0-0-0": {
              pointCount: 2,
              children: [],
              page: null,
              bounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
              spacing: 0.1,
            },
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
  const {
    applyPointCloudLodBlock,
    updatePointCloudLods,
    describePointCloudLodRegistry,
    disposePointCloudLods,
  } = await loadLodModule();
  const fetchCalls = stubFetch();
  const { anchorMapper, anchorActor, renderer, renderWindow, added, removed } =
    makeSceneStubs();

  let renders = 0;
  const scheduleRender = () => {
    renders += 1;
  };
  const registry = new Map();
  applyPointCloudLodBlock(registry, "42", BLOCK, anchorMapper, scheduleRender);
  assert.equal(registry.size, 1);

  updatePointCloudLods(registry, {
    renderers: [renderer],
    renderWindow,
    scheduleRender,
  });
  await settle();

  assert.ok(
    fetchCalls.some(
      (url) => url === "/pointcloud/cloud-1/rev1/hierarchy/0-0-0-0.json",
    ),
    `hierarchy fetched (${fetchCalls})`,
  );
  assert.ok(
    fetchCalls.some(
      (url) => url === "/pointcloud/cloud-1/rev1/tile/0-0-0-0.bin",
    ),
    `tile fetched (${fetchCalls})`,
  );
  assert.equal(added.length, 1, "one tile actor added");
  assert.ok(renders > 0, "renders were scheduled");
  // Anchor point size fanned out to the streamed tile actor.
  assert.equal(added[0].getProperty().getPointSize(), 3);

  // Hiding deactivates draw immediately, then destroys renderer resources
  // while retaining the decoded payload in the controller's bounded LRU.
  const firstTileActor = added[0];
  const tileFetchesBefore = fetchCalls.filter((url) =>
    url.includes("/tile/"),
  ).length;
  anchorActor.visibility = 0;
  updatePointCloudLods(registry, {
    renderers: [renderer],
    renderWindow,
    scheduleRender,
  });
  assert.equal(
    removed.includes(firstTileActor),
    true,
    "int 0 removes draw resources immediately",
  );
  await settle();
  assert.equal(added.length, 0, "hidden cloud owns no tile actors");
  assert.equal(
    removed.includes(firstTileActor),
    true,
    "hidden tile actor was removed",
  );
  const hidden = describePointCloudLodRegistry(registry)[0];
  assert.deepEqual(
    {
      residentActorTiles: hidden.residentActorTiles,
      gpuResidentBytes: hidden.gpuResidentBytes,
      activeDrawTiles: hidden.activeDrawTiles,
      active: hidden.stats.active,
      residentTiles: hidden.stats.residentTiles,
      cachedTiles: hidden.stats.cachedTiles,
      decodedTiles: hidden.stats.decodedTiles,
      memoryBudgetBytes: hidden.stats.memoryBudgetBytes,
    },
    {
      residentActorTiles: 0,
      gpuResidentBytes: 0,
      activeDrawTiles: 0,
      active: false,
      residentTiles: 0,
      cachedTiles: 1,
      decodedTiles: 1,
      memoryBudgetBytes: 0,
    },
  );

  // Re-showing rebuilds the actor from decoded cache without network I/O.
  anchorActor.visibility = 1;
  updatePointCloudLods(registry, {
    renderers: [renderer],
    renderWindow,
    scheduleRender,
  });
  await settle();
  assert.equal(added.length, 1, "visible cloud rebuilds one tile actor");
  assert.equal(added[0].getVisibility(), true, "int 1 shows streamed tiles");
  assert.equal(
    fetchCalls.filter((url) => url.includes("/tile/")).length,
    tileFetchesBefore,
    "decoded cache avoids a tile refetch",
  );

  disposePointCloudLods(registry);
  assert.equal(registry.size, 0);
  assert.equal(added.length, 0, "tile actors removed on dispose");
});

test("an initially hidden cloud defers hierarchy and tile requests until shown", async () => {
  const {
    applyPointCloudLodBlock,
    updatePointCloudLods,
    disposePointCloudLods,
  } = await loadLodModule();
  const fetchCalls = stubFetch();
  const { anchorMapper, anchorActor, renderer, renderWindow, added } =
    makeSceneStubs();
  anchorActor.visibility = 0;
  const registry = new Map();
  const context = {
    renderers: [renderer],
    renderWindow,
    scheduleRender: () => {},
  };

  applyPointCloudLodBlock(registry, "42", BLOCK, anchorMapper, () => {});
  updatePointCloudLods(registry, context);
  await settle();
  assert.deepEqual(fetchCalls, []);
  assert.equal(added.length, 0);

  anchorActor.visibility = 1;
  updatePointCloudLods(registry, context);
  await settle();
  assert.equal(
    fetchCalls.some((url) => url.includes("/hierarchy/")),
    true,
  );
  assert.equal(
    fetchCalls.some((url) => url.includes("/tile/")),
    true,
  );
  assert.equal(added.length, 1);
  disposePointCloudLods(registry);
});

test("tiles are hosted in the renderer containing the anchor, not the first", async () => {
  const {
    applyPointCloudLodBlock,
    updatePointCloudLods,
    disposePointCloudLods,
  } = await loadLodModule();
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
  const { applyPointCloudLodBlock, updatePointCloudLods } =
    await loadLodModule();
  stubFetch();
  const { anchorMapper, renderer, renderWindow, added, removed } =
    makeSceneStubs();

  const registry = new Map();
  const scheduleRender = () => {};
  applyPointCloudLodBlock(registry, "42", BLOCK, anchorMapper, scheduleRender);
  updatePointCloudLods(registry, {
    renderers: [renderer],
    renderWindow,
    scheduleRender,
  });
  await settle();
  assert.equal(added.length, 1);

  applyPointCloudLodBlock(registry, "42", null, anchorMapper, scheduleRender);
  assert.equal(registry.size, 0);
  assert.equal(added.length, 0);
  assert.equal(removed.length, 1);
});

test("a revision change swaps the tile source endpoint", async () => {
  const { applyPointCloudLodBlock, updatePointCloudLods } =
    await loadLodModule();
  const fetchCalls = stubFetch();
  const { anchorMapper, renderer, renderWindow } = makeSceneStubs();

  const registry = new Map();
  const scheduleRender = () => {};
  applyPointCloudLodBlock(registry, "42", BLOCK, anchorMapper, scheduleRender);
  updatePointCloudLods(registry, {
    renderers: [renderer],
    renderWindow,
    scheduleRender,
  });
  await settle();

  applyPointCloudLodBlock(
    registry,
    "42",
    { ...BLOCK, revision: "rev2", endpoint: "/pointcloud/cloud-1/rev2" },
    anchorMapper,
    scheduleRender,
  );
  updatePointCloudLods(registry, {
    renderers: [renderer],
    renderWindow,
    scheduleRender,
  });
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
    { ...BLOCK, presentation: { mode: "fixed", diameterCssPx: -1 } },
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

test("interaction begins reach controllers synchronously", async () => {
  const { beginPointCloudLodInteraction } = await loadLodModule();
  const calls = [];
  const registry = new Map([
    ["x", { controller: { beginInteraction: () => calls.push("begin") } }],
  ]);

  beginPointCloudLodInteraction(registry);
  assert.deepEqual(calls, ["begin"]);
});

test("a synchronous interaction end preserves the lifecycle pair", async () => {
  const {
    beginPointCloudLodInteraction,
    endPointCloudLodInteraction,
  } = await loadLodModule();
  const calls = [];
  const registry = new Map([
    [
      "x",
      {
        controller: {
          beginInteraction: () => calls.push("begin"),
          endInteraction: () => calls.push("end"),
        },
      },
    ],
  ]);

  beginPointCloudLodInteraction(registry);
  endPointCloudLodInteraction(registry);

  assert.deepEqual(calls, ["begin", "end"]);
});

test("nested controller interactions preserve every lifecycle event", async () => {
  const {
    beginPointCloudLodInteraction,
    endPointCloudLodInteraction,
  } = await loadLodModule();
  const calls = [];
  const registry = new Map([
    [
      "x",
      {
        controller: {
          beginInteraction: () => calls.push("begin"),
          endInteraction: () => calls.push("end"),
        },
      },
    ],
  ]);

  beginPointCloudLodInteraction(registry);
  beginPointCloudLodInteraction(registry);
  endPointCloudLodInteraction(registry);
  assert.deepEqual(calls, ["begin", "begin", "end"]);

  endPointCloudLodInteraction(registry);
  assert.deepEqual(calls, ["begin", "begin", "end", "end"]);
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
  updatePointCloudLods(registry, {
    renderers: [renderer],
    renderWindow,
    scheduleRender,
  });
  await settle();
  assert.equal(added.length, 1, "adaptive cloud still streams a tile");

  // Feeding paint durations reaches the controller's recordFrame without error.
  for (let i = 0; i < 30; i += 1) recordPointCloudLodFrame(registry, 40);
  updatePointCloudLods(registry, {
    renderers: [renderer],
    renderWindow,
    scheduleRender,
  });
  await settle();
  assert.equal(
    added.length,
    1,
    "still streaming after adaptive frame feedback",
  );

  disposePointCloudLods(registry);
  assert.equal(registry.size, 0);
});

test("refinementCutoffPx reaches the controller and updates in place", async () => {
  const {
    applyPointCloudLodBlock,
    updatePointCloudLods,
    describePointCloudLodRegistry,
    disposePointCloudLods,
  } = await loadLodModule();
  stubFetch();
  const { anchorMapper, renderer, renderWindow } = makeSceneStubs();
  const registry = new Map();
  const scheduleRender = () => {};

  applyPointCloudLodBlock(
    registry,
    "42",
    { ...BLOCK, refinementCutoffPx: 0.5 },
    anchorMapper,
    scheduleRender,
  );
  updatePointCloudLods(registry, {
    renderers: [renderer],
    renderWindow,
    scheduleRender,
  });
  await settle();
  assert.equal(
    describePointCloudLodRegistry(registry)[0].stats.refinementCutoffPx,
    0.5,
  );

  applyPointCloudLodBlock(
    registry,
    "42",
    { ...BLOCK, refinementCutoffPx: 0.25 },
    anchorMapper,
    scheduleRender,
  );
  updatePointCloudLods(registry, {
    renderers: [renderer],
    renderWindow,
    scheduleRender,
  });
  assert.equal(
    describePointCloudLodRegistry(registry)[0].stats.refinementCutoffPx,
    0.25,
  );
  disposePointCloudLods(registry);
});

test("camera selection uses the inverse of anchor translation rotation and scale", async () => {
  const { cameraInAnchorCoordinates } = await loadLodModule();
  const similarity = [
    0, 2, 0, 0,
    -2, 0, 0, 0,
    0, 0, 2, 0,
    5, 6, 7, 1,
  ];
  const view = {
    viewProj: IDENTITY,
    position: [5, 8, 7],
    fovY: Math.PI / 3,
    viewportHeightCssPx: 600,
  };

  const local = cameraInAnchorCoordinates(view, similarity);

  assert.deepEqual(local.position.map((value) => Math.round(value)), [1, 0, 0]);
  assert.deepEqual(local.viewProj, similarity);
  assert.equal(local.fovY, view.fovY);
  assert.equal(local.viewportHeightCssPx, 600);
});

test("viewport height is measured in CSS pixels at non-unit DPR", async () => {
  const { getViewportHeight } = await loadLodModule();
  const previous = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 2;
  try {
    const renderer = { getViewport: () => [0, 0.25, 1, 0.75] };
    const renderWindow = { getViews: () => [{ getSize: () => [800, 600] }] };
    assert.equal(getViewportHeight(renderer, renderWindow), 150);
  } finally {
    if (previous === undefined) delete globalThis.devicePixelRatio;
    else globalThis.devicePixelRatio = previous;
  }
});
