import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

function assertAlmostEqual(actual, expected, tolerance = 1e-5) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

// Row-major -> column-major (matches the module's transpose). pickAt transposes
// whatever the camera returns, so a test passes the matrix it wants pickAt to
// actually consume (identity, or the behind-camera variant) already transposed.
function transposeMatrix(matrix) {
  return [
    matrix[0],
    matrix[4],
    matrix[8],
    matrix[12],
    matrix[1],
    matrix[5],
    matrix[9],
    matrix[13],
    matrix[2],
    matrix[6],
    matrix[10],
    matrix[14],
    matrix[3],
    matrix[7],
    matrix[11],
    matrix[15],
  ];
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const WIDTH = 800;
const HEIGHT = 400;

// Identity projection maps world (x, y, z) -> NDC (x, y) with w = 1, so
// world (0, 0, 0) lands at canvas center (400, 200) and world (0.5, 0, 0)
// lands at (600, 200).
function makeContext(worldToClipConsumed = IDENTITY) {
  const camera = {
    getCompositeProjectionMatrix: () => transposeMatrix(worldToClipConsumed),
  };
  return {
    renderer: {
      getActiveCamera: () => camera,
      getViewport: () => [0, 0, 1, 1],
    },
    renderWindow: {
      getViews: () => [{ getSize: () => [WIDTH, HEIGHT] }],
    },
  };
}

async function loadPickables() {
  return loadModule("/src/components/pickables.js");
}

async function loadVtk() {
  const [glyph, polydata, points] = await Promise.all([
    loadModule("/node_modules/@kitware/vtk.js/Rendering/Core/Glyph3DMapper.js"),
    loadModule("/node_modules/@kitware/vtk.js/Common/DataModel/PolyData.js"),
    loadModule("/node_modules/@kitware/vtk.js/Common/Core/Points.js"),
  ]);
  return {
    glyph: glyph.default,
    polydata: polydata.default,
    points: points.default,
  };
}

function buildMapper(vtk, coords) {
  const mapper = vtk.glyph.newInstance();
  const poly = vtk.polydata.newInstance();
  const pts = vtk.points.newInstance();
  pts.setData(new Float32Array(coords), 3);
  poly.setPoints(pts);
  mapper.setInputData(poly);
  return { mapper, poly, pts };
}

function pickableBlock({ ids = null, grabPx, priority = 0, tags = {} }) {
  return { ids, grabPx, priority, tags };
}

function contextFor(instances) {
  return { getInstance: (id) => instances.get(String(id)) || null };
}

test("pickAt returns the nearest point within the grab radius", async () => {
  const pickables = await loadPickables();
  const vtk = await loadVtk();

  const { mapper } = buildMapper(vtk, [0, 0, 0]);
  const instances = new Map([["mapperA", mapper]]);
  const ctx = contextFor(instances);

  const registry = pickables.createPickableRegistry();
  pickables.applyPickableBlock(
    registry,
    "mapperA",
    pickableBlock({
      ids: ["alpha"],
      grabPx: 20,
      priority: 3,
      tags: { group: "A" },
    }),
    mapper,
  );

  const view = makeContext();
  const hit = pickables.pickAt(registry, 410, 200, {
    renderer: view.renderer,
    renderWindow: view.renderWindow,
    synchronizerContext: ctx,
  });

  assert.ok(hit);
  assert.equal(hit.nodeId, "mapperA");
  assert.equal(hit.pointIndex, 0);
  assert.equal(hit.pointId, "alpha");
  assert.deepEqual(hit.tags, { group: "A" });
  assert.deepEqual(hit.world, [0, 0, 0]);
  assertAlmostEqual(hit.distancePx, 10);
  // grab offset = projected center - pointer.
  assertAlmostEqual(hit.grabOffset.x, -10);
  assertAlmostEqual(hit.grabOffset.y, 0);
});

test("pickAt honors the grab radius boundary", async () => {
  const pickables = await loadPickables();
  const vtk = await loadVtk();

  const { mapper } = buildMapper(vtk, [0, 0, 0]);
  const instances = new Map([["m", mapper]]);
  const ctx = contextFor(instances);

  const registry = pickables.createPickableRegistry();
  pickables.applyPickableBlock(
    registry,
    "m",
    pickableBlock({ grabPx: 20 }),
    mapper,
  );

  const view = makeContext();
  const opts = {
    renderer: view.renderer,
    renderWindow: view.renderWindow,
    synchronizerContext: ctx,
  };

  // 0.95 * radius (19 px) -> inside.
  assert.ok(pickables.pickAt(registry, 419, 200, opts));
  // 1.3 * radius (26 px) -> outside.
  assert.equal(pickables.pickAt(registry, 426, 200, opts), null);
});

test("pickAt breaks ties by priority then declaration order", async () => {
  const pickables = await loadPickables();
  const vtk = await loadVtk();

  const a = buildMapper(vtk, [0, 0, 0]);
  const b = buildMapper(vtk, [0, 0, 0]);
  const instances = new Map([
    ["a", a.mapper],
    ["b", b.mapper],
  ]);
  const ctx = contextFor(instances);
  const view = makeContext();
  const opts = {
    renderer: view.renderer,
    renderWindow: view.renderWindow,
    synchronizerContext: ctx,
  };

  // Higher priority wins even though both are exactly on the pointer.
  const byPriority = pickables.createPickableRegistry();
  pickables.applyPickableBlock(
    byPriority,
    "a",
    pickableBlock({ grabPx: 20, priority: 1, tags: { n: "a" } }),
    a.mapper,
  );
  pickables.applyPickableBlock(
    byPriority,
    "b",
    pickableBlock({ grabPx: 20, priority: 5, tags: { n: "b" } }),
    b.mapper,
  );
  const priorityHit = pickables.pickAt(byPriority, 400, 200, opts);
  assert.equal(priorityHit.nodeId, "b");
  assert.deepEqual(priorityHit.tags, { n: "b" });

  // Equal priority + equal distance -> earlier declared (registry order) wins.
  const byOrder = pickables.createPickableRegistry();
  pickables.applyPickableBlock(
    byOrder,
    "a",
    pickableBlock({ grabPx: 20, priority: 0, tags: { n: "a" } }),
    a.mapper,
  );
  pickables.applyPickableBlock(
    byOrder,
    "b",
    pickableBlock({ grabPx: 20, priority: 0, tags: { n: "b" } }),
    b.mapper,
  );
  const orderHit = pickables.pickAt(byOrder, 400, 200, opts);
  assert.equal(orderHit.nodeId, "a");
});

test("pickAt rejects points behind the camera", async () => {
  const pickables = await loadPickables();
  const vtk = await loadVtk();

  const { mapper } = buildMapper(vtk, [0, 0, -1]);
  const instances = new Map([["m", mapper]]);
  const ctx = contextFor(instances);

  const registry = pickables.createPickableRegistry();
  pickables.applyPickableBlock(
    registry,
    "m",
    pickableBlock({ grabPx: 1000 }),
    mapper,
  );

  // worldToClip with w = z: the point at z = -1 is behind the camera.
  const behind = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0];
  const view = makeContext(behind);
  const hit = pickables.pickAt(registry, 400, 200, {
    renderer: view.renderer,
    renderWindow: view.renderWindow,
    synchronizerContext: ctx,
  });
  assert.equal(hit, null);
});

test("pointId stays aligned to point order after a point update", async () => {
  const pickables = await loadPickables();
  const vtk = await loadVtk();

  // Two points: index 0 at CSS (200, 200), index 1 at CSS (600, 200).
  const { mapper, pts, poly } = buildMapper(vtk, [-0.5, 0, 0, 0.5, 0, 0]);
  const instances = new Map([["m", mapper]]);
  const ctx = contextFor(instances);

  const registry = pickables.createPickableRegistry();
  pickables.applyPickableBlock(
    registry,
    "m",
    pickableBlock({ ids: ["id0", "id1"], grabPx: 30 }),
    mapper,
  );

  const view = makeContext();
  const opts = {
    renderer: view.renderer,
    renderWindow: view.renderWindow,
    synchronizerContext: ctx,
  };

  const before = pickables.pickAt(registry, 600, 200, opts);
  assert.equal(before.pointIndex, 1);
  assert.equal(before.pointId, "id1");

  // Simulate a partial point update: move index 1 to world (0, 0.5, 0) ->
  // CSS (400, 100). ids are keyed by point order, so alignment must hold.
  pts.setData(new Float32Array([-0.5, 0, 0, 0, 0.5, 0]), 3);
  pts.modified();
  poly.modified();

  const after = pickables.pickAt(registry, 400, 100, opts);
  assert.equal(after.pointIndex, 1);
  assert.equal(after.pointId, "id1");
});

test("re-tagging via a block update reaches pickAt", async () => {
  const pickables = await loadPickables();
  const vtk = await loadVtk();

  const { mapper } = buildMapper(vtk, [0, 0, 0]);
  const instances = new Map([["m", mapper]]);
  const ctx = contextFor(instances);
  const view = makeContext();
  const opts = {
    renderer: view.renderer,
    renderWindow: view.renderWindow,
    synchronizerContext: ctx,
  };

  const registry = pickables.createPickableRegistry();
  pickables.applyPickableBlock(
    registry,
    "m",
    pickableBlock({ grabPx: 20, tags: { rev: 1 } }),
    mapper,
  );
  assert.equal(pickables.pickAt(registry, 400, 200, opts).tags.rev, 1);

  pickables.applyPickableBlock(
    registry,
    "m",
    pickableBlock({ grabPx: 20, tags: { rev: 2 } }),
    mapper,
  );
  assert.equal(pickables.pickAt(registry, 400, 200, opts).tags.rev, 2);
});

test("a null or invalid pickable block drops the entry", async () => {
  const pickables = await loadPickables();
  const vtk = await loadVtk();

  const { mapper } = buildMapper(vtk, [0, 0, 0]);

  const registry = pickables.createPickableRegistry();
  pickables.applyPickableBlock(
    registry,
    "m",
    pickableBlock({ grabPx: 20 }),
    mapper,
  );
  assert.equal(registry.size, 1);

  // Block removed (key left the node) -> handler receives null.
  pickables.applyPickableBlock(registry, "m", null, mapper);
  assert.equal(registry.size, 0);

  // Non-positive grab radius -> dropped.
  pickables.applyPickableBlock(
    registry,
    "m",
    pickableBlock({ grabPx: 0 }),
    mapper,
  );
  assert.equal(registry.size, 0);
});

test("pickAt drops entries whose mapper instance was deleted", async () => {
  const pickables = await loadPickables();
  const vtk = await loadVtk();

  const { mapper } = buildMapper(vtk, [0, 0, 0]);
  const instances = new Map([["m", mapper]]);
  const ctx = contextFor(instances);

  const registry = pickables.createPickableRegistry();
  pickables.applyPickableBlock(
    registry,
    "m",
    pickableBlock({ grabPx: 20 }),
    mapper,
  );
  assert.equal(registry.size, 1);

  mapper.delete();

  const view = makeContext();
  const hit = pickables.pickAt(registry, 400, 200, {
    renderer: view.renderer,
    renderWindow: view.renderWindow,
    synchronizerContext: ctx,
  });
  assert.equal(hit, null);
  assert.equal(registry.size, 0);
});

test("pickAt reuses projected positions until points or camera change", async () => {
  const pickables = await loadPickables();
  const vtk = await loadVtk();
  const { mapper } = buildMapper(vtk, [0, 0, 0, 0.5, 0, 0]);
  const registry = pickables.createPickableRegistry();
  pickables.applyPickableBlock(
    registry,
    "m",
    pickableBlock({ grabPx: 30 }),
    mapper,
  );
  let matrix = IDENTITY;
  const renderer = {
    getActiveCamera: () => ({
      getCompositeProjectionMatrix: () => transposeMatrix(matrix),
    }),
    getViewport: () => [0, 0, 1, 1],
  };
  const options = {
    renderer,
    renderWindow: { getViews: () => [{ getSize: () => [WIDTH, HEIGHT] }] },
    synchronizerContext: contextFor(new Map([["m", mapper]])),
  };

  pickables.pickAt(registry, 400, 200, options);
  const firstCache = registry.get("m").projectionCache;
  pickables.pickAt(registry, 400, 200, options);
  assert.equal(registry.get("m").projectionCache, firstCache);

  matrix = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  pickables.pickAt(registry, 400, 200, options);
  assert.notEqual(registry.get("m").projectionCache, firstCache);
});

test("preview metadata and bound points node id ride the pick result", async () => {
  const pickables = await loadPickables();
  const vtk = await loadVtk();
  const { mapper, poly } = buildMapper(vtk, [0, 0, 0]);
  const registry = pickables.createPickableRegistry();
  pickables.applyPickableBlock(
    registry,
    "m",
    {
      grabPx: 20,
      preview: "plane",
      plane: { origin: [0, 0, 0], normal: [0, 0, 1] },
    },
    mapper,
  );
  const view = makeContext();
  const hit = pickables.pickAt(registry, 400, 200, {
    renderer: view.renderer,
    renderWindow: view.renderWindow,
    synchronizerContext: {
      getInstance: () => mapper,
      getInstanceId: (instance) => (instance === poly ? "poly" : null),
    },
  });

  assert.equal(hit.preview, "plane");
  assert.equal(hit.pointsNodeId, "poly");
  // The pick names every node its screen position was measured through, so the
  // server validates the client's own dependency list rather than a fixed pair.
  assert.deepEqual(hit.nodes, [String(hit.nodeId), "poly"]);
  assert.deepEqual(hit.plane, { origin: [0, 0, 0], normal: [0, 0, 1] });
});

test("cloud preview metadata rides the pick result", async () => {
  const pickables = await loadPickables();
  const vtk = await loadVtk();
  const { mapper } = buildMapper(vtk, [0, 0, 0]);
  const registry = pickables.createPickableRegistry();
  pickables.applyPickableBlock(
    registry,
    "m",
    { grabPx: 20, preview: "cloud" },
    mapper,
  );
  const view = makeContext();
  const hit = pickables.pickAt(registry, 400, 200, {
    renderer: view.renderer,
    renderWindow: view.renderWindow,
    synchronizerContext: contextFor(new Map([["m", mapper]])),
  });

  assert.equal(hit.preview, "cloud");
});

test("a pick whose input point set cannot be resolved names no nodes", async () => {
  const pickables = await loadPickables();
  const vtk = await loadVtk();
  const { mapper } = buildMapper(vtk, [0, 0, 0]);
  const registry = pickables.createPickableRegistry();
  pickables.applyPickableBlock(registry, "m", { grabPx: 20 }, mapper);
  const view = makeContext();
  const hit = pickables.pickAt(registry, 400, 200, {
    renderer: view.renderer,
    renderWindow: view.renderWindow,
    synchronizerContext: {
      getInstance: () => mapper,
      // The store cannot name the mapper's input, so currency is unknowable.
      getInstanceId: () => null,
    },
  });

  assert.equal(hit.pointsNodeId, null);
  assert.equal(
    hit.nodes,
    null,
    "unknown dependencies read as stale downstream",
  );
});
