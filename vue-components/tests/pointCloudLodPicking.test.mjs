// Scoped point-cloud picking through the bridge: durable-identity scoping,
// host-renderer/live-UserMatrix camera conversion, hit/miss/unavailable
// semantics, and the cloud_solve gesture-enrichment policy.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";
import {
  IDENTITY,
  anchorGraph,
  loadLodModule,
  makePct1,
  stubFetch,
} from "./pointCloudLodFixtures.mjs";

after(async () => {
  await closeModuleLoader();
});

const BLOCK = {
  sourceAssetId: "asset-1",
  revision: "rev1",
  endpoint: "/pointcloud/cloud-1/rev1",
  pointCount: 2,
  presentation: { mode: "fixed", diameterCssPx: 3 },
  hasRgb: true,
  pointBudget: 100000,
};

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

// Two points in anchor-local coordinates. Under the identity camera they
// project to css (110, 45) and (90, 55) on the 200x100 viewport; under
// SIMILARITY they land at (130, 30) and (170, 50).

function makeAnchor() {
  const mapper = { isDeleted: () => false };
  const actor = {
    visibility: 1,
    userMatrix: null,
    deleted: false,
    mapper,
    isDeleted() {
      return this.deleted;
    },
    getMapper() {
      return this.mapper;
    },
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

function makeRenderer(anchors, composite = IDENTITY, viewport = [0, 0, 1, 1]) {
  const added = [];
  return {
    added,
    draw: true,
    getDraw() {
      return this.draw;
    },
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
    getViewport: () => viewport.slice(),
  };
}

const RENDER_WINDOW = { getViews: () => [{ getSize: () => [200, 100] }] };

// The pick reports the anchor ACTOR's node id so the consumer can check the
// transform's currency without rediscovering the mapper/actor pairing; the
// synchronizer context is what resolves an instance to its node id.
const ACTOR_NODE_ID = "actor-node";
const SYNC_CONTEXT = {
  getInstanceId: (instance) => (instance?.getMapper ? ACTOR_NODE_ID : null),
};

async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// The graph statement the anchor resolver reads: each cloud's anchor actor
// resolves live from the renderers' actor lists, so a test that deletes or
// swaps an actor is editing the graph too.
function graphFor(clouds, renderers) {
  const graph = anchorGraph();
  for (const renderer of renderers) graph.addRenderer(renderer);
  for (const { nodeId, mapper } of clouds) {
    graph.setAnchor(
      nodeId,
      () =>
        renderers
          .flatMap((renderer) => renderer.getActors?.() ?? [])
          .find((actor) => actor.getMapper?.() === mapper) ?? null,
    );
  }
  return graph;
}

// Apply a block per cloud, run the update pass, and let streaming settle.
// `update` re-runs the pass with the same context — what the post-apply pass
// does after a message changes the scene.
async function streamClouds(lod, clouds, renderers) {
  const registry = new Map();
  const scheduleRender = () => {};
  const graph = graphFor(clouds, renderers);
  for (const { nodeId, block, mapper } of clouds) {
    lod.applyPointCloudLodBlock(
      registry,
      nodeId,
      block,
      mapper,
      scheduleRender,
    );
  }
  const update = () =>
    lod.updatePointCloudLods(registry, {
      renderers,
      renderWindow: RENDER_WINDOW,
      scheduleRender,
      referrersOf: graph.referrersOf,
      getInstance: graph.getInstance,
    });
  update();
  await settle();
  updatePassFor.set(registry, update);
  return registry;
}

// The post-apply update pass belonging to each streamed registry.
const updatePassFor = new WeakMap();

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
    synchronizerContext: SYNC_CONTEXT,
  });

  assert.equal(solve.status, "hit");
  // Provenance comes from the matched entry, not the request.
  assert.equal(solve.asset_id, "asset-1");
  assert.equal(solve.revision, "rev1");
  assert.deepEqual(solve.nodes, ["42", ACTOR_NODE_ID]);
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
    synchronizerContext: SYNC_CONTEXT,
  });

  assert.deepEqual(solve, {
    status: "miss",
    asset_id: "asset-1",
    revision: "rev1",
    nodes: ["42", ACTOR_NODE_ID],
  });
  lod.disposePointCloudLods(registry);
});

test("a solve reports the anchor actor's node id, and is unavailable without one", async () => {
  const lod = await loadLodModule();
  stubFetch();
  const anchor = makeAnchor();
  const renderer = makeRenderer([anchor]);
  const registry = await streamClouds(
    lod,
    [{ nodeId: "42", block: BLOCK, mapper: anchor.mapper }],
    [renderer],
  );

  // The solve names both nodes it was measured through: the mapper carrying
  // the LOD block, and the actor carrying the UserMatrix the answer was
  // converted through. The consumer needs both to prove the solve is not
  // stale, and cannot pair them itself without re-deriving the association
  // the client already resolved.
  const solve = lod.pickPointCloudPoint(registry, "asset-1", 130, 30, {
    renderWindow: RENDER_WINDOW,
    synchronizerContext: SYNC_CONTEXT,
  });
  assert.deepEqual(solve.nodes, ["42", ACTOR_NODE_ID]);

  // An actor the synchronizer cannot name leaves the transform's currency
  // unprovable, so the query is unavailable — never a miss, which would
  // authorize the caller's fallback.
  for (const context of [
    { renderWindow: RENDER_WINDOW },
    {
      renderWindow: RENDER_WINDOW,
      synchronizerContext: { getInstanceId: () => null },
    },
  ]) {
    assert.equal(
      lod.pickPointCloudPoint(registry, "asset-1", 130, 30, context),
      null,
    );
  }
  lod.disposePointCloudLods(registry);
});

test("unknown, duplicate, hidden, unresolved and invalid-transform queries are unavailable", async () => {
  const lod = await loadLodModule();
  stubFetch();
  const context = {
    renderWindow: RENDER_WINDOW,
    synchronizerContext: SYNC_CONTEXT,
  };
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
  const context = {
    renderWindow: RENDER_WINDOW,
    synchronizerContext: SYNC_CONTEXT,
  };
  const solveA = lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context);
  assert.equal(solveA.status, "hit");
  assert.deepEqual(solveA.nodes, ["42", ACTOR_NODE_ID]);

  // Scoping to B must answer from B alone: an explicit miss under B's own
  // provenance, never A's hit wearing B's name.
  const solveB = lod.pickPointCloudPoint(registry, "asset-B", 110, 45, context);
  assert.deepEqual(solveB, {
    status: "miss",
    asset_id: "asset-B",
    revision: "revB",
    nodes: ["43", ACTOR_NODE_ID],
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
    synchronizerContext: SYNC_CONTEXT,
  });
  assert.equal(solve.status, "hit", "host renderer camera resolves the pick");

  lod.disposePointCloudLods(registry);
});

test("cursor coordinates are shifted into the host renderer's viewport", async () => {
  const lod = await loadLodModule();
  stubFetch();
  const anchor = makeAnchor();
  // The host renderer draws into the bottom-right quadrant of a 400x200
  // canvas: a 200x100 viewport whose canvas-css origin is (200, 100).
  const renderer = makeRenderer([anchor], IDENTITY, [0.5, 0, 1, 0.5]);
  const renderWindow = { getViews: () => [{ getSize: () => [400, 200] }] };
  const registry = new Map();
  const graph = graphFor([{ nodeId: "42", mapper: anchor.mapper }], [renderer]);
  lod.applyPointCloudLodBlock(registry, "42", BLOCK, anchor.mapper, () => {});
  lod.updatePointCloudLods(registry, {
    renderers: [renderer],
    renderWindow,
    scheduleRender: () => {},
    referrersOf: graph.referrersOf,
    getInstance: graph.getInstance,
  });
  await settle();
  assert.equal(renderer.added.length, 1, "tile streamed");

  const context = { renderWindow, synchronizerContext: SYNC_CONTEXT };
  // The cloud point renders at viewport-local (110, 45), i.e. canvas
  // (310, 145). The canvas cursor there must resolve as a dead-on hit...
  const solve = lod.pickPointCloudPoint(registry, "asset-1", 310, 145, context);
  assert.equal(solve.status, "hit");
  assert.ok(solve.distance_px < 1e-3, `cursor-exact hit: ${solve.distance_px}`);

  // ...while the same numbers read as viewport-local (the pre-conversion
  // interpretation) sit in another renderer's quadrant, out of every bucket.
  const offset = lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context);
  assert.equal(offset.status, "miss");

  lod.disposePointCloudLods(registry);
});

test("a non-drawing host renderer makes the scoped pick unavailable", async () => {
  const lod = await loadLodModule();
  stubFetch();
  const anchor = makeAnchor();
  const renderer = makeRenderer([anchor]);
  const registry = await streamClouds(
    lod,
    [{ nodeId: "42", block: BLOCK, mapper: anchor.mapper }],
    [renderer],
  );
  const context = {
    renderWindow: RENDER_WINDOW,
    synchronizerContext: SYNC_CONTEXT,
  };
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context).status,
    "hit",
  );

  // The renderer leaves the draw pass with the anchor still visible and the
  // tiles retained: nothing on screen can support a depth, so the answer is
  // unavailable — never a fallback-authorizing miss, never a blind hit.
  renderer.draw = false;
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context),
    null,
  );
  renderer.draw = true;
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context).status,
    "hit",
  );

  lod.disposePointCloudLods(registry);
});

test("a dead or re-parented anchor makes the scoped pick unavailable", async () => {
  const lod = await loadLodModule();
  stubFetch();
  const anchor = makeAnchor();
  const anchors = [anchor];
  const renderer = makeRenderer(anchors);
  const registry = await streamClouds(
    lod,
    [{ nodeId: "42", block: BLOCK, mapper: anchor.mapper }],
    [renderer],
  );
  const context = {
    renderWindow: RENDER_WINDOW,
    synchronizerContext: SYNC_CONTEXT,
  };
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context).status,
    "hit",
  );

  // Deleted anchor actor: the entry's cached actor is no longer touchable.
  anchor.actor.deleted = true;
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context),
    null,
  );
  anchor.actor.deleted = false;

  // Re-bound mapper: the actor no longer presents this entry's cloud.
  anchor.actor.mapper = { isDeleted: () => false };
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context),
    null,
  );
  anchor.actor.mapper = anchor.mapper;

  // Actor gone from its cached host renderer (the server re-staged the
  // layer): the cached camera is nobody's camera now. Topology only changes
  // inside an applied message, so the post-apply pass has re-resolved the
  // anchor before any pick can run.
  anchors.pop();
  updatePassFor.get(registry)();
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context),
    null,
  );
  // Re-staged back: the next post-apply pass re-resolves and re-streams.
  anchors.push(anchor);
  updatePassFor.get(registry)();
  await settle();
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context).status,
    "hit",
  );

  lod.disposePointCloudLods(registry);
});

test("controller and camera boundary failures are unavailable, never misses", async () => {
  const lod = await loadLodModule();
  stubFetch();
  const anchor = makeAnchor();
  const renderer = makeRenderer([anchor]);
  const registry = await streamClouds(
    lod,
    [{ nodeId: "42", block: BLOCK, mapper: anchor.mapper }],
    [renderer],
  );
  const context = {
    renderWindow: RENDER_WINDOW,
    synchronizerContext: SYNC_CONTEXT,
  };
  // The cursor sits dead on a rendered point: every null below is a refusal.
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context).status,
    "hit",
  );

  // No usable render window: the host renderer's camera cannot be read.
  assert.equal(lod.pickPointCloudPoint(registry, "asset-1", 110, 45, {}), null);
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-1", 110, 45, {
      renderWindow: { getViews: () => [] },
    }),
    null,
  );

  // Non-finite cursor: the library refuses the query; that refusal must
  // surface as unavailable, not be dressed up as an empty sweep.
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-1", NaN, 45, context),
    null,
  );
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-1", 110, Infinity, context),
    null,
  );

  // Disposed controller (the library's own unavailable state): same rule.
  registry.get("42").controller.dispose();
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context),
    null,
  );

  lod.disposePointCloudLods(registry);
});

test("a re-applied block refreshes the identity picking answers with", async () => {
  const lod = await loadLodModule();
  stubFetch();
  const anchor = makeAnchor();
  const renderer = makeRenderer([anchor]);
  const registry = await streamClouds(
    lod,
    [{ nodeId: "42", block: BLOCK, mapper: anchor.mapper }],
    [renderer],
  );
  const context = {
    renderWindow: RENDER_WINDOW,
    synchronizerContext: SYNC_CONTEXT,
  };
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context).revision,
    "rev1",
  );

  // A revision bump on the same entry must reach provenance immediately: a
  // stale revision would fail the server's currency check against a solve
  // that really did run against the current cloud.
  lod.applyPointCloudLodBlock(
    registry,
    "42",
    { ...BLOCK, revision: "rev2" },
    anchor.mapper,
    () => {},
  );
  const bumped = lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context);
  assert.equal(bumped.status, "hit");
  assert.equal(bumped.revision, "rev2");

  // A re-anchored source id moves the scope with it: the old identity stops
  // answering and the new one owns the entry.
  lod.applyPointCloudLodBlock(
    registry,
    "42",
    { ...BLOCK, sourceAssetId: "asset-2", revision: "rev2" },
    anchor.mapper,
    () => {},
  );
  assert.equal(
    lod.pickPointCloudPoint(registry, "asset-1", 110, 45, context),
    null,
  );
  const renamed = lod.pickPointCloudPoint(
    registry,
    "asset-2",
    110,
    45,
    context,
  );
  assert.equal(renamed.status, "hit");
  assert.equal(renamed.asset_id, "asset-2");

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

// --- armed pick spec: click-time override ---------------------------------

test("an armed spec enriches background clicks against the armed cloud", async () => {
  const { enrichGestureWithCloudSolve } = await loadLodModule();
  const calls = [];
  const solve = { status: "hit", asset_id: "asset-armed" };
  const payload = gesturePayload({ type: "background.click", pick: null });

  const enriched = enrichGestureWithCloudSolve(
    payload,
    (...args) => {
      calls.push(args);
      return solve;
    },
    "asset-armed",
  );

  assert.deepEqual(calls, [["asset-armed", 105, 47]]);
  assert.equal(enriched.cloud_solve, solve);
  assert.equal(payload.cloud_solve, undefined);
});

test("an armed spec overrides a conflicting glyph tag on target.click", async () => {
  const { enrichGestureWithCloudSolve } = await loadLodModule();
  const calls = [];
  const payload = gesturePayload({
    type: "target.click",
    pick: { nodeId: "9", tags: { depth_asset_id: "asset-decoy" } },
  });

  const enriched = enrichGestureWithCloudSolve(
    payload,
    (...args) => {
      calls.push(args);
      return { status: "hit", asset_id: "asset-armed" };
    },
    "asset-armed",
  );

  assert.deepEqual(calls, [["asset-armed", 105, 47]]);
  assert.equal(enriched.cloud_solve.asset_id, "asset-armed");
});

test("an armed spec never redirects drag enrichment", async () => {
  const { enrichGestureWithCloudSolve } = await loadLodModule();
  for (const type of [
    "target.drag.start",
    "target.drag.move",
    "target.drag.end",
  ]) {
    // Tagged drag: the tag stays authoritative.
    const calls = [];
    enrichGestureWithCloudSolve(
      gesturePayload({ type }),
      (...args) => {
        calls.push(args);
        return { status: "hit" };
      },
      "asset-armed",
    );
    assert.deepEqual(calls, [["asset-1", 105, 47]], `${type} solves its tag`);

    // Untagged drag: armed or not, nothing solves.
    const untagged = gesturePayload({ type, pick: { nodeId: "9", tags: {} } });
    const result = enrichGestureWithCloudSolve(
      untagged,
      () => {
        throw new Error(`must not solve untagged ${type}`);
      },
      "asset-armed",
    );
    assert.equal(result, untagged);
  }
});

test("armed cancelled, unresolved or pointerless clicks are never solved", async () => {
  const { enrichGestureWithCloudSolve } = await loadLodModule();
  const untouched = [
    gesturePayload({ type: "background.click", pick: null, pointer: null }),
    gesturePayload({ type: "background.click", pick: null, cancelled: true }),
    gesturePayload({ type: "target.click", unresolved: true }),
  ];
  for (const payload of untouched) {
    const result = enrichGestureWithCloudSolve(
      payload,
      () => {
        throw new Error("must not solve");
      },
      "asset-armed",
    );
    assert.equal(result, payload);
  }
});

test("an armed unavailable scoped query still attaches nothing", async () => {
  const { enrichGestureWithCloudSolve } = await loadLodModule();
  const payload = gesturePayload({ type: "background.click", pick: null });
  const result = enrichGestureWithCloudSolve(
    payload,
    () => null,
    "asset-armed",
  );
  assert.equal(result, payload);
  assert.equal("cloud_solve" in result, false);
});

test("an absent spec leaves clicks byte-identical to the tag-based policy", async () => {
  const { enrichGestureWithCloudSolve } = await loadLodModule();
  for (const armed of [null, undefined]) {
    // background.click carries no pick, so nothing solves — and the absence
    // of a cloud_solve is not a miss the server may act on.
    const background = gesturePayload({ type: "background.click", pick: null });
    const untouched = enrichGestureWithCloudSolve(
      background,
      () => {
        throw new Error("must not solve a disarmed background click");
      },
      armed,
    );
    assert.equal(untouched, background);
    assert.equal("cloud_solve" in untouched, false);

    // target.click keeps solving its own tag exactly as before.
    const calls = [];
    const solve = { status: "hit", asset_id: "asset-1" };
    const tagged = enrichGestureWithCloudSolve(
      gesturePayload({ type: "target.click" }),
      (...args) => {
        calls.push(args);
        return solve;
      },
      armed,
    );
    assert.deepEqual(calls, [["asset-1", 105, 47]]);
    assert.equal(tagged.cloud_solve, solve);
  }
});

// --- the delivering seam: useSceneSync wiring, no stubs on either side ----

// A real gesture over a real streamed cloud: the pickable block and the LOD
// block both arrive through useSceneSync's registered handlers, the drag runs
// through the scene's own gesture machine, and the emitted pointerEvent must
// carry a cloud_solve answered by the scene's own scoped query — the exact
// closure-and-hook chain a green stub suite cannot vouch for.
test("a drag on a tagged pickable emits a pointerEvent carrying the real scoped solve", async () => {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");
  const [glyph, polydata, points] = await Promise.all([
    loadModule("/node_modules/@kitware/vtk.js/Rendering/Core/Glyph3DMapper.js"),
    loadModule("/node_modules/@kitware/vtk.js/Common/DataModel/PolyData.js"),
    loadModule("/node_modules/@kitware/vtk.js/Common/Core/Points.js"),
  ]);
  stubFetch();

  const anchor = makeAnchor();
  const renderer = makeRenderer([anchor]);
  // Synced-renderer marker so the scene enumerates this renderer.
  renderer.get = () => ({ remoteId: "1", managedInstanceId: "1" });
  const canvas = {
    style: { cursor: "" },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  const renderWindow = {
    getRenderers: () => [renderer],
    getViews: () => [{ getSize: () => [200, 100], getCanvas: () => canvas }],
  };

  // A real glyph mapper backs the pickable, its one point on the streamed
  // cloud point, so the grab lands exactly where the cloud solve must.
  const glyphMapper = glyph.default.newInstance();
  const poly = polydata.default.newInstance();
  const pts = points.default.newInstance();
  pts.setData(new Float32Array([0.1, 0.1, 0.1]), 3);
  poly.setPoints(pts);
  glyphMapper.setInputData(poly);

  const events = [];
  const blockHandlers = new Map();
  const scene = useSceneSync(
    {
      client: {},
      emit: (type, payload) => events.push([type, payload]),
      getRenderWindow: () => renderWindow,
      renderScene() {},
    },
    {
      createManagedSyncContext: () => ({
        synchronizerContext: {
          // Resolves the mirrored node ids to their live instances — the
          // anchor resolver reads the pairing from the mirror, then asks
          // here for the objects.
          getInstance: (id) =>
            id === "42-actor" ? anchor.actor : id === "1" ? renderer : null,
          // The real context resolves any synced instance to its node id;
          // the pick asks it for the anchor actor's, to name in the solve's
          // staleness list.
          getInstanceId: (instance) =>
            instance === anchor.actor ? ACTOR_NODE_ID : null,
        },
        syncRenderWindow: renderWindow,
        cleanup() {},
      }),
      // The mirrored graph statement the anchor resolver reads: the actor
      // node rides mapper node "42", hosted by synced renderer node "1".
      createMirrorStore: () => ({
        entries: () =>
          new Map([
            ["42-actor", { refs: { mapper: "42" } }],
            ["1", { refs: { viewProps: ["42-actor"] } }],
          ]).entries(),
        get: () => null,
        applyOps() {},
        clear() {},
        gcBlobCache() {},
        toObject: () => ({}),
      }),
      createReconciler: () => ({
        registerBlockHandler(key, handler) {
          blockHandlers.set(key, handler);
          return () => {};
        },
        teardown() {},
      }),
      createSceneEngine: () => ({
        start() {},
        stop() {},
        resync() {},
        onCommand: () => () => {},
        getSeq: () => 5,
        getDiagnostics: () => ({}),
      }),
    },
  );
  scene.initialize({ contextName: "ctx-cloud-solve", renderWindowId: 1 });

  blockHandlers.get("pointCloudLod")("42", BLOCK, anchor.mapper);
  blockHandlers.get("pickable")(
    "9",
    { grabPx: 8, priority: 0, tags: { depth_asset_id: "asset-1" } },
    glyphMapper,
  );
  scene.beforeRender();
  await settle();
  assert.equal(renderer.added.length, 1, "tile streamed through the scene");

  const started = scene.startTargetDrag({
    clientX: 110,
    clientY: 45,
    pointerId: 1,
    preventDefault() {},
    stopImmediatePropagation() {},
  });
  assert.equal(started, true, "the tagged glyph grabs");

  const pointerEvents = events.filter(([type]) => type === "pointerEvent");
  assert.equal(pointerEvents.length, 1);
  const payload = pointerEvents[0][1];
  assert.equal(payload.type, "target.drag.start");
  assert.equal(payload.pick.tags.depth_asset_id, "asset-1");
  const solve = payload.cloud_solve;
  assert.ok(solve, "the emitted payload carries the scoped solve");
  assert.equal(solve.status, "hit");
  assert.equal(solve.asset_id, "asset-1");
  assert.equal(solve.revision, "rev1");
  assert.deepEqual(solve.nodes, ["42", ACTOR_NODE_ID]);
  for (const axis of [0, 1, 2]) {
    assert.ok(
      Math.abs(solve.world[axis] - 0.1) < 1e-6,
      `world[${axis}] = ${solve.world[axis]} ≈ 0.1`,
    );
  }

  scene.cleanup();
});

// The armed spec through the same real seam: setArmedCloudPick drives the
// scene's own click enrichment — background clicks solve, a conflicting glyph
// tag loses, and disarming restores the exact tag-based behavior.
test("setArmedCloudPick governs the clicks the scene emits", async () => {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");
  const [glyph, polydata, points] = await Promise.all([
    loadModule("/node_modules/@kitware/vtk.js/Rendering/Core/Glyph3DMapper.js"),
    loadModule("/node_modules/@kitware/vtk.js/Common/DataModel/PolyData.js"),
    loadModule("/node_modules/@kitware/vtk.js/Common/Core/Points.js"),
  ]);
  stubFetch();

  const anchor = makeAnchor();
  const renderer = makeRenderer([anchor]);
  renderer.get = () => ({ remoteId: "1", managedInstanceId: "1" });
  const canvas = {
    style: { cursor: "" },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  const renderWindow = {
    getRenderers: () => [renderer],
    getViews: () => [{ getSize: () => [200, 100], getCanvas: () => canvas }],
  };

  // The glyph sits on the first cloud point but is tagged with a DIFFERENT
  // asset id: the armed spec must win over it.
  const glyphMapper = glyph.default.newInstance();
  const poly = polydata.default.newInstance();
  const pts = points.default.newInstance();
  pts.setData(new Float32Array([0.1, 0.1, 0.1]), 3);
  poly.setPoints(pts);
  glyphMapper.setInputData(poly);

  const events = [];
  const blockHandlers = new Map();
  const scene = useSceneSync(
    {
      client: {},
      emit: (type, payload) => events.push([type, payload]),
      getRenderWindow: () => renderWindow,
      renderScene() {},
    },
    {
      createManagedSyncContext: () => ({
        synchronizerContext: {
          // Resolves the mirrored node ids to their live instances — the
          // anchor resolver reads the pairing from the mirror, then asks
          // here for the objects.
          getInstance: (id) =>
            id === "42-actor" ? anchor.actor : id === "1" ? renderer : null,
          getInstanceId: (instance) =>
            instance === anchor.actor ? ACTOR_NODE_ID : null,
        },
        syncRenderWindow: renderWindow,
        cleanup() {},
      }),
      // The mirrored graph statement the anchor resolver reads: the actor
      // node rides mapper node "42", hosted by synced renderer node "1".
      createMirrorStore: () => ({
        entries: () =>
          new Map([
            ["42-actor", { refs: { mapper: "42" } }],
            ["1", { refs: { viewProps: ["42-actor"] } }],
          ]).entries(),
        get: () => null,
        applyOps() {},
        clear() {},
        gcBlobCache() {},
        toObject: () => ({}),
      }),
      createReconciler: () => ({
        registerBlockHandler(key, handler) {
          blockHandlers.set(key, handler);
          return () => {};
        },
        teardown() {},
      }),
      createSceneEngine: () => ({
        start() {},
        stop() {},
        resync() {},
        onCommand: () => () => {},
        getSeq: () => 5,
        getDiagnostics: () => ({}),
      }),
    },
  );
  scene.initialize({ contextName: "ctx-armed-pick", renderWindowId: 1 });

  blockHandlers.get("pointCloudLod")("42", BLOCK, anchor.mapper);
  blockHandlers.get("pickable")(
    "9",
    { grabPx: 8, priority: 0, tags: { depth_asset_id: "asset-decoy" } },
    glyphMapper,
  );
  scene.beforeRender();
  await settle();
  assert.equal(renderer.added.length, 1, "tile streamed through the scene");

  const click = (clientX, clientY) =>
    scene.emitTargetClick({
      clientX,
      clientY,
      preventDefault() {},
      stopImmediatePropagation() {},
    });
  const lastPointerEvent = () =>
    events.filter(([type]) => type === "pointerEvent").at(-1)[1];

  // Disarmed background click: no pick, no tag, nothing attaches (≠ miss).
  click(90, 55);
  let payload = lastPointerEvent();
  assert.equal(payload.type, "background.click");
  assert.equal("cloud_solve" in payload, false);

  // Disarmed target click: the decoy tag names an unknown cloud, so the
  // scoped query is unavailable and nothing attaches — the tag-based policy.
  click(110, 45);
  payload = lastPointerEvent();
  assert.equal(payload.type, "target.click");
  assert.equal(payload.pick.tags.depth_asset_id, "asset-decoy");
  assert.equal("cloud_solve" in payload, false);

  // Armed background click solves against the armed cloud.
  scene.setArmedCloudPick("asset-1");
  click(90, 55);
  payload = lastPointerEvent();
  assert.equal(payload.type, "background.click");
  assert.equal(payload.cloud_solve?.status, "hit");
  assert.equal(payload.cloud_solve.asset_id, "asset-1");
  for (const axis of [0, 1, 2]) {
    assert.ok(
      Math.abs(payload.cloud_solve.world[axis] + 0.1) < 1e-6,
      `world[${axis}] = ${payload.cloud_solve.world[axis]} ≈ -0.1`,
    );
  }

  // Armed target click over the conflicting glyph resolves against the
  // armed cloud, not the decoy tag.
  click(110, 45);
  payload = lastPointerEvent();
  assert.equal(payload.type, "target.click");
  assert.equal(payload.pick.tags.depth_asset_id, "asset-decoy");
  assert.equal(payload.cloud_solve?.status, "hit");
  assert.equal(payload.cloud_solve.asset_id, "asset-1");

  // Scene re-initialization (a supported lifecycle: shared views re-init on
  // external-context changes) must not disarm — the server owns the spec and
  // pushed no change. Both armed click kinds keep solving after the re-init
  // rebuilds the streamed cloud and the decoy pickable.
  scene.initialize({ contextName: "ctx-armed-pick", renderWindowId: 1 });
  blockHandlers.get("pointCloudLod")("42", BLOCK, anchor.mapper);
  blockHandlers.get("pickable")(
    "9",
    { grabPx: 8, priority: 0, tags: { depth_asset_id: "asset-decoy" } },
    glyphMapper,
  );
  scene.beforeRender();
  await settle();
  click(90, 55);
  payload = lastPointerEvent();
  assert.equal(payload.type, "background.click");
  assert.equal(payload.cloud_solve?.status, "hit", "armed across re-init");
  assert.equal(payload.cloud_solve.asset_id, "asset-1");
  click(110, 45);
  payload = lastPointerEvent();
  assert.equal(payload.type, "target.click");
  assert.equal(payload.pick.tags.depth_asset_id, "asset-decoy");
  assert.equal(payload.cloud_solve?.status, "hit");
  assert.equal(payload.cloud_solve.asset_id, "asset-1");

  // Disarming restores the exact prior behavior for both click kinds.
  scene.setArmedCloudPick(null);
  click(90, 55);
  payload = lastPointerEvent();
  assert.equal(payload.type, "background.click");
  assert.equal("cloud_solve" in payload, false);
  click(110, 45);
  payload = lastPointerEvent();
  assert.equal(payload.type, "target.click");
  assert.equal("cloud_solve" in payload, false);

  scene.cleanup();
});
