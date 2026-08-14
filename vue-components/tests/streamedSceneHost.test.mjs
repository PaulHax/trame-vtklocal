import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const TILES3D_SOURCE_CORPUS = JSON.parse(
  readFileSync(
    new URL(
      "../node_modules/pointcloud-lod/test/fixtures/tiles3d-source-contract.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function pct1() {
  const positions = [0.1, 0.1, 0.1, -0.1, -0.1, -0.1];
  const rgb = [255, 0, 0, 0, 200, 0];
  const buffer = new ArrayBuffer(40 + positions.length * 4 + rgb.length);
  const view = new DataView(buffer);
  for (let index = 0; index < 4; index += 1) {
    view.setUint8(index, "PCT1".charCodeAt(index));
  }
  view.setUint32(4, 2, true);
  view.setUint32(8, 1, true);
  view.setFloat64(16, 0, true);
  view.setFloat64(24, 0, true);
  view.setFloat64(32, 0, true);
  new Float32Array(buffer, 40, positions.length).set(positions);
  new Uint8Array(buffer, 40 + positions.length * 4, rgb.length).set(rgb);
  return buffer;
}

const HIERARCHY = {
  nodes: {
    "0-0-0-0": {
      pointCount: 2,
      children: [],
      page: null,
      bounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      spacing: 0.1,
    },
  },
};

function pointBlock(overrides = {}) {
  return {
    kind: "pointCloud",
    sourceAssetId: "asset-1",
    revision: "rev-1",
    endpoint: "/pointcloud/cloud-1/rev-1",
    pointCloud: {
      pointCount: 10,
      presentation: { mode: "fixed", diameterCssPx: 3 },
      adaptive: false,
      pointBudget: 1000,
    },
    ...overrides,
  };
}

function tilesBlock(overrides = {}) {
  return {
    kind: "tiles3d",
    sourceAssetId: "mesh-1",
    revision: "mesh-rev-1",
    endpoint: "/tileset/mesh-1/mesh-rev-1",
    tiles3d: { tilesetToScene: IDENTITY.slice() },
    ...overrides,
  };
}

function fakeMember() {
  return {
    calls: [],
    pickResult: { status: "miss" },
    occlusionResult: { status: "clear" },
    setCamera(view) {
      this.calls.push(["camera", view]);
    },
    setModelMatrix(matrix) {
      this.calls.push(["model", matrix]);
    },
    setDevicePixelRatio(value) {
      this.calls.push(["dpr", value]);
    },
    setActive(value) {
      this.calls.push(["active", value]);
    },
    setConfig(value) {
      this.calls.push(["config", value]);
    },
    beginInteraction() {
      this.calls.push(["begin"]);
    },
    endInteraction() {
      this.calls.push(["end"]);
    },
    prepareFrame() {
      this.calls.push(["prepare"]);
    },
    governorInputs: () => ({
      projectedImportance: 1,
      qualityDemand: 1,
      work: { operations: 0, progressSerial: 0 },
      physicalTileOperations: 0,
      physicalHierarchyOperations: 0,
      residentBytes: 0,
    }),
    applyAllocation(value) {
      this.calls.push(["allocation", value]);
    },
    pick(view, x, y) {
      this.calls.push(["pick", view, x, y]);
      return this.pickResult;
    },
    occlusionDepth(view, x, y) {
      this.calls.push(["occlusion", view, x, y]);
      return this.occlusionResult;
    },
    stats: () => ({ ready: true }),
    dispose() {
      this.calls.push(["dispose"]);
    },
  };
}

function fakeCoordinatorFactory(log) {
  return (options) => {
    log.options = options;
    const registrations = new Set();
    return {
      context(renderer, dpr) {
        log.contexts.push([renderer, dpr]);
        return { renderer, devicePixelRatio: dpr };
      },
      register(member, options = {}) {
        log.registrations.push(options);
        const held = { member, released: false };
        registrations.add(held);
        member.setActive(options.active ?? true);
        return {
          setCamera: (view) => member.setCamera(view),
          setModelMatrix: (matrix) => member.setModelMatrix(matrix),
          setDevicePixelRatio: (dpr) => member.setDevicePixelRatio(dpr),
          setActive: (active) => member.setActive(active),
          setConfig: (config) => member.setConfig(config),
          setQualityPolicy: (managed, targets) =>
            log.quality.push([managed, targets]),
          release() {
            if (held.released) return;
            held.released = true;
            registrations.delete(held);
            member.dispose();
          },
        };
      },
      noteRenderedCameras(views) {
        log.views.push(views);
      },
      beginInteraction() {
        log.begin += 1;
        for (const { member } of registrations) member.beginInteraction();
      },
      endInteraction() {
        log.end += 1;
        for (const { member } of registrations) member.endInteraction();
      },
      prepareFrame(frameSerial) {
        log.prepares += 1;
        log.frameSerials.push(frameSerial);
        for (const { member } of registrations) member.prepareFrame();
      },
      recordHostFrame(metrics) {
        log.frames.push(metrics);
      },
      needsFrame: () => log.needsFrame,
      stats: () => ({ memberCount: registrations.size }),
      dispose() {
        log.disposes += 1;
        for (const { member } of registrations) member.dispose();
        registrations.clear();
      },
    };
  };
}

function coordinatorLog() {
  return {
    contexts: [],
    registrations: [],
    quality: [],
    views: [],
    frames: [],
    frameSerials: [],
    begin: 0,
    end: 0,
    prepares: 0,
    disposes: 0,
    needsFrame: false,
  };
}

function factoriesFor(queueByKind) {
  return {
    has: (kind) => queueByKind.has(kind),
    create(kind, context, config) {
      const queue = queueByKind.get(kind);
      if (!queue?.length) throw new Error(`no fake member for ${kind}`);
      const member = queue.shift();
      member.factoryContext = context;
      member.factoryConfig = config;
      return member;
    },
  };
}

function actor(matrix = null) {
  return {
    matrix,
    visible: true,
    getVisibility() {
      return this.visible;
    },
    getUserMatrix() {
      return this.matrix;
    },
    isDeleted: () => false,
  };
}

function renderer() {
  return {
    draw: true,
    viewport: [0, 0, 1, 1],
    getDraw() {
      return this.draw;
    },
    getViewport() {
      return this.viewport;
    },
    getActiveCamera: () => ({
      getCompositeProjectionMatrix: () => IDENTITY.slice(),
      getPosition: () => [0, 0, 10],
    }),
  };
}

function sceneContext(bindings) {
  const instances = new Map();
  const rendererIds = new Map();
  const renderers = [];
  let nextRenderer = 1;
  const ensureRenderer = (value) => {
    if (!rendererIds.has(value)) {
      const id = `renderer-${nextRenderer++}`;
      rendererIds.set(value, id);
      instances.set(id, value);
      renderers.push(value);
    }
  };
  for (const binding of bindings.values()) {
    ensureRenderer(binding.renderer);
  }
  for (const [nodeId, binding] of bindings) {
    instances.set(String(nodeId), binding.actor);
  }
  const context = {
    renderers,
    renderWindow: { getViews: () => [{ getSize: () => [200, 100] }] },
    topologyVersion: 1,
    getInstance: (id) => instances.get(String(id)) ?? null,
    referrersOf(nodeId, slot) {
      if (slot !== "viewProps") return [];
      const binding = bindings.get(String(nodeId));
      return binding ? [rendererIds.get(binding.renderer)] : [];
    },
    remove(nodeId) {
      instances.delete(String(nodeId));
      bindings.delete(String(nodeId));
      this.topologyVersion += 1;
    },
    bind(nodeId, anchor, hostRenderer) {
      ensureRenderer(hostRenderer);
      instances.set(String(nodeId), anchor);
      bindings.set(String(nodeId), { actor: anchor, renderer: hostRenderer });
      this.topologyVersion += 1;
    },
  };
  return context;
}

test("streamedScene normalization is all-or-nothing and kind-owned", async () => {
  const { normalizeStreamedSceneBlock } = await loadModule(
    "/src/components/streamedSceneHost.js",
  );
  const factories = { has: (kind) => ["pointCloud", "tiles3d"].includes(kind) };

  assert.equal(
    normalizeStreamedSceneBlock(pointBlock(), factories).kind,
    "pointCloud",
  );
  assert.equal(
    normalizeStreamedSceneBlock(tilesBlock(), factories).kind,
    "tiles3d",
  );
  assert.deepEqual(
    normalizeStreamedSceneBlock(tilesBlock(), factories).kindConfig,
    {
      tilesetToScene: IDENTITY,
      verticalExaggeration: 1,
      verticalPivotZ: 0,
      geometricErrorScale: "maximum",
    },
  );
  assert.deepEqual(
    normalizeStreamedSceneBlock(
      tilesBlock({
        tiles3d: {
          tilesetToScene: IDENTITY,
          verticalExaggeration: 3.5,
          verticalPivotZ: -12,
        },
      }),
      factories,
    ).kindConfig,
    {
      tilesetToScene: IDENTITY,
      verticalExaggeration: 3.5,
      verticalPivotZ: -12,
      geometricErrorScale: "maximum",
    },
  );
  for (const tiles3d of [
    { tilesetToScene: IDENTITY, verticalExaggeration: 0 },
    { tilesetToScene: IDENTITY, verticalExaggeration: -1 },
    { tilesetToScene: IDENTITY, verticalExaggeration: Infinity },
    { tilesetToScene: IDENTITY, verticalExaggeration: "2" },
    { tilesetToScene: IDENTITY, verticalExaggeration: true },
    { tilesetToScene: IDENTITY, verticalExaggeration: null },
    { tilesetToScene: IDENTITY, verticalPivotZ: NaN },
    { tilesetToScene: IDENTITY, verticalPivotZ: -Infinity },
    { tilesetToScene: IDENTITY, verticalPivotZ: "0" },
    { tilesetToScene: IDENTITY, verticalPivotZ: false },
    { tilesetToScene: IDENTITY, verticalPivotZ: null },
  ]) {
    assert.equal(
      normalizeStreamedSceneBlock(tilesBlock({ tiles3d }), factories),
      null,
    );
  }
  assert.equal(
    normalizeStreamedSceneBlock(
      tilesBlock({
        tiles3d: {
          tilesetToScene: IDENTITY.map((value, index) =>
            index === 3 ? 1 : value,
          ),
        },
      }),
      factories,
    ),
    null,
  );
  assert.equal(
    normalizeStreamedSceneBlock(
      tilesBlock({
        tiles3d: {
          tilesetToScene: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
      }),
      factories,
    ),
    null,
  );
  assert.equal(
    normalizeStreamedSceneBlock(
      { ...pointBlock(), tiles3d: { tilesetToScene: IDENTITY } },
      factories,
    ),
    null,
  );
  assert.equal(
    normalizeStreamedSceneBlock(
      pointBlock({ endpoint: "/pointcloud/trailing/" }),
      factories,
    ),
    null,
  );
  assert.equal(
    normalizeStreamedSceneBlock(
      pointBlock({
        pointCloud: { ...pointBlock().pointCloud, pointCount: NaN },
      }),
      factories,
    ),
    null,
  );
  assert.equal(
    normalizeStreamedSceneBlock(pointBlock(), { has: () => false }),
    null,
  );
});

test("streamedScene normalization consumes the shared Tiles3DSource contract", async () => {
  const { normalizeStreamedSceneBlock, validateTiles3dSourceDocument } =
    await loadModule("/src/components/streamedSceneHost.js");
  const factories = { has: (kind) => kind === "tiles3d" };

  for (const fixture of TILES3D_SOURCE_CORPUS.valid) {
    assert.equal(
      normalizeStreamedSceneBlock(fixture.document, factories).kind,
      "tiles3d",
      fixture.name,
    );
    assert.doesNotThrow(
      () => validateTiles3dSourceDocument(fixture.document, factories),
      fixture.name,
    );
  }
  for (const fixture of TILES3D_SOURCE_CORPUS.invalid) {
    assert.equal(
      normalizeStreamedSceneBlock(fixture.document, factories),
      null,
      fixture.name,
    );
    assert.throws(
      () => validateTiles3dSourceDocument(fixture.document, factories),
      new RegExp(fixture.reason, "i"),
      fixture.name,
    );
  }
});

// Tolerance agreement with the producer. The same constants and the same
// matrices are pinned in tests/test_streamed_scene.py
// (test_fixed_affine_entries_share_one_absolute_tolerance).
test("fixed affine entries share one absolute tolerance with the producer", async () => {
  const { AFFINE_ENTRY_ABS_TOL, normalizeStreamedSceneBlock } =
    await loadModule("/src/components/streamedSceneHost.js");
  const factories = { has: (kind) => ["pointCloud", "tiles3d"].includes(kind) };
  const INSIDE = 9e-13;
  const OUTSIDE = 2e-12;
  const matrixWith = (index, entry) =>
    IDENTITY.map((value, at) => (at === index ? entry : value));
  const normalize = (tilesetToScene) =>
    normalizeStreamedSceneBlock(
      tilesBlock({ tiles3d: { tilesetToScene } }),
      factories,
    );

  for (const [index, expected] of [
    [3, 0],
    [7, 0],
    [11, 0],
    [15, 1],
  ]) {
    assert.deepEqual(
      normalize(matrixWith(index, expected + INSIDE)).kindConfig.tilesetToScene,
      matrixWith(index, expected + INSIDE),
    );
    assert.equal(normalize(matrixWith(index, expected + OUTSIDE)), null);
  }
  assert.equal(AFFINE_ENTRY_ABS_TOL, 1e-12);
});

test("camera fan-out follows rendered projection matrices and CSS viewport metrics", async () => {
  const { readCameraView } = await loadModule(
    "/src/components/streamedSceneHost.js",
  );
  const { transposeMatrix } = await loadModule(
    "/src/components/cameraMatrix.js",
  );
  const previousDpr = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 2;
  const desired = [1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1];
  const camera = {
    matrix: transposeMatrix(desired),
    getCompositeProjectionMatrix() {
      return this.matrix;
    },
    getPosition: () => [1, 2, 3],
  };
  const hostRenderer = {
    ...renderer(),
    viewport: [0.5, 0, 1, 1],
    getActiveCamera: () => camera,
  };
  const renderWindow = {
    getViews: () => [{ getSize: () => [400, 200] }],
  };
  try {
    const perspective = readCameraView(hostRenderer, renderWindow);
    assert.equal(perspective.projection, "perspective");
    assert.ok(Math.abs(perspective.fovY - 2 * Math.atan(0.5)) < 1e-12);
    assert.deepEqual(
      [perspective.viewportWidthCssPx, perspective.viewportHeightCssPx],
      [100, 100],
    );

    camera.matrix = transposeMatrix(
      desired.map((value, index) =>
        [5, 11].includes(index) ? value * 4 : value,
      ),
    );
    const scaled = readCameraView(hostRenderer, renderWindow);
    assert.ok(Math.abs(scaled.fovY - perspective.fovY) < 1e-12);

    camera.matrix = IDENTITY.slice();
    const parallel = readCameraView(hostRenderer, renderWindow);
    assert.deepEqual(
      {
        projection: parallel.projection,
        parallelScale: parallel.parallelScale,
      },
      { projection: "orthographic", parallelScale: 1 },
    );
    camera.matrix = new Array(16).fill(0);
    assert.equal(readCameraView(hostRenderer, renderWindow), null);
  } finally {
    globalThis.devicePixelRatio = previousDpr;
  }
});

test("host lazily creates one member per actor and fans out anchor state", async () => {
  const { createStreamedSceneHost } = await loadModule(
    "/src/components/streamedSceneHost.js",
  );
  const log = coordinatorLog();
  const member = fakeMember();
  const factories = factoriesFor(new Map([["pointCloud", [member]]]));
  const matrix = IDENTITY.map((value, index) => (index === 12 ? 7 : value));
  const anchor = actor(matrix);
  const hostRenderer = renderer();
  const bindings = new Map([["42", { actor: anchor, renderer: hostRenderer }]]);
  const context = sceneContext(bindings);
  let renders = 0;
  const host = createStreamedSceneHost({
    factories,
    createCoordinator: fakeCoordinatorFactory(log),
    scheduleRender: () => {
      renders += 1;
    },
  });

  host.applyBlock("42", pointBlock(), anchor);
  assert.equal(
    log.contexts.length,
    0,
    "block arrival does not construct a member",
  );
  host.beforeRender(context);

  assert.equal(log.contexts.length, 1);
  assert.equal(log.contexts[0][0], hostRenderer);
  assert.equal(member.factoryContext.renderer, hostRenderer);
  assert.equal(member.factoryConfig.source.metadata().pointCount, 10);
  assert.ok(
    member.calls.some(([name, value]) => name === "model" && value === matrix),
  );
  assert.ok(member.calls.some(([name]) => name === "camera"));
  assert.equal(
    log.prepares,
    1,
    "member preparation and submission drain precede paint",
  );
  assert.equal(log.views[0].get(hostRenderer).projection, "orthographic");
  assert.ok(renders > 0);

  host.dispose();
  assert.equal(member.calls.filter(([name]) => name === "dispose").length, 1);
  assert.equal(log.disposes, 1);
});

test("tiles transport keeps vertical currency separate from the live anchor", async () => {
  const { createStreamedSceneHost } = await loadModule(
    "/src/components/streamedSceneHost.js",
  );
  const log = coordinatorLog();
  const member = fakeMember();
  const anchorMatrix = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 7, 11, 13, 1];
  const anchor = actor(anchorMatrix);
  const hostRenderer = renderer();
  const host = createStreamedSceneHost({
    factories: factoriesFor(new Map([["tiles3d", [member]]])),
    createCoordinator: fakeCoordinatorFactory(log),
    tiles3dQualityPolicy: "fixed",
  });
  host.applyBlock(
    "mesh",
    tilesBlock({
      tiles3d: {
        tilesetToScene: IDENTITY,
        verticalExaggeration: 2.5,
        verticalPivotZ: 105,
      },
    }),
    anchor,
  );
  host.beforeRender(
    sceneContext(
      new Map([["mesh", { actor: anchor, renderer: hostRenderer }]]),
    ),
  );
  assert.equal(log.registrations[0].qualityManaged, false);
  assert.equal(member.factoryConfig.verticalExaggeration, 2.5);
  assert.equal(member.factoryConfig.verticalPivotZ, 105);
  assert.deepEqual(
    member.calls.find(([name]) => name === "model")[1],
    anchorMatrix,
  );
  const initialDiagnostics = host.describe().members[0];
  assert.equal(initialDiagnostics.configGeneration, 1);
  assert.equal(initialDiagnostics.verticalExaggeration, 2.5);
  assert.equal(initialDiagnostics.verticalPivotZ, 105);
  assert.deepEqual(initialDiagnostics.anchorUserMatrix, anchorMatrix);

  host.applyBlock(
    "mesh",
    tilesBlock({
      tiles3d: {
        tilesetToScene: IDENTITY,
        verticalExaggeration: 4,
        verticalPivotZ: -8,
      },
    }),
    anchor,
  );
  host.beforeRender(
    sceneContext(
      new Map([["mesh", { actor: anchor, renderer: hostRenderer }]]),
    ),
  );
  const changed = member.calls.findLast(([name]) => name === "config")[1];
  assert.equal(changed.verticalExaggeration, 4);
  assert.equal(changed.verticalPivotZ, -8);
  assert.deepEqual(anchor.matrix, anchorMatrix);
  const changedDiagnostics = host.describe().members[0];
  assert.equal(changedDiagnostics.configGeneration, 2);
  assert.equal(changedDiagnostics.verticalExaggeration, 4);
  assert.equal(changedDiagnostics.verticalPivotZ, -8);
  assert.deepEqual(changedDiagnostics.anchorUserMatrix, anchorMatrix);
  assert.deepEqual(host.describe().tiles3dQualityPolicy, {
    mode: "fixed",
    reason: "forced-control",
  });
  host.dispose();
});

test("default pointCloud factory streams through the extracted member API", async () => {
  const { createStreamedSceneHost } = await loadModule(
    "/src/components/streamedSceneHost.js",
  );
  const previousFetch = globalThis.fetch;
  const fetches = [];
  globalThis.fetch = async (url) => {
    fetches.push(String(url));
    return String(url).includes("/hierarchy/")
      ? new Response(JSON.stringify(HIERARCHY), { status: 200 })
      : new Response(pct1(), { status: 200 });
  };
  const added = [];
  const removed = [];
  const hostRenderer = {
    ...renderer(),
    addActor(value) {
      added.push(value);
    },
    removeActor(value) {
      removed.push(value);
      const index = added.indexOf(value);
      if (index >= 0) added.splice(index, 1);
    },
  };
  const anchor = actor();
  const bindings = new Map([
    ["real", { actor: anchor, renderer: hostRenderer }],
  ]);
  const context = sceneContext(bindings);
  const host = createStreamedSceneHost();
  try {
    host.applyBlock(
      "real",
      pointBlock({
        sourceAssetId: "real-asset",
        pointCloud: { ...pointBlock().pointCloud, pointCount: 2 },
      }),
      anchor,
    );
    host.beforeRender(context);
    for (let index = 0; index < 20 && added.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.ok(fetches.some((url) => url.endsWith("/hierarchy/0-0-0-0.json")));
    assert.ok(fetches.some((url) => url.endsWith("/tile/0-0-0-0.bin")));
    assert.equal(added.length, 1);
    assert.equal(host.describe().members[0].stats.kind, "pointCloud");
    assert.equal(
      host.describe().members[0].stats.residentBytes,
      host.describe().members[0].stats.renderer.gpuResidentBytes,
    );
  } finally {
    host.dispose();
    globalThis.fetch = previousFetch;
  }
  assert.ok(removed.length > 0, "host disposal retires streamed VTK actors");
});

test("initial visibility gates creation and actor removal tears down realization", async () => {
  const { createStreamedSceneHost } = await loadModule(
    "/src/components/streamedSceneHost.js",
  );
  const log = coordinatorLog();
  const member = fakeMember();
  const factories = factoriesFor(new Map([["pointCloud", [member]]]));
  const anchor = actor();
  anchor.visible = false;
  const hostRenderer = renderer();
  const bindings = new Map([["7", { actor: anchor, renderer: hostRenderer }]]);
  const context = sceneContext(bindings);
  const host = createStreamedSceneHost({
    factories,
    createCoordinator: fakeCoordinatorFactory(log),
  });

  host.applyBlock("7", pointBlock(), anchor);
  host.beforeRender(context);
  assert.equal(
    log.contexts.length,
    0,
    "hidden anchor starts no streaming member",
  );
  anchor.visible = true;
  host.beforeRender(context);
  assert.equal(log.contexts.length, 1);
  anchor.visible = false;
  host.beforeRender(context);
  assert.ok(
    member.calls.some(([name, value]) => name === "active" && value === false),
  );

  context.remove("7");
  host.beforeRender(context);
  assert.equal(member.calls.filter(([name]) => name === "dispose").length, 1);
  host.dispose();
});

test("retained blocks survive unresolved anchors, config changes, migration, and replacement", async () => {
  const { createStreamedSceneHost } = await loadModule(
    "/src/components/streamedSceneHost.js",
  );
  const log = coordinatorLog();
  const members = [fakeMember(), fakeMember(), fakeMember(), fakeMember()];
  const factories = factoriesFor(new Map([["pointCloud", members.slice()]]));
  const firstActor = actor();
  const firstRenderer = renderer();
  const secondRenderer = renderer();
  const context = sceneContext(new Map());
  const host = createStreamedSceneHost({
    factories,
    createCoordinator: fakeCoordinatorFactory(log),
  });

  host.applyBlock("retained", pointBlock(), firstActor);
  host.beforeRender(context);
  assert.equal(host.describe().members[0].hasMember, false);
  context.bind("retained", firstActor, firstRenderer);
  host.beforeRender(context);
  assert.equal(members[0].factoryContext.renderer, firstRenderer);

  const firstSource = members[0].factoryConfig.source;
  host.applyBlock(
    "retained",
    pointBlock({
      revision: "rev-2",
      endpoint: "/pointcloud/cloud-1/rev-2",
      pointCloud: {
        ...pointBlock().pointCloud,
        adaptive: true,
        adaptiveOptions: {
          minBudget: 100,
          maxBudget: 5000,
          interactionTargetMs: 15,
          stationaryTargetMs: 30,
        },
        pointBudget: undefined,
      },
    }),
    firstActor,
  );
  host.beforeRender(context);
  const updatedConfig = members[0].calls.find(([name]) => name === "config")[1];
  assert.notEqual(
    updatedConfig.source,
    firstSource,
    "revision swaps the source",
  );
  assert.equal(
    "pointBudget" in updatedConfig,
    false,
    "dropped option stays dropped",
  );
  assert.deepEqual(log.quality.at(-1), [
    true,
    { interactionTargetMs: 15, stationaryTargetMs: 30 },
  ]);
  assert.equal(
    members[0].calls.some(([name]) => name === "dispose"),
    false,
    "config and quality policy reconcile in place",
  );

  context.bind("retained", firstActor, secondRenderer);
  host.beforeRender(context);
  assert.equal(members[0].calls.at(-1)[0], "dispose");
  assert.equal(members[1].factoryContext.renderer, secondRenderer);

  context.remove("retained");
  host.beforeRender(context);
  assert.equal(members[1].calls.at(-1)[0], "dispose");
  context.bind("retained", firstActor, secondRenderer);
  host.beforeRender(context);
  assert.equal(members[2].factoryContext.renderer, secondRenderer);

  const replacement = actor();
  context.bind("retained", replacement, secondRenderer);
  host.applyBlock("retained", pointBlock(), replacement);
  host.beforeRender(context);
  assert.equal(members[2].calls.at(-1)[0], "dispose");
  assert.equal(members[3].factoryContext.renderer, secondRenderer);

  host.applyBlock("retained", null, replacement);
  assert.equal(members[3].calls.at(-1)[0], "dispose");
  assert.deepEqual(host.describe().members, []);
  host.dispose();
});

test("host adopts a reconciler replacement when an unchanged block does not re-fire", async () => {
  const [hostModule, reconcileModule, mirrorModule] = await Promise.all([
    loadModule("/src/components/streamedSceneHost.js"),
    loadModule("/src/components/engine/reconcile.js"),
    loadModule("/src/components/engine/mirrorStore.js"),
  ]);
  const firstMember = fakeMember();
  const secondMember = fakeMember();
  const factories = factoriesFor(
    new Map([["pointCloud", [firstMember, secondMember]]]),
  );
  const firstActor = actor();
  const secondActor = actor();
  firstActor.deleted = false;
  secondActor.deleted = false;
  firstActor.isDeleted = () => firstActor.deleted;
  secondActor.isDeleted = () => secondActor.deleted;
  firstActor.set = secondActor.set = () => {};
  firstActor.delete = () => {
    firstActor.deleted = true;
  };
  secondActor.delete = () => {
    secondActor.deleted = true;
  };
  const hostRenderer = {
    ...renderer(),
    props: [],
    set() {},
    isDeleted: () => false,
    addViewProp(value) {
      this.props.push(value);
    },
    removeViewProp(value) {
      this.props = this.props.filter((candidate) => candidate !== value);
    },
    getViewProps() {
      return this.props;
    },
  };
  const actorBuilds = [firstActor, secondActor];
  const instances = new Map();
  const synchronizerContext = {
    getInstance: (id) => instances.get(String(id)) ?? null,
    registerInstance: (id, instance) => instances.set(String(id), instance),
    unregisterInstance: (id) => instances.delete(String(id)),
  };
  const objectManager = {
    build(type) {
      if (type === "vtkStreamedSceneActor") return actorBuilds.shift();
      if (type === "vtkRenderer") return hostRenderer;
      return null;
    },
  };
  const mirror = mirrorModule.createMirrorStore();
  const reconciler = reconcileModule.createReconciler({
    synchronizerContext,
    objectManager,
    rootId: "root",
    rootInstance: null,
  });
  const host = hostModule.createStreamedSceneHost({ factories });
  let blockCalls = 0;
  reconciler.registerBlockHandler("streamedScene", (...args) => {
    blockCalls += 1;
    host.applyBlock(...args);
  });
  const actorNode = {
    type: "vtkStreamedSceneActor",
    props: {},
    refs: {},
    blocks: { streamedScene: pointBlock() },
  };
  const rendererNode = {
    type: "vtkRenderer",
    props: {},
    refs: { viewProps: ["anchor"] },
  };
  const referrersOf = (nodeId, slot) => {
    const ids = [];
    for (const [id, node] of mirror.entries()) {
      const value = node.refs?.[slot];
      if (value === nodeId || value?.includes?.(nodeId)) ids.push(id);
    }
    return ids;
  };
  const context = {
    renderers: [hostRenderer],
    renderWindow: { getViews: () => [{ getSize: () => [200, 100] }] },
    topologyVersion: 1,
    getInstance: synchronizerContext.getInstance,
    referrersOf,
  };
  reconciler.applyMessage(
    [
      { op: "upsert", id: "anchor", node: actorNode },
      { op: "upsert", id: "renderer", node: rendererNode },
    ],
    mirror,
    new Map(),
  );
  host.beforeRender(context);
  assert.equal(blockCalls, 1);
  assert.equal(
    firstMember.calls.some(([name]) => name === "prepare"),
    true,
  );

  firstActor.deleted = true;
  reconciler.applyMessage(
    [{ op: "upsert", id: "anchor", node: actorNode }],
    mirror,
    new Map(),
  );
  context.topologyVersion += 1;
  assert.equal(blockCalls, 1, "unchanged feature block was not invoked again");
  host.beforeRender(context);
  assert.equal(firstMember.calls.at(-1)[0], "dispose");
  assert.equal(
    secondMember.calls.some(([name]) => name === "prepare"),
    true,
  );
  assert.equal(host.describe().members[0].hasMember, true);
  host.dispose();
  reconciler.teardown();
});

test("hosts share one page-wide memory pool while coordinators remain per view", async () => {
  const { createStreamedSceneHost } = await loadModule(
    "/src/components/streamedSceneHost.js",
  );
  const first = coordinatorLog();
  const second = coordinatorLog();
  const one = createStreamedSceneHost({
    createCoordinator: fakeCoordinatorFactory(first),
  });
  const two = createStreamedSceneHost({
    createCoordinator: fakeCoordinatorFactory(second),
  });
  assert.equal(first.options.memory, second.options.memory);
  assert.equal(first.options.workers, second.options.workers);
  assert.notEqual(first, second);
  one.dispose();
  two.dispose();
});

test("tiles members receive live capabilities, offline assets, and rebuild after context change", async () => {
  const { createStreamedSceneHost, TILES3D_ASSET_URLS } = await loadModule(
    "/src/components/streamedSceneHost.js",
  );
  const firstMember = fakeMember();
  const fallbackMember = fakeMember();
  firstMember.stats = () => ({
    sseMultiplier: 2,
    renderer: {
      residentGeometryBytes: 30,
      logicalGeometryUploadBytes: 60,
      logicalTextureUploadBytes: 15,
      logicalUploadBytes: 75,
      submittedTextureBytes: 8,
      pooledTextureBytes: 4,
      residentTextureBytes: 12,
      residentBytes: 42,
      textureRepresentation: "compressed",
      textureFormats: ["astc-4x4"],
      drawnTiles: 4,
      drawnActors: 8,
      drawnPrimitives: 8,
      drawnTextureBytes: 8,
      drawnTriangles: 20,
    },
    submissions: {
      queuedJobs: 3,
      queuedBytes: 40,
      lastFrameAdmittedJobs: 2,
      lastFrameAdmittedBytes: 25,
    },
  });
  const factories = factoriesFor(
    new Map([["tiles3d", [firstMember, fallbackMember]]]),
  );
  const log = coordinatorLog();
  const anchor = actor();
  const hostRenderer = renderer();
  const context = sceneContext(
    new Map([["mesh", { actor: anchor, renderer: hostRenderer }]]),
  );
  const astc = {
    COMPRESSED_RGBA_ASTC_4x4_KHR: 1,
    COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR: 2,
  };
  const gl = {
    VERSION: 0x1f02,
    getParameter: () => "WebGL 2.0",
    getExtension(name) {
      return name === "WEBGL_compressed_texture_astc" ? astc : null;
    },
  };
  context.openGLRenderWindow = { getContext: () => gl };
  const host = createStreamedSceneHost({
    factories,
    createCoordinator: fakeCoordinatorFactory(log),
  });
  host.applyBlock("mesh", tilesBlock(), anchor);
  host.beforeRender(context);
  assert.deepEqual(firstMember.factoryConfig.wasm, {
    draco: {
      wrapperUrl: `http://localhost${TILES3D_ASSET_URLS.wasm.draco.wrapperUrl}`,
      wasmUrl: `http://localhost${TILES3D_ASSET_URLS.wasm.draco.wasmUrl}`,
    },
    basis: {
      encoderUrl: `http://localhost${TILES3D_ASSET_URLS.wasm.basis.encoderUrl}`,
      wasmUrl: `http://localhost${TILES3D_ASSET_URLS.wasm.basis.wasmUrl}`,
    },
  });
  assert.equal(
    log.options.textureCapabilities.capabilityKey,
    "compressed-texture-v1:astc-4x4",
  );
  assert.deepEqual(log.options.textureCapabilities.compressedFormats, [
    "astc-4x4",
  ]);
  assert.equal(host.describe().members[0].kind, "tiles3d");
  assert.deepEqual(
    {
      basisRuntimeInitializationMs:
        host.describe().decodePool.basisRuntimeInitializationMs,
      basisTranscodeMs: host.describe().decodePool.basisTranscodeMs,
      basisTargets: host.describe().decodePool.basisTargets,
      basisTargetTimings: host.describe().decodePool.basisTargetTimings,
    },
    {
      basisRuntimeInitializationMs: 0,
      basisTranscodeMs: 0,
      basisTargets: {},
      basisTargetTimings: {},
    },
  );
  assert.deepEqual(
    {
      ...host.describe().members[0].stats,
      renderer: undefined,
      submissions: undefined,
    },
    {
      sseMultiplier: 2,
      residentGeometryBytes: 30,
      logicalGeometryUploadBytes: 60,
      logicalTextureUploadBytes: 15,
      logicalUploadBytes: 75,
      submittedTextureBytes: 8,
      pooledTextureBytes: 4,
      residentTextureBytes: 12,
      residentBytes: 42,
      textureRepresentation: "compressed",
      textureFormats: ["astc-4x4"],
      queuedSubmissionJobs: 3,
      queuedSubmissionBytes: 40,
      lastFrameAdmittedJobs: 2,
      lastFrameAdmittedBytes: 25,
      drawnTiles: 4,
      drawnActors: 8,
      drawnPrimitives: 8,
      drawnTextureBytes: 8,
      drawnTriangles: 20,
      renderer: undefined,
      submissions: undefined,
    },
  );

  context.openGLRenderWindow = {
    getContext: () => ({
      VERSION: 0x1f02,
      getParameter: () => "WebGL 1.0",
      getExtension: () => null,
    }),
  };
  host.beforeRender(context);
  assert.equal(firstMember.calls.at(-1)[0], "dispose");
  assert.equal(fallbackMember.factoryContext.renderer, hostRenderer);
  assert.equal(
    host.describe().textureCapabilities.capabilityKey,
    "compressed-texture-v1:rgba",
  );
  host.dispose();
});

test("software WebGL contexts force KTX2 decoding through RGBA fallback", async () => {
  const {
    createStreamedSceneHost,
    isHeadlessBrowserUserAgent,
    isSoftwareWebGLRenderer,
    texturePolicyRgbaReason,
  } = await loadModule("/src/components/streamedSceneHost.js");
  assert.equal(isSoftwareWebGLRenderer("Google SwiftShader"), true);
  assert.equal(isSoftwareWebGLRenderer("llvmpipe (LLVM 18.1)"), true);
  assert.equal(isSoftwareWebGLRenderer("ANGLE (NVIDIA RTX 3000 Ada)"), false);
  assert.equal(isHeadlessBrowserUserAgent("HeadlessChrome/128.0"), true);
  assert.equal(isHeadlessBrowserUserAgent("Chrome/128.0"), false);
  assert.equal(
    texturePolicyRgbaReason(
      "ANGLE (NVIDIA RTX 3000 Ada)",
      "Chrome/128.0",
      "rgba",
    ),
    "forced-control",
  );
  assert.equal(
    texturePolicyRgbaReason(
      "ANGLE (NVIDIA RTX 3000 Ada)",
      "HeadlessChrome/128.0",
      null,
    ),
    "headless-browser",
  );
  assert.equal(
    texturePolicyRgbaReason(
      "Google SwiftShader",
      "HeadlessChrome/128.0",
      "native",
    ),
    null,
    "an explicit native policy overrides automatic fallbacks",
  );

  const member = fakeMember();
  const factories = factoriesFor(new Map([["tiles3d", [member]]]));
  const log = coordinatorLog();
  const anchor = actor();
  const hostRenderer = renderer();
  const context = sceneContext(
    new Map([["mesh", { actor: anchor, renderer: hostRenderer }]]),
  );
  const debug = {
    UNMASKED_VENDOR_WEBGL: 0x9245,
    UNMASKED_RENDERER_WEBGL: 0x9246,
  };
  const gl = {
    VERSION: 0x1f02,
    getExtension(name) {
      if (name === "WEBGL_debug_renderer_info") return debug;
      if (name === "WEBGL_compressed_texture_astc") {
        return {
          COMPRESSED_RGBA_ASTC_4x4_KHR: 1,
          COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR: 2,
        };
      }
      return null;
    },
    getParameter(parameter) {
      if (parameter === debug.UNMASKED_VENDOR_WEBGL) return "Google Inc.";
      if (parameter === debug.UNMASKED_RENDERER_WEBGL)
        return "Google SwiftShader";
      if (parameter === this.VERSION) return "WebGL 2.0";
      return null;
    },
  };
  context.openGLRenderWindow = { getContext: () => gl };
  const host = createStreamedSceneHost({
    factories,
    createCoordinator: fakeCoordinatorFactory(log),
  });
  host.applyBlock("mesh", tilesBlock(), anchor);
  host.beforeRender(context);

  assert.deepEqual(log.options.textureCapabilities, {
    capabilityKey: "compressed-texture-v1:rgba",
    compressedFormats: [],
  });
  assert.equal(host.describe().webglRenderer.renderer, "Google SwiftShader");
  assert.deepEqual(host.describe().texturePolicy, {
    mode: "rgba",
    rgbaReason: "software-renderer",
  });
  host.dispose();
});

test("URL query parameters cannot override 3D Tiles host policies", async () => {
  const { createStreamedSceneHost } = await loadModule(
    "/src/components/streamedSceneHost.js",
  );
  const locationDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      href: "http://localhost/?tiles3dTexturePolicy=rgba&tiles3dQualityPolicy=fixed",
    },
  });
  const log = coordinatorLog();
  const gl = {
    VERSION: 0x1f02,
    VENDOR: 0x1f00,
    RENDERER: 0x1f01,
    getExtension(name) {
      if (name === "WEBGL_compressed_texture_astc") {
        return {
          COMPRESSED_RGBA_ASTC_4x4_KHR: 1,
          COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR: 2,
        };
      }
      return null;
    },
    getParameter(parameter) {
      if (parameter === this.VENDOR) return "Google Inc.";
      if (parameter === this.RENDERER) return "ANGLE (NVIDIA RTX 3000 Ada)";
      if (parameter === this.VERSION) return "WebGL 2.0";
      return null;
    },
  };
  const host = createStreamedSceneHost({
    createCoordinator: fakeCoordinatorFactory(log),
  });
  try {
    host.beforeRender({ openGLRenderWindow: { getContext: () => gl } });
    assert.deepEqual(host.describe().texturePolicy, {
      mode: "native",
      rgbaReason: null,
    });
    assert.deepEqual(host.describe().tiles3dQualityPolicy, {
      mode: "adaptive",
      reason: null,
    });
  } finally {
    host.dispose();
    if (locationDescriptor) {
      Object.defineProperty(globalThis, "location", locationDescriptor);
    } else {
      delete globalThis.location;
    }
  }
});

test("masked software renderer forces RGBA when the debug extension is absent", async () => {
  const { createStreamedSceneHost } = await loadModule(
    "/src/components/streamedSceneHost.js",
  );
  const member = fakeMember();
  const factories = factoriesFor(new Map([["tiles3d", [member]]]));
  const log = coordinatorLog();
  const anchor = actor();
  const hostRenderer = renderer();
  const context = sceneContext(
    new Map([["mesh", { actor: anchor, renderer: hostRenderer }]]),
  );
  const gl = {
    VERSION: 0x1f02,
    VENDOR: 0x1f00,
    RENDERER: 0x1f01,
    getExtension(name) {
      if (name === "WEBGL_compressed_texture_astc") {
        return {
          COMPRESSED_RGBA_ASTC_4x4_KHR: 1,
          COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR: 2,
        };
      }
      return null;
    },
    getParameter(parameter) {
      if (parameter === this.VENDOR) return "Google Inc.";
      if (parameter === this.RENDERER)
        return "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))";
      if (parameter === this.VERSION) return "WebGL 2.0";
      return null;
    },
  };
  context.openGLRenderWindow = { getContext: () => gl };
  const host = createStreamedSceneHost({
    factories,
    createCoordinator: fakeCoordinatorFactory(log),
  });
  host.applyBlock("mesh", tilesBlock(), anchor);
  host.beforeRender(context);
  assert.equal(
    host.describe().textureCapabilities.capabilityKey,
    "compressed-texture-v1:rgba",
  );
  assert.match(host.describe().webglRenderer.renderer, /SwiftShader/);
  host.dispose();
});

test("a throwing factory is quarantined per entry without starving peers", async () => {
  const { createStreamedSceneHost } = await loadModule(
    "/src/components/streamedSceneHost.js",
  );
  const log = coordinatorLog();
  const healthy = fakeMember();
  const recovered = fakeMember();
  let attempts = 0;
  const factories = {
    has: (kind) => kind === "pointCloud",
    create(_kind, _context, config) {
      if (config.endpoint.includes("broken")) {
        attempts += 1;
        throw new Error("decoder unavailable");
      }
      return config.sourceAssetId === "healthy" ? healthy : recovered;
    },
  };
  const badActor = actor();
  const goodActor = actor();
  const hostRenderer = renderer();
  const context = sceneContext(
    new Map([
      ["bad", { actor: badActor, renderer: hostRenderer }],
      ["good", { actor: goodActor, renderer: hostRenderer }],
    ]),
  );
  const host = createStreamedSceneHost({
    factories,
    createCoordinator: fakeCoordinatorFactory(log),
  });
  host.applyBlock(
    "bad",
    pointBlock({
      sourceAssetId: "recoverable",
      endpoint: "/pointcloud/broken/rev-1",
    }),
    badActor,
  );
  host.applyBlock("good", pointBlock({ sourceAssetId: "healthy" }), goodActor);
  host.beforeRender(context);
  assert.equal(attempts, 1);
  assert.equal(healthy.calls.filter(([name]) => name === "prepare").length, 1);
  assert.equal(
    host.describe().members.find(({ nodeId }) => nodeId === "bad").error,
    "decoder unavailable",
  );

  host.beforeRender(context);
  assert.equal(attempts, 1, "unchanged quarantine does not retry every frame");
  assert.equal(healthy.calls.filter(([name]) => name === "prepare").length, 2);
  context.topologyVersion += 1;
  host.beforeRender(context);
  assert.equal(
    attempts,
    1,
    "an unrelated scene topology message does not retry a permanent failure",
  );
  const replacementRenderer = renderer();
  context.bind("bad", badActor, replacementRenderer);
  host.beforeRender(context);
  assert.equal(
    attempts,
    2,
    "moving the anchor to a new renderer permits one retry",
  );
  host.applyBlock(
    "bad",
    pointBlock({
      sourceAssetId: "recoverable",
      endpoint: "/pointcloud/recovered/rev-1",
    }),
    badActor,
  );
  host.beforeRender(context);
  assert.equal(
    recovered.calls.some(([name]) => name === "prepare"),
    true,
  );
  assert.equal(
    host.describe().members.find(({ nodeId }) => nodeId === "bad").error,
    null,
  );
  host.dispose();
});

test("host motion, governor targets, frame feedback, and nested interactions share one coordinator", async () => {
  const { createStreamedSceneHost } = await loadModule(
    "/src/components/streamedSceneHost.js",
  );
  const member = fakeMember();
  const factories = factoriesFor(new Map([["pointCloud", [member]]]));
  const anchor = actor();
  const position = [0, 0, 10];
  const camera = {
    getCompositeProjectionMatrix: () => IDENTITY.slice(),
    getPosition: () => position.slice(),
  };
  const hostRenderer = {
    ...renderer(),
    getActiveCamera: () => camera,
  };
  const context = sceneContext(
    new Map([["adaptive", { actor: anchor, renderer: hostRenderer }]]),
  );
  const host = createStreamedSceneHost({
    factories,
    coordinatorOptions: {
      governor: { motionDebounceMs: 0, interactionSettleMs: 0 },
    },
  });
  host.applyBlock(
    "adaptive",
    pointBlock({
      pointCloud: {
        ...pointBlock().pointCloud,
        adaptive: true,
        adaptiveOptions: {
          interactionTargetMs: 14,
          stationaryTargetMs: 31,
        },
      },
    }),
    anchor,
  );
  host.beforeRender(context);
  assert.deepEqual(
    {
      target: host.describe().coordinator.targetOverrideMemberId,
      frameMs: host.describe().coordinator.governor.targetFrameTimeMs,
      regime: host.describe().coordinator.governor.regime,
    },
    { target: "adaptive", frameMs: 31, regime: "stationary" },
  );

  host.beginInteraction();
  host.beginInteraction();
  assert.equal(host.describe().coordinator.governor.regime, "interaction");
  host.endInteraction();
  assert.equal(host.describe().coordinator.governor.regime, "interaction");
  host.endInteraction();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(host.describe().coordinator.governor.regime, "stationary");
  assert.equal(member.calls.filter(([name]) => name === "begin").length, 2);
  assert.equal(member.calls.filter(([name]) => name === "end").length, 2);

  position[0] = 10;
  host.beforeRender(context);
  assert.equal(
    host.describe().coordinator.governor.regime,
    "interaction",
    "rendered camera change drives inferred motion",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  host.beforeRender(context);
  assert.equal(host.describe().coordinator.governor.regime, "stationary");
  host.recordHostFrame({ hostFrameMs: 10, vtkFrameMs: 8 });
  const publicFrameMetrics = host.describe().coordinator.governor.frameMetrics;
  assert.deepEqual(
    {
      frames: publicFrameMetrics.frames,
      peakHostFrameMs: publicFrameMetrics.peakHostFrameMs,
      lastHostFrameMs: publicFrameMetrics.lastHostFrameMs,
    },
    {
      frames: 1,
      peakHostFrameMs: 10,
      lastHostFrameMs: 10,
    },
  );
  assert.equal(publicFrameMetrics.peakObservedFrameMs, 8 / 0.7);
  assert.equal(publicFrameMetrics.lastObservedFrameMs, 8 / 0.7);
  assert.equal(typeof host.needsFrame(), "boolean");
  host.dispose();
});

test("a member realized mid-interaction inherits the held depth before ending", async () => {
  const { createStreamedSceneHost } = await loadModule(
    "/src/components/streamedSceneHost.js",
  );
  const member = fakeMember();
  const factories = factoriesFor(new Map([["pointCloud", [member]]]));
  const anchor = actor();
  anchor.visible = false;
  const hostRenderer = renderer();
  const context = sceneContext(
    new Map([["late", { actor: anchor, renderer: hostRenderer }]]),
  );
  const host = createStreamedSceneHost({ factories });
  host.applyBlock("late", pointBlock(), anchor);
  host.beginInteraction();
  host.beginInteraction();
  host.beforeRender(context);
  assert.equal(member.calls.length, 0, "hidden anchor has no member yet");
  anchor.visible = true;
  host.beforeRender(context);
  assert.equal(member.calls.filter(([name]) => name === "begin").length, 2);
  host.endInteraction();
  host.endInteraction();
  assert.equal(member.calls.filter(([name]) => name === "end").length, 2);
  host.dispose();
});

test("scoped picking returns hit, miss, occluded, or unavailable conservatively", async () => {
  const { createStreamedSceneHost } = await loadModule(
    "/src/components/streamedSceneHost.js",
  );
  const log = coordinatorLog();
  const target = fakeMember();
  const blocker = fakeMember();
  const factories = factoriesFor(
    new Map([
      ["pointCloud", [target]],
      ["tiles3d", [blocker]],
    ]),
  );
  const targetActor = actor();
  const blockerActor = actor();
  const hostRenderer = renderer();
  const bindings = new Map([
    ["target-node", { actor: targetActor, renderer: hostRenderer }],
    ["blocker-node", { actor: blockerActor, renderer: hostRenderer }],
  ]);
  const context = sceneContext(bindings);
  const host = createStreamedSceneHost({
    factories,
    createCoordinator: fakeCoordinatorFactory(log),
  });
  host.applyBlock("target-node", pointBlock(), targetActor);
  host.applyBlock("blocker-node", tilesBlock(), blockerActor);
  host.beforeRender(context);

  target.pickResult = {
    status: "hit",
    rayDepth: 10,
    scenePoint: [1, 2, 3],
    distancePx: 2,
  };
  blocker.occlusionResult = { status: "hit", rayDepth: 5 };
  assert.deepEqual(host.pickAsset("asset-1", 50, 25), {
    status: "occluded",
    asset_id: "asset-1",
    revision: "rev-1",
    node_id: "target-node",
    blocker: {
      asset_id: "mesh-1",
      revision: "mesh-rev-1",
      node_id: "blocker-node",
      kind: "tiles3d",
    },
  });

  blocker.occlusionResult = { status: "hit", rayDepth: 15 };
  assert.deepEqual(host.pickAsset("asset-1", 50, 25), {
    status: "hit",
    asset_id: "asset-1",
    revision: "rev-1",
    node_id: "target-node",
    frame: "scene",
    world: [1, 2, 3],
    distance_px: 2,
  });

  target.pickResult = { status: "miss" };
  blocker.occlusionResult = { status: "clear" };
  assert.deepEqual(host.pickAsset("asset-1", 50, 25), {
    status: "miss",
    asset_id: "asset-1",
    revision: "rev-1",
    node_id: "target-node",
    frame: "scene",
  });
  blocker.occlusionResult = { status: "hit", rayDepth: 100 };
  assert.equal(
    host.pickAsset("asset-1", 50, 25).status,
    "occluded",
    "target miss has infinite depth",
  );
  blocker.occlusionResult = null;
  assert.equal(host.pickAsset("asset-1", 50, 25), null);
  blocker.occlusionResult = { status: "hit", rayDepth: -1 };
  assert.equal(host.pickAsset("asset-1", 50, 25), null);

  blockerActor.visible = false;
  assert.equal(host.pickAsset("asset-1", 50, 25).status, "miss");
  hostRenderer.viewport = [0.5, 0, 1, 1];
  targetActor.matrix = IDENTITY.map((value, index) =>
    index === 12 ? 12 : value,
  );
  host.pickAsset("asset-1", 125, 25);
  const lastPick = target.calls.filter(([name]) => name === "pick").at(-1);
  assert.deepEqual(lastPick.slice(2), [25, 25]);
  assert.ok(
    target.calls.some(
      ([name, value]) => name === "model" && value === targetActor.matrix,
    ),
    "pick restates the live actor matrix",
  );
  hostRenderer.draw = false;
  assert.equal(host.pickAsset("asset-1", 125, 25), null);
  hostRenderer.draw = true;
  hostRenderer.viewport = [0, 0, 1, 1];
  targetActor.visible = false;
  assert.equal(host.pickAsset("asset-1", 50, 25), null);
  targetActor.visible = true;
  target.pickResult = null;
  assert.equal(host.pickAsset("asset-1", 50, 25), null);
  target.pickResult = {
    status: "hit",
    rayDepth: 0,
    scenePoint: [1, 2, 3],
    distancePx: 0,
  };
  assert.equal(host.pickAsset("asset-1", 50, 25), null);
  assert.equal(host.pickAsset("missing", 50, 25), null);
  const picking = host.describe().picking;
  assert.ok(picking.calls >= 10);
  assert.equal(
    Object.values(picking.statuses).reduce((sum, value) => sum + value, 0),
    picking.calls,
  );
  assert.ok(picking.statuses.hit >= 1);
  assert.ok(picking.statuses.miss >= 1);
  assert.ok(picking.statuses.occluded >= 1);
  assert.ok(picking.statuses.unavailable >= 1);
  assert.ok(picking.totalMs >= 0);
  assert.ok(picking.meanMs >= 0);
  assert.ok(picking.peakMs >= picking.meanMs);
  host.dispose();
});

test("cross-renderer blockers require overlapping viewports and the same world cursor ray", async () => {
  const { createStreamedSceneHost } = await loadModule(
    "/src/components/streamedSceneHost.js",
  );
  const log = coordinatorLog();
  const target = fakeMember();
  target.pickResult = {
    status: "hit",
    rayDepth: 10,
    scenePoint: [0, 0, 0],
    distancePx: 0,
  };
  const blocker = fakeMember();
  blocker.occlusionResult = { status: "hit", rayDepth: 5 };
  const factories = factoriesFor(
    new Map([
      ["pointCloud", [target]],
      ["tiles3d", [blocker]],
    ]),
  );
  const targetActor = actor();
  const blockerActor = actor();
  const targetRenderer = renderer();
  const blockerRenderer = renderer();
  const bindings = new Map([
    ["target-cross", { actor: targetActor, renderer: targetRenderer }],
    ["blocker-cross", { actor: blockerActor, renderer: blockerRenderer }],
  ]);
  const context = sceneContext(bindings);
  const host = createStreamedSceneHost({
    factories,
    createCoordinator: fakeCoordinatorFactory(log),
  });
  host.applyBlock("target-cross", pointBlock(), targetActor);
  host.applyBlock("blocker-cross", tilesBlock(), blockerActor);
  host.beforeRender(context);

  assert.equal(host.pickAsset("asset-1", 50, 25).status, "occluded");
  targetRenderer.viewport = [0, 0, 0.5, 1];
  blockerRenderer.viewport = [0.5, 0, 1, 1];
  const occlusionCalls = () =>
    blocker.calls.filter(([name]) => name === "occlusion").length;
  const beforeNonOverlap = occlusionCalls();
  assert.equal(host.pickAsset("asset-1", 50, 25).status, "hit");
  assert.equal(
    occlusionCalls(),
    beforeNonOverlap,
    "outside blocker viewport is a valid clear skip",
  );
  assert.equal(
    host.pickAsset("asset-1", 150, 25),
    null,
    "outside target viewport is unavailable",
  );

  targetRenderer.viewport = [0, 0, 1, 1];
  blockerRenderer.viewport = [0, 0, 1, 1];
  const shifted = IDENTITY.slice();
  shifted[3] = 0.5;
  blockerRenderer.getActiveCamera = () => ({
    getCompositeProjectionMatrix: () => shifted,
    getPosition: () => [10, 0, 10],
  });
  const beforeDifferentRay = occlusionCalls();
  assert.equal(host.pickAsset("asset-1", 50, 25), null);
  assert.equal(
    occlusionCalls(),
    beforeDifferentRay,
    "independent camera ray is rejected before depth comparison",
  );
  host.dispose();
});

test("duplicate identity and unresolved active blockers make a scoped query unavailable", async () => {
  const { createStreamedSceneHost } = await loadModule(
    "/src/components/streamedSceneHost.js",
  );
  const log = coordinatorLog();
  const target = fakeMember();
  target.pickResult = { status: "miss" };
  const blocker = fakeMember();
  const duplicate = fakeMember();
  const factories = factoriesFor(
    new Map([
      ["pointCloud", [target, duplicate]],
      ["tiles3d", [blocker]],
    ]),
  );
  const targetActor = actor();
  const blockerActor = actor();
  const duplicateActor = actor();
  const hostRenderer = renderer();
  const bindings = new Map([
    ["target", { actor: targetActor, renderer: hostRenderer }],
    ["blocker", { actor: blockerActor, renderer: hostRenderer }],
    ["duplicate", { actor: duplicateActor, renderer: hostRenderer }],
  ]);
  const context = sceneContext(bindings);
  const host = createStreamedSceneHost({
    factories,
    createCoordinator: fakeCoordinatorFactory(log),
  });
  host.applyBlock("target", pointBlock(), targetActor);
  host.applyBlock("blocker", tilesBlock(), blockerActor);
  host.beforeRender(context);
  context.remove("blocker");
  assert.equal(host.pickAsset("asset-1", 20, 20), null);

  host.applyBlock("duplicate", pointBlock(), duplicateActor);
  host.beforeRender(context);
  assert.equal(host.pickAsset("asset-1", 20, 20), null);
  host.dispose();
});

test("gesture enrichment preserves tag, armed override, and unavailable semantics", async () => {
  const { enrichGestureWithCloudSolve } = await loadModule(
    "/src/components/streamedSceneHost.js",
  );
  const calls = [];
  const pick = (asset, x, y) => {
    calls.push([asset, x, y]);
    return asset === "unavailable"
      ? null
      : { status: "miss", asset_id: asset, revision: "r", node_id: "n" };
  };
  const tagged = {
    type: "target.click",
    pointer: { x: 3, y: 4 },
    pick: { tags: { depth_asset_id: "tagged" } },
  };
  assert.equal(
    enrichGestureWithCloudSolve(tagged, pick).cloud_solve.asset_id,
    "tagged",
  );
  assert.equal(
    enrichGestureWithCloudSolve(tagged, pick, "armed").cloud_solve.asset_id,
    "armed",
  );
  assert.equal(
    enrichGestureWithCloudSolve(
      { type: "background.click", pointer: { x: 1, y: 2 }, pick: null },
      pick,
      "armed",
    ).cloud_solve.asset_id,
    "armed",
  );
  assert.equal(
    enrichGestureWithCloudSolve(
      { ...tagged, type: "target.drag.move" },
      pick,
      "armed",
    ).cloud_solve.asset_id,
    "tagged",
    "armed clicks never redirect drags",
  );
  assert.equal(
    enrichGestureWithCloudSolve(
      { ...tagged, pick: { tags: { depth_asset_id: "unavailable" } } },
      pick,
    ).cloud_solve,
    undefined,
  );
  assert.deepEqual(
    enrichGestureWithCloudSolve({ ...tagged, cancelled: true }, pick),
    { ...tagged, cancelled: true },
  );
  assert.ok(calls.length >= 5);
});

test("useSceneSync lazily routes lifecycle, picking, feedback, and diagnostics through the host", async () => {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");
  const handlers = new Map();
  const calls = [];
  let createCount = 0;
  let hostOptions = null;
  let renders = 0;
  let engineCallbacks = null;
  const fakeHost = {
    applyBlock: (...args) => calls.push(["block", ...args]),
    beforeRender: (value) => calls.push(["before", value]),
    beginInteraction: () => calls.push(["begin"]),
    endInteraction: () => calls.push(["end"]),
    recordHostFrame: (value) => calls.push(["frame", value]),
    needsFrame: () => true,
    pickAsset: (...args) => ({ status: "miss", args }),
    describe: () => ({ members: [{ nodeId: "42" }], coordinator: {} }),
    dispose: () => calls.push(["dispose"]),
  };
  const scene = useSceneSync(
    {
      client: {},
      emit() {},
      getRenderWindow: () => ({ getRenderers: () => [], getViews: () => [] }),
      renderScene() {},
      tiles3dTexturePolicy: "rgba",
      tiles3dQualityPolicy: "fixed",
    },
    {
      createManagedSyncContext: () => ({
        synchronizerContext: { getInstance: () => null },
        syncRenderWindow: null,
        cleanup() {},
      }),
      createMirrorStore: () => ({
        entries: () => [][Symbol.iterator](),
        get: () => null,
        clear() {},
      }),
      createReconciler: () => ({
        registerBlockHandler(key, handler) {
          handlers.set(key, handler);
        },
        teardown() {},
      }),
      createSceneEngine: (options) => {
        engineCallbacks = options.callbacks;
        return {
          start() {},
          stop() {},
          onCommand: () => () => {},
          getDiagnostics: () => ({}),
        };
      },
      createStreamedSceneHost: (options) => {
        createCount += 1;
        hostOptions = options;
        return fakeHost;
      },
    },
  );
  scene.initialize({
    contextName: "streamed-host",
    renderWindowId: 1,
    onRenderNeeded: () => {
      renders += 1;
    },
  });
  assert.equal(createCount, 0);
  assert.equal(handlers.has("streamedScene"), true);
  assert.equal(handlers.has("pointCloudLod"), false);
  handlers.get("streamedScene")("missing", null, null);
  assert.equal(createCount, 0, "a removal without a host stays lazy");

  scene.beginCameraInteraction();
  const anchor = actor();
  handlers.get("streamedScene")("42", pointBlock(), anchor);
  assert.equal(createCount, 1);
  assert.equal(hostOptions.tiles3dTexturePolicy, "rgba");
  assert.equal(hostOptions.tiles3dQualityPolicy, "fixed");
  assert.equal(typeof hostOptions.scheduleRender, "function");
  assert.deepEqual(calls.slice(0, 2), [
    ["begin"],
    ["block", "42", pointBlock(), anchor],
  ]);
  const beforeApplyCount = calls.filter(([name]) => name === "before").length;
  const rendersBeforeApply = renders;
  engineCallbacks.onApplied({ kind: "ops", seq: 1, ops: [{}] });
  assert.equal(
    calls.filter(([name]) => name === "before").length,
    beforeApplyCount,
    "an applied websocket message waits for the requested paint to prepare streaming",
  );
  assert.equal(renders, rendersBeforeApply + 1);
  scene.beforeRender();
  scene.beforeRender();
  const prepared = calls.filter(([name]) => name === "before");
  assert.equal(prepared.at(-2)[1].frameSerial, 1);
  assert.equal(
    prepared.at(-1)[1].frameSerial,
    1,
    "nested render hooks share the pending paint serial",
  );
  assert.deepEqual(scene.getSyncDiagnostics().rendering, {
    preparedFrameSerial: 1,
    completedFrameSerial: 0,
    completedPreparedFrameSerial: 0,
    sceneSeqAtLastPaint: -1,
  });
  scene.recordFrameDuration(3);
  assert.equal(
    scene.getSyncDiagnostics().rendering.completedFrameSerial,
    0,
    "host repaint requests do not claim that pixels completed",
  );
  scene.recordPaintDuration(6);
  assert.deepEqual(scene.getSyncDiagnostics().rendering, {
    preparedFrameSerial: 1,
    completedFrameSerial: 1,
    completedPreparedFrameSerial: 1,
    sceneSeqAtLastPaint: -1,
  });
  scene.beforeRender();
  assert.equal(
    calls.filter(([name]) => name === "before").at(-1)[1].frameSerial,
    2,
  );
  scene.endCameraInteraction();
  assert.ok(calls.some(([name]) => name === "before"));
  assert.ok(calls.some(([name]) => name === "end"));
  assert.deepEqual(scene.pickCloudPoint("asset-1", 3, 4), {
    status: "miss",
    args: ["asset-1", 3, 4],
  });
  scene.recordHostFrame({ hostFrameMs: 9, vtkFrameMs: 7 });
  assert.ok(calls.some(([name]) => name === "frame"));
  assert.ok(renders > 0, "needsFrame schedules the next coalesced paint");
  assert.deepEqual(scene.getSyncDiagnostics().streamedScene.members, [
    { nodeId: "42" },
  ]);
  scene.cleanup();
  assert.equal(calls.at(-1)[0], "dispose");
});

test("useSceneSync emits tagged drag solves and armed click overrides", async () => {
  const [{ useSceneSync }, glyph, polydata, points] = await Promise.all([
    loadModule("/src/components/useSceneSync.js"),
    loadModule("/node_modules/@kitware/vtk.js/Rendering/Core/Glyph3DMapper.js"),
    loadModule("/node_modules/@kitware/vtk.js/Common/DataModel/PolyData.js"),
    loadModule("/node_modules/@kitware/vtk.js/Common/Core/Points.js"),
  ]);
  const canvas = {
    style: { cursor: "" },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    setPointerCapture() {},
    releasePointerCapture() {},
    addEventListener() {},
    removeEventListener() {},
  };
  const hostRenderer = renderer();
  hostRenderer.get = () => ({ remoteId: "renderer" });
  const renderWindow = {
    getRenderers: () => [hostRenderer],
    getViews: () => [{ getSize: () => [200, 100], getCanvas: () => canvas }],
  };
  const mapper = glyph.default.newInstance();
  const poly = polydata.default.newInstance();
  const pts = points.default.newInstance();
  pts.setData(new Float32Array([0.1, 0.1, 0.1]), 3);
  poly.setPoints(pts);
  mapper.setInputData(poly);

  const hostPickCalls = [];
  const fakeHost = {
    applyBlock() {},
    beforeRender() {},
    beginInteraction() {},
    endInteraction() {},
    recordHostFrame() {},
    needsFrame: () => false,
    pickAsset(assetId, x, y) {
      hostPickCalls.push([assetId, x, y]);
      return {
        status: "miss",
        asset_id: assetId,
        revision: "r",
        node_id: "anchor",
      };
    },
    describe: () => ({ members: [], coordinator: {} }),
    dispose() {},
  };
  const handlers = new Map();
  const emitted = [];
  const scene = useSceneSync(
    {
      client: {},
      emit: (type, payload) => emitted.push([type, payload]),
      getRenderWindow: () => renderWindow,
      renderScene() {},
    },
    {
      createManagedSyncContext: () => ({
        synchronizerContext: {
          getInstance: () => null,
          getInstanceId: () => null,
        },
        syncRenderWindow: renderWindow,
        cleanup() {},
      }),
      createMirrorStore: () => ({
        entries: () => [][Symbol.iterator](),
        get: () => null,
        clear() {},
      }),
      createReconciler: () => ({
        registerBlockHandler(key, handler) {
          handlers.set(key, handler);
        },
        teardown() {},
      }),
      createSceneEngine: () => ({
        start() {},
        stop() {},
        onCommand: () => () => {},
        getSeq: () => 1,
        getDiagnostics: () => ({}),
      }),
      createStreamedSceneHost: () => fakeHost,
    },
  );
  scene.initialize({ contextName: "emitted-solves", renderWindowId: 1 });
  handlers.get("streamedScene")("anchor", pointBlock(), actor());
  handlers.get("pickable")(
    "glyph",
    { grabPx: 8, priority: 0, tags: { depth_asset_id: "tagged" } },
    mapper,
  );
  scene.setArmedCloudPick("armed");
  assert.equal(
    scene.startTargetDrag({
      clientX: 110,
      clientY: 45,
      pointerId: 1,
      preventDefault() {},
      stopImmediatePropagation() {},
    }),
    true,
  );
  let payload = emitted.filter(([type]) => type === "pointerEvent").at(-1)[1];
  assert.equal(payload.type, "target.drag.start");
  assert.equal(payload.cloud_solve.asset_id, "tagged");
  scene.emitTargetClick({
    clientX: 110,
    clientY: 45,
    preventDefault() {},
    stopImmediatePropagation() {},
  });
  payload = emitted.filter(([type]) => type === "pointerEvent").at(-1)[1];
  assert.equal(payload.type, "target.click");
  assert.equal(payload.pick.tags.depth_asset_id, "tagged");
  assert.equal(payload.cloud_solve.asset_id, "armed");
  assert.deepEqual(
    hostPickCalls.map(([assetId]) => assetId),
    ["tagged", "armed"],
  );
  scene.cleanup();
  mapper.delete();
  poly.delete();
  pts.delete();
});
