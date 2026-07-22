// phase0-bench: tests for the read-only point-cloud LOD diagnostic surface
// (describePointCloudLodRegistry + getSyncDiagnostics.pointCloudLod /
// .lastVtkPaintMs). Remove with the rest of the phase0-bench instrumentation.
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

async function makeScene() {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");
  const renderer = {
    get: () => ({}),
    getActiveCamera: () => null,
    getViewport: () => [0, 0, 1, 1],
  };
  const renderWindow = {
    getRenderers: () => [renderer],
    getRenderersByReference: () => [renderer],
    getViews: () => [{ getSize: () => [800, 400] }],
  };
  const scene = useSceneSync(
    {
      client: {},
      emit() {},
      getRenderWindow: () => renderWindow,
      renderScene() {},
    },
    {
      createManagedSyncContext: () => ({
        synchronizerContext: {},
        syncRenderWindow: renderWindow,
        cleanup() {},
      }),
      createReconciler: () => ({
        registerBlockHandler() {},
        teardown() {},
        flushDeferredProps() {},
      }),
      createSceneEngine: () => ({
        start() {},
        stop() {},
        resync() {},
        getSeq: () => 1,
        getDiagnostics: () => ({}),
        onCommand: () => () => {},
      }),
    },
  );
  scene.initialize({
    contextName: "pointcloud-lod-diagnostics-test",
    renderWindowId: 1,
    onRenderNeeded() {},
  });
  return scene;
}

test("getSyncDiagnostics exposes empty point-cloud and paint diagnostics", async () => {
  const scene = await makeScene();
  const diagnostics = scene.getSyncDiagnostics();
  assert.deepEqual(diagnostics.pointCloudLod, []);
  assert.equal(diagnostics.lastVtkPaintMs, null);
  assert.equal(diagnostics.lastVtkPaintAt, null);
  assert.equal(diagnostics.vtkPaintSequence, 0);
});

test("lastVtkPaintMs tracks the most recent recorded frame and resets on cleanup", async () => {
  const scene = await makeScene();

  scene.recordFrameDuration(4.5);
  const first = scene.getSyncDiagnostics();
  assert.equal(first.lastVtkPaintMs, 4.5);
  assert.equal(first.vtkPaintSequence, 1);
  assert.equal(Number.isFinite(first.lastVtkPaintAt), true);

  scene.recordFrameDuration(11.25);
  const second = scene.getSyncDiagnostics();
  assert.equal(second.lastVtkPaintMs, 11.25);
  assert.equal(second.vtkPaintSequence, 2);
  assert.equal(second.lastVtkPaintAt >= first.lastVtkPaintAt, true);

  // Non-finite reports are ignored rather than clobbering the last real paint.
  scene.recordFrameDuration(Number.NaN);
  scene.recordFrameDuration(undefined);
  assert.equal(scene.getSyncDiagnostics().lastVtkPaintMs, 11.25);
  assert.equal(scene.getSyncDiagnostics().vtkPaintSequence, 2);

  scene.cleanup();
  assert.equal(scene.getSyncDiagnostics().lastVtkPaintMs, null);
  assert.equal(scene.getSyncDiagnostics().lastVtkPaintAt, null);
  assert.equal(scene.getSyncDiagnostics().vtkPaintSequence, 0);
});
