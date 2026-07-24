// The read-only point-cloud LOD registry snapshot: it must tolerate every
// half-built entry shape without throwing or mutating controller state.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

const STATS = {
  pointBudget: 1000,
  submittedPoints: 900,
  cachedTiles: 12,
  fetchedTiles: 30,
  fetchedBytes: 4096,
  cancelledFetches: 2,
  cacheHits: 7,
  cacheMisses: 5,
  residentLevels: [{ level: 0, tiles: 1, points: 100 }],
  adaptive: null,
};

test("describePointCloudLodRegistry returns [] for empty or missing registries", async () => {
  const { describePointCloudLodRegistry } = await loadModule(
    "/src/components/pointCloudLod.js",
  );
  assert.deepEqual(describePointCloudLodRegistry(null), []);
  assert.deepEqual(describePointCloudLodRegistry(new Map()), []);
});

test("describePointCloudLodRegistry tolerates an entry with no controller yet", async () => {
  const { describePointCloudLodRegistry } = await loadModule(
    "/src/components/pointCloudLod.js",
  );
  const registry = new Map([
    [
      "7",
      {
        id: "7",
        config: { endpoint: "/pointcloud/cloud-1/rev1" },
        controller: null,
        adapter: null,
      },
    ],
  ]);
  assert.deepEqual(describePointCloudLodRegistry(registry), [
    {
      id: "7",
      endpoint: "/pointcloud/cloud-1/rev1",
      hasController: false,
      residentActorTiles: 0,
      gpuResidentTiles: 0,
      gpuResidentPoints: 0,
      gpuResidentBytes: 0,
      anchorVisible: null,
      activeDrawTiles: 0,
      activeDrawPoints: 0,
      stats: null,
    },
  ]);
});

test("describePointCloudLodRegistry reports anchor visibility as a boolean", async () => {
  const { describePointCloudLodRegistry } = await loadModule(
    "/src/components/pointCloudLod.js",
  );
  const entry = (id, actor) => [id, { id, actor }];
  const registry = new Map([
    // Server-synced actors carry visibility as 0/1 ints, not booleans.
    entry("visible-bool", { getVisibility: () => true }),
    entry("visible-int", { getVisibility: () => 1 }),
    entry("hidden-bool", { getVisibility: () => false }),
    entry("hidden-int", { getVisibility: () => 0 }),
    // A missing getter means visible.
    entry("no-getter", {}),
    // No anchor actor resolved yet: unknown, not hidden.
    entry("no-actor", null),
  ]);

  assert.deepEqual(
    describePointCloudLodRegistry(registry).map((row) => [
      row.id,
      row.anchorVisible,
    ]),
    [
      ["visible-bool", true],
      ["visible-int", true],
      ["hidden-bool", false],
      ["hidden-int", false],
      ["no-getter", true],
      ["no-actor", null],
    ],
  );
});

test("describePointCloudLodRegistry reports controller stats and adapter tile count", async () => {
  const { describePointCloudLodRegistry } = await loadModule(
    "/src/components/pointCloudLod.js",
  );
  let statsCalls = 0;
  const registry = new Map([
    [
      "7",
      {
        id: "7",
        config: { endpoint: "/pointcloud/cloud-1/rev1" },
        actor: { getVisibility: () => 1 },
        controller: {
          stats: () => {
            statsCalls += 1;
            return STATS;
          },
        },
        adapter: {
          stats: () => ({
            gpuResidentTiles: 4,
            gpuResidentPoints: 900,
            gpuResidentBytes: 12345,
            activeDrawTiles: 4,
            activeDrawPoints: 900,
          }),
        },
      },
    ],
    // A half-built entry (block landed, anchor actor not resolved) must not throw.
    ["8", { id: "8" }],
  ]);

  const described = describePointCloudLodRegistry(registry);
  assert.equal(statsCalls, 1);
  assert.deepEqual(described, [
    {
      id: "7",
      endpoint: "/pointcloud/cloud-1/rev1",
      hasController: true,
      residentActorTiles: 4,
      gpuResidentTiles: 4,
      gpuResidentPoints: 900,
      gpuResidentBytes: 12345,
      anchorVisible: true,
      activeDrawTiles: 4,
      activeDrawPoints: 900,
      stats: STATS,
    },
    {
      id: "8",
      endpoint: null,
      hasController: false,
      residentActorTiles: 0,
      gpuResidentTiles: 0,
      gpuResidentPoints: 0,
      gpuResidentBytes: 0,
      anchorVisible: null,
      activeDrawTiles: 0,
      activeDrawPoints: 0,
      stats: null,
    },
  ]);
});
