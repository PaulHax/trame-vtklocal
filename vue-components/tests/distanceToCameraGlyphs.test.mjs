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

function perspective(fovy, aspect, near, far) {
  const matrix = new Array(16).fill(0);
  const f = 1.0 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  matrix[0] = f / aspect;
  matrix[5] = f;
  matrix[10] = (far + near) * nf;
  matrix[11] = -1;
  matrix[14] = 2 * far * near * nf;
  return matrix;
}

function multiplyMatrix(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let k = 0; k < 4; k += 1) {
        out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
      }
    }
  }
  return out;
}

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

function lockViewportProjection(projection, { zoom, pan }) {
  return multiplyMatrix(
    [
      zoom,
      0,
      0,
      0,
      0,
      zoom,
      0,
      0,
      0,
      0,
      1,
      0,
      pan[0],
      pan[1],
      0,
      1,
    ],
    projection,
  );
}

async function withDevicePixelRatio(ratio, run) {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      ...(previousWindow || {}),
      devicePixelRatio: ratio,
    },
  });

  try {
    return await run();
  } finally {
    if (hadWindow) {
      globalThis.window = previousWindow;
    } else {
      delete globalThis.window;
    }
  }
}

test("computeDistanceToCameraScales matches a standard perspective matrix", async () => {
  const { computeDistanceToCameraScales } = await loadModule(
    "/src/components/distanceToCameraGlyphs.js",
  );

  const projection = perspective(Math.PI / 2, 2, 1, 100);

  const scales = computeDistanceToCameraScales(
    new Float32Array([0, 0, -10, 0, 0, -20]),
    projection,
    800,
    400,
    40,
  );

  assertAlmostEqual(scales[0], 2);
  assertAlmostEqual(scales[1], 4);
});

test("computeDistanceToCameraScales keeps pixel extent stable across zoom", async () => {
  const { computeDistanceToCameraScales } = await loadModule(
    "/src/components/distanceToCameraGlyphs.js",
  );

  const baseProjection = perspective(Math.PI / 2, 2, 1, 100);
  const zoomProjection = baseProjection.slice();
  zoomProjection[0] *= 3;
  zoomProjection[5] *= 3;

  const baseScales = computeDistanceToCameraScales(
    new Float32Array([0, 0, -10]),
    baseProjection,
    800,
    400,
    40,
  );
  const zoomScales = computeDistanceToCameraScales(
    new Float32Array([0, 0, -10]),
    zoomProjection,
    800,
    400,
    40,
  );

  assertAlmostEqual(zoomScales[0] * 3, baseScales[0]);
});

test("computeDistanceToCameraScales uses matrix anisotropy instead of view angle", async () => {
  const { computeDistanceToCameraScales } = await loadModule(
    "/src/components/distanceToCameraGlyphs.js",
  );

  const projection = perspective(Math.PI / 2, 2, 1, 100);
  projection[0] *= 4;

  const scales = computeDistanceToCameraScales(
    new Float32Array([0, 0, -10]),
    projection,
    800,
    400,
    40,
  );

  assertAlmostEqual(scales[0], 0.5);
});

test("computeDistanceToCameraScales clamps degenerate projections", async () => {
  const { computeDistanceToCameraScales } = await loadModule(
    "/src/components/distanceToCameraGlyphs.js",
  );

  const scales = computeDistanceToCameraScales(
    new Float32Array([0, 0, 0]),
    new Array(16).fill(0),
    800,
    400,
    40,
  );

  assert.equal(scales[0], 600);
});

test("distance-to-camera registry sizes the recorded filter input without server output", async () => {
  const [
    distanceToCameraGlyphs,
    vtkGlyph3DMapperMod,
    vtkPolyDataMod,
    vtkPointsMod,
  ] = await Promise.all([
    loadModule("/src/components/distanceToCameraGlyphs.js"),
    loadModule("/node_modules/@kitware/vtk.js/Rendering/Core/Glyph3DMapper.js"),
    loadModule("/node_modules/@kitware/vtk.js/Common/DataModel/PolyData.js"),
    loadModule("/node_modules/@kitware/vtk.js/Common/Core/Points.js"),
  ]);

  const mapper = vtkGlyph3DMapperMod.default.newInstance();
  const serverOutput = vtkPolyDataMod.default.newInstance();
  mapper.setInputData(serverOutput);

  const filterInput = vtkPolyDataMod.default.newInstance();
  const points = vtkPointsMod.default.newInstance();
  points.setData(new Float32Array([0, 0, 0]), 3);
  filterInput.setPoints(points);

  const instances = new Map([
    ["mapper", mapper],
    ["filter-input", filterInput],
  ]);
  const synchronizerContext = {
    getInstance: (id) => instances.get(String(id)),
  };

  const registry = distanceToCameraGlyphs.createDistanceToCameraGlyphRegistry();
  distanceToCameraGlyphs.applyDistanceToCameraBlock(
    registry,
    "mapper",
    {
      arrayName: "DistanceToCamera",
      screenSize: 40,
      inputDataObjectId: "filter-input",
    },
    mapper,
    synchronizerContext,
  );
  assert.equal(mapper.getInputData(0), filterInput);

  const camera = {
    getMTime: () => 1,
    getPhysicalScale: () => 1,
    getCompositeProjectionMatrix: () => {
      const matrix = new Array(16).fill(0);
      matrix[0] = 1;
      matrix[5] = 1;
      matrix[10] = 1;
      matrix[15] = 1;
      return matrix;
    },
  };
  const renderer = {
    getActiveCamera: () => camera,
    getViewport: () => [0, 0, 1, 1],
  };
  const renderWindow = {
    getViews: () => [{ getSize: () => [1600, 800] }],
  };

  await withDevicePixelRatio(2, async () => {
    assert.equal(
      distanceToCameraGlyphs.updateDistanceToCameraGlyphs(registry, {
        renderer,
        renderWindow,
        synchronizerContext,
      }),
      true,
    );

    assert.equal(
      distanceToCameraGlyphs.updateDistanceToCameraGlyphs(registry, {
        renderer,
        renderWindow,
        synchronizerContext,
      }),
      false,
    );
  });
  assert.equal(mapper.getScaleArray(), "DistanceToCamera");

  const array = filterInput.getPointData().getArray("DistanceToCamera");
  assert.ok(array);
  assert.equal(filterInput.getPointData().getScalars(), array);
  assertAlmostEqual(array.getData()[0], 0.1);
  assert.ok(!serverOutput.getPointData().getArray("DistanceToCamera"));
});

test("distance-to-camera registry caps degenerate scales at the point-set extent", async () => {
  const [
    distanceToCameraGlyphs,
    vtkGlyph3DMapperMod,
    vtkPolyDataMod,
    vtkPointsMod,
  ] = await Promise.all([
    loadModule("/src/components/distanceToCameraGlyphs.js"),
    loadModule("/node_modules/@kitware/vtk.js/Rendering/Core/Glyph3DMapper.js"),
    loadModule("/node_modules/@kitware/vtk.js/Common/DataModel/PolyData.js"),
    loadModule("/node_modules/@kitware/vtk.js/Common/Core/Points.js"),
  ]);

  const mapper = vtkGlyph3DMapperMod.default.newInstance();
  const filterInput = vtkPolyDataMod.default.newInstance();
  const points = vtkPointsMod.default.newInstance();
  // Extent 3x4x0 -> bounding-box diagonal 5. A degenerate projection must clamp
  // to this scene-proportional value, not the 600 world-unit fallback.
  points.setData(new Float32Array([0, 0, 0, 3, 4, 0]), 3);
  filterInput.setPoints(points);
  mapper.setInputData(filterInput);

  const instances = new Map([
    ["mapper", mapper],
    ["filter-input", filterInput],
  ]);
  const synchronizerContext = {
    getInstance: (id) => instances.get(String(id)),
  };

  const registry = distanceToCameraGlyphs.createDistanceToCameraGlyphRegistry();
  distanceToCameraGlyphs.applyDistanceToCameraBlock(
    registry,
    "mapper",
    {
      arrayName: "DistanceToCamera",
      screenSize: 40,
      inputDataObjectId: "filter-input",
    },
    mapper,
    synchronizerContext,
  );

  const camera = {
    getMTime: () => 1,
    getPhysicalScale: () => 1,
    // All-zero composite -> every point projects to one pixel -> pixels-per-world
    // is 0, so the cap binds for every glyph.
    getCompositeProjectionMatrix: () => new Array(16).fill(0),
  };
  const renderer = {
    getActiveCamera: () => camera,
    getViewport: () => [0, 0, 1, 1],
  };
  const renderWindow = {
    getViews: () => [{ getSize: () => [800, 400] }],
  };

  assert.equal(
    distanceToCameraGlyphs.updateDistanceToCameraGlyphs(registry, {
      renderer,
      renderWindow,
      synchronizerContext,
    }),
    true,
  );

  const scales = filterInput
    .getPointData()
    .getArray("DistanceToCamera")
    .getData();
  assertAlmostEqual(scales[0], 5);
  assertAlmostEqual(scales[1], 5);
});

test("distance-to-camera registry honors lock-style projection zoom", async () => {
  const [
    distanceToCameraGlyphs,
    vtkGlyph3DMapperMod,
    vtkPolyDataMod,
    vtkPointsMod,
  ] = await Promise.all([
    loadModule("/src/components/distanceToCameraGlyphs.js"),
    loadModule("/node_modules/@kitware/vtk.js/Rendering/Core/Glyph3DMapper.js"),
    loadModule("/node_modules/@kitware/vtk.js/Common/DataModel/PolyData.js"),
    loadModule("/node_modules/@kitware/vtk.js/Common/Core/Points.js"),
  ]);

  const mapper = vtkGlyph3DMapperMod.default.newInstance();
  const filterInput = vtkPolyDataMod.default.newInstance();
  const points = vtkPointsMod.default.newInstance();
  points.setData(new Float32Array([0, 0, -10]), 3);
  filterInput.setPoints(points);

  const instances = new Map([
    ["mapper", mapper],
    ["filter-input", filterInput],
  ]);
  const synchronizerContext = {
    getInstance: (id) => instances.get(String(id)),
  };

  const registry = distanceToCameraGlyphs.createDistanceToCameraGlyphRegistry();
  distanceToCameraGlyphs.applyDistanceToCameraBlock(
    registry,
    "mapper",
    {
      arrayName: "DistanceToCamera",
      screenSize: 40,
      inputDataObjectId: "filter-input",
    },
    mapper,
    synchronizerContext,
  );

  const zoom = 1.75;
  const projection = lockViewportProjection(
    perspective(Math.PI / 2, 2, 1, 100),
    { zoom, pan: [0.22, -0.14] },
  );
  const camera = {
    getMTime: () => 1,
    getPhysicalScale: () => 1,
    getCompositeProjectionMatrix: () => transposeMatrix(projection),
  };
  const renderer = {
    getActiveCamera: () => camera,
    getViewport: () => [0, 0, 1, 1],
  };
  const renderWindow = {
    getViews: () => [{ getSize: () => [800, 400] }],
  };

  assert.equal(
    distanceToCameraGlyphs.updateDistanceToCameraGlyphs(registry, {
      renderer,
      renderWindow,
      synchronizerContext,
    }),
    true,
  );

  const array = filterInput.getPointData().getArray("DistanceToCamera");
  assert.ok(array);
  assertAlmostEqual(array.getData()[0], 40 / (20 * zoom));
});

test("distance-to-camera registry resolves pending mapper state during render", async () => {
  const [
    distanceToCameraGlyphs,
    vtkGlyph3DMapperMod,
    vtkPolyDataMod,
    vtkPointsMod,
  ] = await Promise.all([
    loadModule("/src/components/distanceToCameraGlyphs.js"),
    loadModule("/node_modules/@kitware/vtk.js/Rendering/Core/Glyph3DMapper.js"),
    loadModule("/node_modules/@kitware/vtk.js/Common/DataModel/PolyData.js"),
    loadModule("/node_modules/@kitware/vtk.js/Common/Core/Points.js"),
  ]);

  const instances = new Map();
  const synchronizerContext = {
    getInstance: (id) => instances.get(String(id)),
  };
  const registry = distanceToCameraGlyphs.createDistanceToCameraGlyphRegistry();

  // The block can arrive before the input dataset instance resolves — the
  // entry stays pending and resolves during the render-time update.
  distanceToCameraGlyphs.applyDistanceToCameraBlock(
    registry,
    "mapper",
    {
      arrayName: "DistanceToCamera",
      screenSize: 20,
      inputDataObjectId: "filter-input",
    },
    null,
    synchronizerContext,
  );

  assert.equal(registry.get("mapper")?.pending, true);

  const mapper = vtkGlyph3DMapperMod.default.newInstance();
  const filterInput = vtkPolyDataMod.default.newInstance();
  const points = vtkPointsMod.default.newInstance();
  points.setData(new Float32Array([0, 0, 0]), 3);
  filterInput.setPoints(points);
  instances.set("mapper", mapper);
  instances.set("filter-input", filterInput);

  const camera = {
    getMTime: () => 1,
    getPhysicalScale: () => 1,
    getCompositeProjectionMatrix: () => {
      const matrix = new Array(16).fill(0);
      matrix[0] = 1;
      matrix[5] = 1;
      matrix[10] = 1;
      matrix[15] = 1;
      return matrix;
    },
  };
  const renderer = {
    getActiveCamera: () => camera,
    getViewport: () => [0, 0, 1, 1],
  };
  const renderWindow = {
    getViews: () => [{ getSize: () => [1000, 500] }],
  };

  assert.equal(
    distanceToCameraGlyphs.updateDistanceToCameraGlyphs(registry, {
      renderer,
      renderWindow,
      synchronizerContext,
    }),
    true,
  );

  const entry = registry.get("mapper");
  assert.equal(entry?.pending, false);
  assert.equal(entry?.mapper, mapper);
  assert.equal(entry?.input, filterInput);
  assert.equal(mapper.getInputData(0), filterInput);
  assert.equal(mapper.getScaleArray(), "DistanceToCamera");

  const array = filterInput.getPointData().getArray("DistanceToCamera");
  assert.ok(array);
  assert.equal(filterInput.getPointData().getScalars(), array);
});

test("distance-to-camera render hooks run during callback render paths", async () => {
  const {
    bindDistanceToCameraInteractorRenderEvent,
    createDistanceToCameraRenderCallback,
  } = await loadModule("/src/components/distanceToCameraGlyphs.js");

  const order = [];
  const callback = createDistanceToCameraRenderCallback(
    () => order.push("update-callback"),
    () => order.push("render-callback"),
  );
  callback();
  assert.deepEqual(order, ["update-callback", "render-callback"]);

  let renderEvent = null;
  let unsubscribed = false;
  const interactorSubscription = {
    unsubscribe: () => {
      unsubscribed = true;
    },
  };
  const interactor = {
    onRenderEvent(handler) {
      renderEvent = handler;
      return interactorSubscription;
    },
  };
  assert.equal(
    bindDistanceToCameraInteractorRenderEvent(interactor, () =>
      order.push("update-interactor"),
    ),
    interactorSubscription,
  );
  renderEvent();
  interactorSubscription.unsubscribe();
  assert.equal(unsubscribed, true);

  assert.deepEqual(order, [
    "update-callback",
    "render-callback",
    "update-interactor",
  ]);
});
