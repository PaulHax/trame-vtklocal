// Scoped point-cloud picking through the bridge: durable-identity scoping,
// host-renderer/live-UserMatrix camera conversion, hit/miss/unavailable
// semantics, and the cloud_solve gesture-enrichment policy.
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
  sourceAssetId: "asset-1",
  revision: "rev1",
  endpoint: "/pointcloud/cloud-1/rev1",
  pointCount: 2,
  presentation: { mode: "fixed", diameterCssPx: 3 },
  hasRgb: true,
  pointBudget: 100000,
};

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// Rotation by 90 degrees about z, uniform scale 2, translation kept small so
// the transformed cloud stays inside the identity camera's frustum.
// prettier-ignore
const SIMILARITY = [
  0, 2, 0, 0,
  -2, 0, 0, 0,
  0, 0, 2, 0,
  0.5, 0.2, 0, 1,
];

// Anisotropic scale: not a similarity, so anchor-camera conversion refuses it.
// prettier-ignore
const NON_SIMILARITY = [
  1, 0, 0, 0,
  0, 2, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

// Pushes the cloud past the far plane (clip z > w), so every point of a cloud
// carrying it is rejected by the sweep: visible elsewhere-cloud, empty here.
// prettier-ignore
const BEHIND_FAR_PLANE = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 5, 1,
];

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

// Two points in anchor-local coordinates. Under the identity camera they
// project to css (110, 45) and (90, 55) on the 200x100 viewport; under
// SIMILARITY they land at (130, 30) and (170, 50).
const POSITIONS = [0.1, 0.1, 0.1, -0.1, -0.1, -0.1];

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
    return new Response(makePct1(POSITIONS, [255, 0, 0, 0, 200, 0]), {
      status: 200,
    });
  };
  return calls;
}

function makeAnchor() {
  const mapper = { isDeleted: () => false };
  const actor = {
    visibility: 1,
    userMatrix: null,
    getMapper: () => mapper,
    getVisibility() {
      return this.visibility;
    },
    getUserMatrix() {
      return this.userMatrix;
    },
    getProperty: () => ({ getPointSize: () => 3 }),
  };
  return { mapper, actor };
}

function makeRenderer(anchors, composite = IDENTITY) {
  const added = [];
  return {
    added,
    getActors: () => [...anchors.map((anchor) => anchor.actor), ...added],
    addActor: (actor) => added.push(actor),
    removeActor: (actor) => {
      const at = added.indexOf(actor);
      if (at >= 0) added.splice(at, 1);
    },
    getActiveCamera: () => ({
      getCompositeProjectionMatrix: () => composite.slice(),
      getPosition: () => [0, 0, 0],
      getParallelProjection: () => false,
      getParallelScale: () => 1,
      getViewAngle: () => 90,
    }),
    getViewport: () => [0, 0, 1, 1],
  };
}

const RENDER_WINDOW = { getViews: () => [{ getSize: () => [200, 100] }] };

async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// Apply a block per cloud, run the update pass, and let streaming settle.
async function streamClouds(lod, clouds, renderers) {
  const registry = new Map();
  const scheduleRender = () => {};
  for (const { nodeId, block, mapper } of clouds) {
    lod.applyPointCloudLodBlock(
      registry,
      nodeId,
      block,
      mapper,
      scheduleRender,
    );
  }
  lod.updatePointCloudLods(registry, {
    renderers,
    renderWindow: RENDER_WINDOW,
    scheduleRender,
  });
  await settle();
  return registry;
}

test("a scoped pick hits through the LIVE anchor matrix and lands in display world", async () => {
  const lod = await loadLodModule();
  stubFetch();
  const anchor = makeAnchor();
  const renderer = makeRenderer([anchor]);
  const registry = await streamClouds(
    lod,
    [{ nodeId: "42", block: BLOCK, mapper: anchor.mapper }],
    [renderer],
  );
  assert.equal(renderer.added.length, 1, "tile streamed");

  // The similarity is installed AFTER streaming, with no further update pass:
  // the pick must read the matrix live, not the one selection last saw.
  anchor.actor.userMatrix = SIMILARITY;
  const solve = lod.pickPointCloudPoint(registry, "asset-1", 130, 30, {
    renderWindow: RENDER_WINDOW,
  });

  assert.equal(solve.status, "hit");
  // Provenance comes from the matched entry, not the request.
  assert.equal(solve.asset_id, "asset-1");
  assert.equal(solve.revision, "rev1");
  assert.equal(solve.node_id, "42");
  // Anchor-local hit (0.1, 0.1, 0.1) through the live similarity:
  // rotate 90° about z, scale 2, translate (0.5, 0.2, 0) → (0.3, 0.4, 0.2).
  const expected = [0.3, 0.4, 0.2];
  for (const axis of [0, 1, 2]) {
    assert.ok(
      Math.abs(solve.world[axis] - expected[axis]) < 1e-6,
      `world[${axis}] = ${solve.world[axis]} ≈ ${expected[axis]}`,
    );
  }
  assert.ok(solve.distance_px < 1e-3, `cursor-exact hit: ${solve.distance_px}`);

  lod.disposePointCloudLods(registry);
});

test("a valid sweep with nothing nearby is an explicit miss carrying provenance", async () => {
  const lod = await loadLodModule();
  stubFetch();
  const anchor = makeAnchor();
  const renderer = makeRenderer([anchor]);
  const registry = await streamClouds(
    lod,
    [{ nodeId: "42", block: BLOCK, mapper: anchor.mapper }],
    [renderer],
  );

  anchor.actor.userMatrix = SIMILARITY;
  // Both points sit more than the largest (100 css px) bucket away.
  const solve = lod.pickPointCloudPoint(registry, "asset-1", 5, 95, {
    renderWindow: RENDER_WINDOW,
  });

  assert.deepEqual(solve, {
    status: "miss",
    asset_id: "asset-1",
    revision: "rev1",
    node_id: "42",
  });
  lod.disposePointCloudLods(registry);
});

test("unknown, duplicate, hidden, unresolved and invalid-transform queries are unavailable", async () => {
  const lod = await loadLodModule();
  stubFetch();
  const context = { renderWindow: RENDER_WINDOW };
  const anchor = makeAnchor();
  const renderer = makeRenderer([anchor]);
  const registry = await streamClouds(
    lod,
    [{ nodeId: "42", block: BLOCK, mapper: anchor.mapper }],
    [renderer],
  );
  // The cursor sits exactly on a rendered point, so every null below is the
  // query refusing, never an empty sweep.
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context).status,
    "hit",
  );

  // Unknown identity: no entry may answer for it.
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-nope", 110, 45, context),
    null,
  );

  // Invalid transform: a non-similarity anchor matrix has no honest inverse
  // camera, so the scoped query is unavailable rather than solved wrong.
  anchor.actor.userMatrix = NON_SIMILARITY;
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context),
    null,
  );
  anchor.actor.userMatrix = null;

  // Hidden cloud: what the user cannot see must not support a depth.
  anchor.actor.visibility = 0;
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context),
    null,
  );
  anchor.actor.visibility = 1;

  // Duplicate identity: "which cloud?" has no answer, so neither is picked —
  // even though the first entry alone would hit.
  const duplicate = makeAnchor();
  lod.applyPointCloudLodBlock(
    registry,
    "43",
    { ...BLOCK, endpoint: "/pointcloud/cloud-2/rev1" },
    duplicate.mapper,
    () => {},
  );
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context),
    null,
  );
  lod.applyPointCloudLodBlock(registry, "43", null, duplicate.mapper, () => {});

  // Unresolved anchor: a block whose anchor never landed has no controller.
  const orphanRegistry = new Map();
  lod.applyPointCloudLodBlock(orphanRegistry, "7", BLOCK, null, () => {});
  assert.equal(
    lod.pickPointCloudPoint(orphanRegistry, "asset-1", 110, 45, context),
    null,
  );

  lod.disposePointCloudLods(registry);
  lod.disposePointCloudLods(orphanRegistry);
});

test("a pick scoped to one asset never falls through to another visible cloud", async () => {
  const lod = await loadLodModule();
  stubFetch();
  const anchorA = makeAnchor();
  const anchorB = makeAnchor();
  // Cloud B's points sit past the far plane: its sweep is valid and empty.
  anchorB.actor.userMatrix = BEHIND_FAR_PLANE;
  const renderer = makeRenderer([anchorA, anchorB]);
  const registry = await streamClouds(
    lod,
    [
      { nodeId: "42", block: BLOCK, mapper: anchorA.mapper },
      {
        nodeId: "43",
        block: {
          ...BLOCK,
          sourceAssetId: "asset-B",
          revision: "revB",
          endpoint: "/pointcloud/cloud-2/revB",
        },
        mapper: anchorB.mapper,
      },
    ],
    [renderer],
  );

  // The cursor is dead on cloud A's rendered point.
  const context = { renderWindow: RENDER_WINDOW };
  const solveA = lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context);
  assert.equal(solveA.status, "hit");
  assert.equal(solveA.node_id, "42");

  // Scoping to B must answer from B alone: an explicit miss under B's own
  // provenance, never A's hit wearing B's name.
  const solveB = lod.pickPointCloudPoint(registry, "asset-B", 110, 45, context);
  assert.deepEqual(solveB, {
    status: "miss",
    asset_id: "asset-B",
    revision: "revB",
    node_id: "43",
  });

  lod.disposePointCloudLods(registry);
});

test("the pick runs under the entry's host renderer camera, not the primary", async () => {
  const lod = await loadLodModule();
  stubFetch();
  const anchor = makeAnchor();
  // The primary (first) renderer's camera shifts everything two NDC units
  // left: under it the cloud would be hundreds of css px from the cursor.
  // prettier-ignore
  const decoyComposite = [
    1, 0, 0, -2,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
  const decoy = makeRenderer([], decoyComposite);
  const host = makeRenderer([anchor]);
  const registry = await streamClouds(
    lod,
    [{ nodeId: "42", block: BLOCK, mapper: anchor.mapper }],
    [decoy, host],
  );
  assert.equal(host.added.length, 1, "tiles hosted with the anchor");

  const solve = lod.pickPointCloudPoint(registry, "asset-1", 110, 45, {
    renderWindow: RENDER_WINDOW,
  });
  assert.equal(solve.status, "hit", "host renderer camera resolves the pick");

  lod.disposePointCloudLods(registry);
});

test("a block without durable identity is unusable", async () => {
  const { applyPointCloudLodBlock } = await loadLodModule();
  const registry = new Map();
  const withoutId = { ...BLOCK };
  delete withoutId.sourceAssetId;
  const withoutRevision = { ...BLOCK };
  delete withoutRevision.revision;
  applyPointCloudLodBlock(registry, "42", withoutId, null, () => {});
  applyPointCloudLodBlock(registry, "43", withoutRevision, null, () => {});
  applyPointCloudLodBlock(
    registry,
    "44",
    { ...BLOCK, sourceAssetId: 7 },
    null,
    () => {},
  );
  assert.equal(registry.size, 0);
});

// --- cloud_solve gesture-enrichment policy -------------------------------

function gesturePayload(overrides = {}) {
  return {
    type: "target.drag.move",
    seq: 3,
    pointer: { x: 105, y: 47 },
    viewport: { width: 200, height: 100, dpr: 1 },
    camera: {},
    pick: { nodeId: "9", tags: { depth_asset_id: "asset-1" } },
    context: null,
    ...overrides,
  };
}

test("enrichment solves the tagged pointer ray and attaches cloud_solve", async () => {
  const { enrichGestureWithCloudSolve } = await loadLodModule();
  const calls = [];
  const solve = { status: "hit", asset_id: "asset-1" };
  const payload = gesturePayload();

  const enriched = enrichGestureWithCloudSolve(payload, (...args) => {
    calls.push(args);
    return solve;
  });

  // The solved ray is the payload's own pointer — grab offset already applied.
  assert.deepEqual(calls, [["asset-1", 105, 47]]);
  assert.equal(enriched.cloud_solve, solve);
  assert.equal(enriched.type, payload.type);
  // The original payload is never mutated.
  assert.equal(payload.cloud_solve, undefined);
});

test("unresolved or cancelled terminal events are never solved into misses", async () => {
  const { enrichGestureWithCloudSolve } = await loadLodModule();
  const untouched = [
    // Terminal end whose pointer never resolved.
    gesturePayload({
      type: "target.drag.end",
      pointer: null,
      cancelled: true,
      unresolved: true,
    }),
    // Cancelled with a live pointer (pointercancel mid-drag).
    gesturePayload({ type: "target.drag.end", cancelled: true }),
    // No pointer at all.
    gesturePayload({ pointer: null }),
    // Untagged gesture: not an LOD-cloud pick.
    gesturePayload({ pick: { nodeId: "9", tags: { owner_id: "landmarks" } } }),
    gesturePayload({ pick: null }),
    // Hover traffic never solves.
    gesturePayload({ type: "target.enter" }),
    gesturePayload({ type: "target.leave" }),
  ];
  for (const payload of untouched) {
    const result = enrichGestureWithCloudSolve(payload, () => {
      throw new Error(`must not solve ${payload.type}`);
    });
    assert.equal(result, payload);
    assert.equal("cloud_solve" in result, false);
  }
});

test("an unavailable scoped query leaves the payload without a cloud_solve", async () => {
  const { enrichGestureWithCloudSolve } = await loadLodModule();
  const payload = gesturePayload();
  const result = enrichGestureWithCloudSolve(payload, () => null);
  assert.equal(result, payload);
  assert.equal("cloud_solve" in result, false);
});
