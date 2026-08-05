// Anchor lifecycle and budget configuration: what a cloud draws must always be
// what its current wire block asks for, and a cloud whose anchor is gone must
// stop drawing and stop claiming a share of the view budget.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";
import { IDENTITY, anchorGraph, stubFetch } from "./pointCloudLodFixtures.mjs";

after(async () => {
  await closeModuleLoader();
});

const BLOCK = {
  sourceAssetId: "asset-1",
  revision: "rev1",
  endpoint: "/pointcloud/cloud-1/rev1",
  pointCount: 2,
  presentation: { mode: "fixed", diameterCssPx: 3 },
  pointBudget: 100000,
};

// Floor and maximum pinned together, so the adaptive aggregate is one number
// the assertions can name instead of whatever the loop has learned so far.
const pinnedAdaptive = (points, targets = {}) => ({
  adaptive: true,
  adaptiveOptions: { minBudget: points, maxBudget: points, ...targets },
});

async function settle(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function makeAnchor(mapper) {
  return {
    // Server-synced actors carry visibility as 0/1 ints, not booleans.
    visibility: 1,
    getMapper: () => mapper,
    getVisibility() {
      return this.visibility;
    },
    getUserMatrix: () => null,
    getProperty: () => ({ getPointSize: () => 3 }),
  };
}

function makeRenderer() {
  const actors = [];
  return {
    actors,
    getActors: () => actors,
    addActor: (actor) => actors.push(actor),
    removeActor: (actor) => {
      const at = actors.indexOf(actor);
      if (at >= 0) actors.splice(at, 1);
    },
    getActiveCamera: () => ({
      getCompositeProjectionMatrix: () => IDENTITY.slice(),
      getPosition: () => [0, 0, 0],
      getParallelProjection: () => false,
      getParallelScale: () => 1,
      getViewAngle: () => 90,
    }),
    getViewport: () => [0, 0, 1, 1],
  };
}

// One view with two renderers (world geometry and annotations, as a real view
// layers them) and a registry driven exactly the way the host drives it.
async function makeView() {
  const module = await loadModule("/src/components/pointCloudLod.js");
  const fetchCalls = stubFetch();
  const renderers = [makeRenderer(), makeRenderer()];
  const renderWindow = { getViews: () => [{ getSize: () => [200, 100] }] };
  const registry = new Map();
  const clouds = new Map();
  // The graph statement the anchor resolver reads. Anchors resolve through a
  // getter so a test swapping `cloud.anchor` is also editing the graph.
  const graph = anchorGraph();
  for (const renderer of renderers) graph.addRenderer(renderer);
  let renders = 0;
  const scheduleRender = () => {
    renders += 1;
  };

  const apply = (id, block) => {
    let cloud = clouds.get(id);
    if (!cloud) {
      const mapper = { isDeleted: () => false };
      cloud = { mapper, anchor: makeAnchor(mapper) };
      clouds.set(id, cloud);
      graph.setAnchor(id, () => clouds.get(id)?.anchor);
    }
    module.applyPointCloudLodBlock(
      registry,
      id,
      block === null ? null : { ...BLOCK, ...block },
      cloud.mapper,
      scheduleRender,
    );
    return cloud;
  };

  return {
    ...module,
    registry,
    renderers,
    fetchCalls,
    apply,
    cloud: (id) => clouds.get(id),
    // Actors the LOD stack put in a renderer: everything that is not an anchor.
    tileActors: (renderer = renderers[0]) =>
      renderer.actors.filter(
        (actor) =>
          ![...clouds.values()].some((cloud) => cloud.anchor === actor),
      ),
    tileFetches: () =>
      fetchCalls.filter((url) => url.includes("/tile/")).length,
    renders: () => renders,
    update: () =>
      module.updatePointCloudLods(registry, {
        renderers,
        renderWindow,
        scheduleRender,
        referrersOf: graph.referrersOf,
        getInstance: graph.getInstance,
      }),
    row: (id) =>
      module
        .describePointCloudLodRegistry(registry)
        .find((entry) => entry.id === id),
    governor: () => module.describePointCloudLodGovernor(registry),
    dispose: () => module.disposePointCloudLods(registry),
  };
}

// One applied message plus the frames it takes to stream what it asked for.
async function streamed(view) {
  view.update();
  await settle();
  view.update();
  await settle();
}

test("an anchor that disappears releases its actors and its view-budget share", async () => {
  const view = await makeView();
  try {
    const cloud = view.apply("42", pinnedAdaptive(300000));
    view.renderers[0].addActor(cloud.anchor);
    await streamed(view);
    assert.equal(view.tileActors().length, 1, "streaming before the removal");
    assert.equal(view.governor().activeMembers, 1);

    // The scene drops the anchor: the layer was re-staged, or the asset was
    // unloaded, and no block arrived to say so.
    view.renderers[0].removeActor(cloud.anchor);
    view.update();

    assert.equal(view.tileActors().length, 0, "no tiles left in the renderer");
    assert.deepEqual(view.governor().members, [], "membership released");
    assert.equal(view.governor().aggregateBudget, 300000);
    // The entry keeps its configuration so the anchor can come back.
    assert.equal(view.registry.size, 1);
    assert.equal(view.row("42").hasController, false);
    assert.equal(view.row("42").endpoint, BLOCK.endpoint);
    assert.equal(view.row("42").anchorVisible, null);
  } finally {
    view.dispose();
  }
});

test("an anchor that comes back rebuilds the cloud from its retained block", async () => {
  const view = await makeView();
  try {
    const cloud = view.apply("42", pinnedAdaptive(300000));
    view.renderers[0].addActor(cloud.anchor);
    await streamed(view);
    view.renderers[0].removeActor(cloud.anchor);
    view.update();
    assert.equal(view.tileActors().length, 0);

    // A later message re-stages the same anchor — in the other renderer, since
    // that is what a re-staged layer looks like.
    view.renderers[1].addActor(cloud.anchor);
    await streamed(view);

    assert.equal(view.tileActors(view.renderers[1]).length, 1, "tiles rebuilt");
    assert.equal(view.tileActors(view.renderers[0]).length, 0);
    assert.equal(view.row("42").hasController, true);
    assert.equal(view.governor().activeMembers, 1, "re-registered");
    assert.equal(view.governor().members[0].id, "42");
  } finally {
    view.dispose();
  }
});

test("a block landing before its anchor waits instead of tearing anything down", async () => {
  const view = await makeView();
  try {
    // Block application order inside a message is arbitrary, so the anchor
    // actor may not be wired to a renderer yet.
    const cloud = view.apply("42", pinnedAdaptive(300000));
    view.update();
    await settle();
    assert.deepEqual(view.fetchCalls, [], "nothing streams without an anchor");
    assert.equal(view.registry.size, 1, "the entry waits");
    assert.equal(view.row("42").hasController, false);

    view.renderers[0].addActor(cloud.anchor);
    await streamed(view);
    assert.equal(view.tileActors().length, 1);
  } finally {
    view.dispose();
  }
});

test("an anchor replaced in place keeps the streaming stack it already built", async () => {
  const view = await makeView();
  try {
    const cloud = view.apply("42", {});
    view.renderers[0].addActor(cloud.anchor);
    await streamed(view);
    const [tileActor] = view.tileActors();
    const tileFetches = view.tileFetches();

    // The server re-serializes the anchor: a new actor instance, same mapper,
    // same renderer. Nothing about the stream changed.
    const replacement = makeAnchor(cloud.mapper);
    view.renderers[0].removeActor(cloud.anchor);
    view.renderers[0].addActor(replacement);
    cloud.anchor = replacement;
    await streamed(view);

    assert.deepEqual(view.tileActors(), [tileActor], "same actor still drawn");
    assert.equal(view.tileFetches(), tileFetches, "nothing refetched");
  } finally {
    view.dispose();
  }
});

test("migrating the anchor to another renderer moves the tiles with it", async () => {
  const view = await makeView();
  try {
    const cloud = view.apply("42", {});
    view.renderers[0].addActor(cloud.anchor);
    await streamed(view);
    assert.equal(view.tileActors(view.renderers[0]).length, 1);

    view.renderers[0].removeActor(cloud.anchor);
    view.renderers[1].addActor(cloud.anchor);
    await streamed(view);

    assert.equal(
      view.tileActors(view.renderers[0]).length,
      0,
      "old layer clear",
    );
    assert.equal(
      view.tileActors(view.renderers[1]).length,
      1,
      "new layer draws",
    );
  } finally {
    view.dispose();
  }
});

test("switching a fixed cloud to adaptive hands the budget over without dropping tiles", async () => {
  const view = await makeView();
  try {
    const cloud = view.apply("42", {});
    view.renderers[0].addActor(cloud.anchor);
    await streamed(view);
    const [tileActor] = view.tileActors();
    const tileFetches = view.tileFetches();
    assert.equal(view.row("42").stats.pointBudget, 100000, "the fixed budget");
    assert.equal(view.governor(), null, "no adaptive cloud, no governor");

    view.apply("42", pinnedAdaptive(300000));
    view.update();

    const governor = view.governor();
    assert.equal(governor.activeMembers, 1);
    assert.equal(governor.aggregateBudget, 300000);
    assert.equal(
      view.row("42").stats.pointBudget,
      governor.members[0].effectiveBudget,
      "the cloud draws to the allocation, applied in the same pass",
    );
    assert.notEqual(view.row("42").stats.pointBudget, 100000);
    // A budget is a number the controller re-selects against, so changing who
    // owns it must not cost the tiles already on screen.
    assert.deepEqual(view.tileActors(), [tileActor]);
    assert.equal(view.tileFetches(), tileFetches);
  } finally {
    view.dispose();
  }
});

test("switching an adaptive cloud back to fixed releases its membership", async () => {
  const view = await makeView();
  try {
    const cloud = view.apply("42", pinnedAdaptive(300000));
    view.renderers[0].addActor(cloud.anchor);
    await streamed(view);
    const [tileActor] = view.tileActors();
    assert.equal(view.governor().activeMembers, 1);

    view.apply("42", { pointBudget: 250000 });
    view.update();

    assert.equal(view.governor(), null, "the view has no adaptive cloud left");
    assert.equal(view.row("42").stats.pointBudget, 250000);
    assert.deepEqual(view.tileActors(), [tileActor], "tiles kept");
  } finally {
    view.dispose();
  }
});

test("dropping pointBudget from a block clears the number it had applied", async () => {
  const view = await makeView();
  try {
    const cloud = view.apply("42", {});
    view.renderers[0].addActor(cloud.anchor);
    await streamed(view);
    assert.equal(view.row("42").stats.pointBudget, 100000);

    // The same block with no pointBudget: the cloud must fall back to the
    // bridge's stated default, not keep drawing to the number that is gone.
    view.apply("42", { pointBudget: undefined });
    view.update();

    assert.equal(view.row("42").stats.pointBudget, 2000000);
  } finally {
    view.dispose();
  }
});

test("hiding an adaptive cloud frees its share and showing it takes one back", async () => {
  const view = await makeView();
  try {
    const first = view.apply("42", pinnedAdaptive(300000));
    const second = view.apply("43", pinnedAdaptive(300000));
    view.renderers[0].addActor(first.anchor);
    view.renderers[0].addActor(second.anchor);
    await streamed(view);
    assert.equal(view.governor().activeMembers, 2);
    const shared = view
      .governor()
      .members.map((member) => member.allocatedShare);
    assert.ok(
      shared.every((share) => share > 0) && shared[0] + shared[1] <= 300000,
      `two clouds split one budget (${shared})`,
    );

    second.anchor.visibility = 0;
    await streamed(view);
    let governor = view.governor();
    assert.equal(governor.activeMembers, 1, "a hidden cloud claims nothing");
    assert.deepEqual(
      governor.members.map((member) => member.activeConstraint),
      // Nothing bounds the drawing cloud any more: the pinned budget is far
      // larger than this fixture, so it draws everything it has.
      ["demand", "inactive"],
    );
    assert.equal(
      governor.members[0].allocatedShare,
      governor.members[0].demandPoints,
      "all of what it asked for",
    );
    assert.ok(governor.members[0].demandPoints > 0);
    assert.equal(view.row("43").drawnTiles, 0);

    second.anchor.visibility = 1;
    await streamed(view);
    governor = view.governor();
    assert.equal(governor.activeMembers, 2, "showing takes a share back");
    assert.ok(governor.members[1].allocatedShare > 0);
    assert.equal(view.row("43").drawnTiles, 1);
  } finally {
    view.dispose();
  }
});

test("a cloud hidden while its first tiles load shows them when it is revealed", async () => {
  const view = await makeView();
  try {
    const cloud = view.apply("42", pinnedAdaptive(300000));
    view.renderers[0].addActor(cloud.anchor);
    // Loading starts, then the user hides the layer before anything arrives.
    view.update();
    cloud.anchor.visibility = 0;
    view.update();
    await settle();
    view.update();
    assert.equal(view.row("42").drawnTiles, 0, "nothing drawn while hidden");
    assert.equal(view.governor().activeMembers, 0);

    cloud.anchor.visibility = 1;
    await streamed(view);
    assert.equal(view.tileActors().length, 1);
    assert.equal(view.row("42").drawnTiles, 1);
    assert.equal(view.governor().activeMembers, 1);
  } finally {
    view.dispose();
  }
});

test("changing adaptive options reconfigures the governor for every cloud", async () => {
  const view = await makeView();
  try {
    const first = view.apply("42", pinnedAdaptive(300000));
    const second = view.apply("43", pinnedAdaptive(300000));
    view.renderers[0].addActor(first.anchor);
    view.renderers[0].addActor(second.anchor);
    await streamed(view);
    assert.equal(view.governor().aggregateBudget, 300000);
    assert.equal(view.governor().targetFrameTimeMs, 33);

    // A new wire block: a bigger ceiling and a slacker settled target,
    // absorbed by the governor in place — memberships included.
    view.apply("42", pinnedAdaptive(500000, { stationaryTargetMs: 50 }));
    view.update();

    const governor = view.governor();
    assert.equal(governor.aggregateBudget, 500000);
    assert.equal(governor.targetFrameTimeMs, 50);
    assert.equal(governor.activeMembers, 2, "both clouds re-registered");
    assert.deepEqual(
      governor.members.map((member) => member.id),
      ["42", "43"],
    );
    // Re-registration is only real if the new allocation reached the clouds.
    for (const id of ["42", "43"]) {
      const member = governor.members.find((entry) => entry.id === id);
      assert.ok(member.allocatedShare > 0, `${id} allocated`);
      assert.equal(view.row(id).stats.pointBudget, member.effectiveBudget);
    }
  } finally {
    view.dispose();
  }
});

test("a governor rebuilt during a gesture keeps the responsive regime", async () => {
  const view = await makeView();
  try {
    const cloud = view.apply("42", pinnedAdaptive(300000));
    view.renderers[0].addActor(cloud.anchor);
    await streamed(view);

    view.beginPointCloudLodInteraction(view.registry);
    assert.equal(view.governor().motion.explicitReferences, 1);

    view.apply("42", pinnedAdaptive(500000, { interactionTargetMs: 8 }));
    view.update();

    const governor = view.governor();
    assert.equal(governor.regime, "interaction", "the gesture is still on");
    assert.equal(governor.motion.explicitReferences, 1, "reference inherited");
    assert.equal(governor.targetFrameTimeMs, 8);

    view.endPointCloudLodInteraction(view.registry);
    assert.equal(view.governor().motion.explicitReferences, 0);
  } finally {
    view.dispose();
  }
});

test("turning adaptive off for the last cloud removes the view governor", async () => {
  const view = await makeView();
  try {
    const first = view.apply("42", pinnedAdaptive(300000));
    const second = view.apply("43", pinnedAdaptive(300000));
    view.renderers[0].addActor(first.anchor);
    view.renderers[0].addActor(second.anchor);
    await streamed(view);
    assert.equal(view.governor().activeMembers, 2);

    view.apply("42", { adaptive: false });
    view.update();
    assert.equal(view.governor().activeMembers, 1, "the other cloud remains");
    assert.equal(view.row("42").stats.pointBudget, 100000, "back to fixed");

    view.apply("43", { adaptive: false });
    view.update();
    assert.equal(view.governor(), null);
    assert.equal(view.row("43").stats.pointBudget, 100000);
  } finally {
    view.dispose();
  }
});

test("removing an adaptive cloud entirely leaves the rest of the view running", async () => {
  const view = await makeView();
  try {
    const first = view.apply("42", pinnedAdaptive(300000));
    const second = view.apply("43", pinnedAdaptive(300000));
    view.renderers[0].addActor(first.anchor);
    view.renderers[0].addActor(second.anchor);
    await streamed(view);
    assert.equal(view.governor().activeMembers, 2);

    // A null block is the scene saying the cloud is gone for good.
    view.apply("42", null);
    view.update();

    assert.equal(view.registry.size, 1);
    assert.deepEqual(
      view.governor().members.map((member) => member.id),
      ["43"],
    );
    const survivor = view.governor().members[0];
    assert.ok(survivor.demandPoints > 0);
    assert.equal(survivor.allocatedShare, survivor.demandPoints);
    assert.equal(view.tileActors().length, 1, "only the survivor's tiles");
  } finally {
    view.dispose();
  }
});

test("removing the last cloud stops the view asking for frames", async () => {
  const view = await makeView();
  try {
    const cloud = view.apply("42", pinnedAdaptive(300000));
    view.renderers[0].addActor(cloud.anchor);
    await streamed(view);
    assert.equal(view.pointCloudLodNeedsFrame(view.registry), true);

    view.apply("42", null);
    view.update();

    assert.equal(view.registry.size, 0);
    assert.equal(view.governor(), null, "no clouds, no view governor");
    assert.equal(view.pointCloudLodNeedsFrame(view.registry), false);
  } finally {
    view.dispose();
  }
});

test("unusable adaptive options make the block unusable instead of reaching the governor", async () => {
  const view = await makeView();
  try {
    const unusable = [
      {
        adaptive: true,
        adaptiveOptions: { minBudget: 400000, maxBudget: 300000 },
      },
      { adaptive: true, adaptiveOptions: { stationaryTargetMs: 0 } },
      { adaptive: true, adaptiveOptions: { interactionTargetMs: Number.NaN } },
      { adaptive: true, adaptiveOptions: { minBudget: -1 } },
      // Infinity satisfies `maxBudget >= minBudget` and survives Math.floor;
      // the library rejects it by throwing mid-render-pass, so normalization
      // must be the layer that refuses it.
      {
        adaptive: true,
        adaptiveOptions: { maxBudget: Number.POSITIVE_INFINITY },
      },
      { adaptive: true, adaptiveOptions: 7 },
    ];
    // Established and drawing first, so the rejection has something to undo.
    const cloud = view.apply("42", pinnedAdaptive(300000));
    view.renderers[0].addActor(cloud.anchor);
    await streamed(view);
    assert.equal(view.tileActors().length, 1);

    for (const block of unusable) {
      view.apply("42", block);
      assert.equal(
        view.registry.size,
        0,
        `rejected ${JSON.stringify(block.adaptiveOptions)}`,
      );
      view.update();
      assert.equal(view.tileActors().length, 0, "the cloud stops drawing");
      assert.equal(view.governor(), null);
      // Put it back so the next unusable block has an established cloud too.
      view.apply("42", pinnedAdaptive(300000));
      await streamed(view);
      assert.equal(view.tileActors().length, 1);
    }
  } finally {
    view.dispose();
  }
});

test("a cloud walks the whole fixed, adaptive, hidden, removed and restored cycle", async () => {
  const view = await makeView();
  try {
    // Fixed and drawing.
    const cloud = view.apply("42", {});
    view.renderers[0].addActor(cloud.anchor);
    await streamed(view);
    assert.equal(view.row("42").stats.pointBudget, 100000);
    assert.equal(view.governor(), null);

    // Fixed -> adaptive.
    view.apply("42", pinnedAdaptive(300000));
    view.update();
    assert.equal(view.governor().activeMembers, 1);

    // Adaptive -> hidden.
    cloud.anchor.visibility = 0;
    await streamed(view);
    assert.equal(view.governor().activeMembers, 0);
    assert.equal(view.row("42").drawnTiles, 0);

    // Hidden -> shown, still adaptive.
    cloud.anchor.visibility = 1;
    await streamed(view);
    assert.equal(view.governor().activeMembers, 1);
    assert.equal(view.row("42").drawnTiles, 1);

    // Adaptive -> fixed while shown.
    view.apply("42", { pointBudget: 250000 });
    view.update();
    assert.equal(view.governor(), null);
    assert.equal(view.row("42").stats.pointBudget, 250000);

    // Fixed -> hidden -> anchor removed while hidden.
    cloud.anchor.visibility = 0;
    await streamed(view);
    view.renderers[0].removeActor(cloud.anchor);
    view.update();
    assert.equal(view.tileActors().length, 0);
    assert.equal(view.row("42").hasController, false);

    // Anchor restored, shown, and adaptive again in one message.
    cloud.anchor.visibility = 1;
    view.apply("42", pinnedAdaptive(300000));
    view.renderers[0].addActor(cloud.anchor);
    await streamed(view);
    assert.equal(view.tileActors().length, 1);
    assert.equal(view.governor().activeMembers, 1);
    assert.equal(
      view.row("42").stats.pointBudget,
      view.governor().members[0].effectiveBudget,
    );
  } finally {
    view.dispose();
  }
});

test("anchor resolution reruns only when the topology version advances", async () => {
  const module = await loadModule("/src/components/pointCloudLod.js");
  stubFetch();
  const renderers = [makeRenderer(), makeRenderer()];
  const renderWindow = { getViews: () => [{ getSize: () => [200, 100] }] };
  const registry = new Map();
  const mapper = { isDeleted: () => false };
  const anchor = makeAnchor(mapper);
  const graph = anchorGraph();
  for (const renderer of renderers) graph.addRenderer(renderer);
  graph.setAnchor("42", anchor);
  let lookups = 0;
  const referrersOf = (nodeId, slot) => {
    lookups += 1;
    return graph.referrersOf(nodeId, slot);
  };
  const update = (topologyVersion) =>
    module.updatePointCloudLods(registry, {
      renderers,
      renderWindow,
      scheduleRender: () => {},
      referrersOf,
      getInstance: graph.getInstance,
      topologyVersion,
    });

  renderers[0].addActor(anchor);
  module.applyPointCloudLodBlock(
    registry,
    "42",
    { ...BLOCK },
    mapper,
    () => {},
  );
  update(1);
  await settle();
  const afterFirst = lookups;
  assert.ok(afterFirst > 0, "the first pass resolved from the graph");
  update(1);
  update(1);
  assert.equal(lookups, afterFirst, "same version, cached association");

  // The server re-stages the anchor into the second renderer. A pass on the
  // same version keeps the cached association — only a message can move an
  // actor, and a message bumps the version, whose pass sees the move.
  renderers[0].removeActor(anchor);
  renderers[1].addActor(anchor);
  update(1);
  assert.ok(
    renderers[0].actors.length > 0,
    "tiles still with the cached host inside the version",
  );
  update(2);
  await settle();
  update(2);
  assert.equal(renderers[0].actors.length, 0, "old host emptied");
  assert.ok(renderers[1].actors.length > 1, "tiles migrated with the anchor");
  module.disposePointCloudLods(registry);
});
