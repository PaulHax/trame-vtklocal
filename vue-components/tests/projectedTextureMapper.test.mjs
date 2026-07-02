import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

async function loadMapperModule() {
  return loadModule("/src/components/projectedTextureMapper.js");
}

function assertAlmostEqual(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

test("renderable defaults and class hierarchy", async () => {
  const { newInstance, ProjectedTextureMode } = await loadMapperModule();
  const mapper = newInstance();

  assert.ok(mapper.isA("vtkProjectedTextureMapper"));
  assert.ok(mapper.isA("vtkMapper"));
  assert.equal(mapper.getClassName(), "vtkProjectedTextureMapper");
  assert.equal(mapper.getTextureKey(), null);
  assert.equal(mapper.getMode(), ProjectedTextureMode.HOMOGRAPHY);
  assert.equal(mapper.getHomography(), null);
  assert.equal(mapper.getHomographyArrayName(), "HomographyInverse");
  assert.equal(mapper.getWorldToClip(), null);
});

test("mode change bumps MTime so shaders rebuild", async () => {
  const { newInstance, ProjectedTextureMode } = await loadMapperModule();
  const mapper = newInstance();

  const before = mapper.getMTime();
  mapper.setMode(ProjectedTextureMode.WORLD_TO_CLIP);
  assert.ok(mapper.getMTime() > before);
});

test("homography resolution: prop wins, field data is the fallback", async () => {
  const { newInstance } = await loadMapperModule();
  const { default: vtkPolyData } = await loadModule(
    "/node_modules/@kitware/vtk.js/Common/DataModel/PolyData.js",
  );
  const { default: vtkDataArray } = await loadModule(
    "/node_modules/@kitware/vtk.js/Common/Core/DataArray.js",
  );

  const mapper = newInstance();
  assert.equal(mapper.getResolvedHomography(), null);

  const fieldValues = new Float32Array([1, 0, 0, 0, 1, 0, 0.5, 0.25, 1]);
  const polydata = vtkPolyData.newInstance();
  polydata.getFieldData().addArray(
    vtkDataArray.newInstance({
      name: "HomographyInverse",
      numberOfComponents: 1,
      values: fieldValues,
    }),
  );
  mapper.setInputData(polydata, 0);
  assert.equal(mapper.getResolvedHomography(), fieldValues);

  const propValues = [2, 0, 0, 0, 2, 0, 0, 0, 1];
  mapper.setHomography(propValues);
  assert.equal(mapper.getResolvedHomography(), propValues);

  mapper.setHomography(null);
  mapper.setHomographyArrayName("SomethingElse");
  assert.equal(mapper.getResolvedHomography(), null);
});

test("world-to-clip resolution: provider wins over prop", async () => {
  const { newInstance, ProjectedTextureMode } = await loadMapperModule();
  const mapper = newInstance({ mode: ProjectedTextureMode.WORLD_TO_CLIP });

  assert.equal(mapper.getResolvedWorldToClip(), null);

  const propMatrix = new Array(16).fill(0);
  propMatrix[0] = 1;
  mapper.setWorldToClip(propMatrix);
  assert.equal(mapper.getResolvedWorldToClip(), propMatrix);

  const providedMatrix = new Float32Array(16);
  providedMatrix[5] = 1;
  mapper.setWorldToClipProvider(() => providedMatrix);
  assert.equal(mapper.getResolvedWorldToClip(), providedMatrix);

  // Provider returning garbage falls back to the prop.
  mapper.setWorldToClipProvider(() => [1, 2, 3]);
  assert.equal(mapper.getResolvedWorldToClip(), propMatrix);
});

test("shader replacements consume the TCoord markers in the real templates", async () => {
  const { applyProjectedTextureShaderReplacements, ProjectedTextureMode } =
    await loadMapperModule();
  const { default: vtkPolyDataVS } = await loadModule(
    "/node_modules/@kitware/vtk.js/Rendering/OpenGL/glsl/vtkPolyDataVS.glsl.js",
  );
  const { default: vtkPolyDataFS } = await loadModule(
    "/node_modules/@kitware/vtk.js/Rendering/OpenGL/glsl/vtkPolyDataFS.glsl.js",
  );

  for (const [mode, expectations] of [
    [
      ProjectedTextureMode.HOMOGRAPHY,
      ["uProjTexHomographyInv", "vProjTexModelXY", "uProjTex"],
    ],
    [
      ProjectedTextureMode.WORLD_TO_CLIP,
      [
        "uProjTexWorldToClip",
        "uProjTexCoordShift",
        "uProjTexCoordScale",
        "vProjTexModelXYZ",
        "uProjTex",
      ],
    ],
  ]) {
    const shaders = {
      Vertex: vtkPolyDataVS,
      Fragment: vtkPolyDataFS,
      Geometry: "",
    };
    assert.ok(shaders.Vertex.includes("//VTK::TCoord::Dec"));
    assert.ok(shaders.Fragment.includes("//VTK::TCoord::Impl"));

    applyProjectedTextureShaderReplacements(shaders, mode);

    assert.ok(!shaders.Vertex.includes("//VTK::TCoord::Dec"), mode);
    assert.ok(!shaders.Vertex.includes("//VTK::TCoord::Impl"), mode);
    assert.ok(!shaders.Fragment.includes("//VTK::TCoord::Dec"), mode);
    assert.ok(!shaders.Fragment.includes("//VTK::TCoord::Impl"), mode);
    for (const symbol of expectations) {
      assert.ok(shaders.Fragment.includes(symbol), `${mode}: ${symbol}`);
    }
  }

  const untouched = {
    Vertex: "//VTK::TCoord::Dec",
    Fragment: "",
    Geometry: "",
  };
  applyProjectedTextureShaderReplacements(untouched, "bogusMode");
  assert.equal(untouched.Vertex, "//VTK::TCoord::Dec");
});

test("homography shift/scale fold matches the unrebased projection", async () => {
  const { foldHomographyCoordShiftScale } = await loadMapperModule();

  // A full projective homography (non-trivial bottom row) and a geo-scale
  // rebase, checked against direct evaluation in world coordinates.
  const h = [1.5, 0.2, 0.0003, -0.4, 2.1, 0.0001, 120, -45, 1];
  const shift = [450000, 5600000, 0];
  const scale = [0.001, 0.002, 1];

  const folded = foldHomographyCoordShiftScale(h, shift, scale);

  const apply = (m, x, y) => {
    const u = m[0] * x + m[3] * y + m[6];
    const v = m[1] * x + m[4] * y + m[7];
    const w = m[2] * x + m[5] * y + m[8];
    return [u / w, v / w];
  };

  for (const [worldX, worldY] of [
    [450010, 5600020],
    [449950.5, 5599990.25],
    [450123.75, 5600200],
  ]) {
    const rebasedX = (worldX - shift[0]) * scale[0];
    const rebasedY = (worldY - shift[1]) * scale[1];
    const expected = apply(h, worldX, worldY);
    const actual = apply(folded, rebasedX, rebasedY);
    assertAlmostEqual(actual[0], expected[0], 1e-6);
    assertAlmostEqual(actual[1], expected[1], 1e-6);
  }
});

test("importing the module registers both instantiation paths", async () => {
  await loadMapperModule();
  const { default: vtkObjectManager } = await loadModule(
    "/node_modules/@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/ObjectManager.js",
  );
  const { newInstance: newFactory } = await loadModule(
    "/node_modules/@kitware/vtk.js/Rendering/OpenGL/ViewNodeFactory.js",
  );

  // State-sync side: serialized nodes of this type build the renderable and
  // the generic updater applies its props.
  assert.ok(
    vtkObjectManager.getSupportedTypes().includes("vtkProjectedTextureMapper"),
  );
  const built = vtkObjectManager.build("vtkProjectedTextureMapper", {});
  assert.ok(built.isA("vtkProjectedTextureMapper"));

  const context = {
    start() {},
    end() {},
    getInstance() {
      return null;
    },
    registerInstance() {},
  };
  vtkObjectManager.update(
    "vtkProjectedTextureMapper",
    built,
    {
      properties: {
        textureKey: "video",
        mode: "worldToClip",
        homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      },
    },
    context,
  );
  assert.equal(built.getTextureKey(), "video");
  assert.equal(built.getMode(), "worldToClip");
  assert.deepEqual(built.getHomography(), [1, 0, 0, 0, 1, 0, 0, 0, 1]);

  // Scene-graph side: the factory resolves the renderable to the OpenGL
  // subclass through the registered override.
  const factory = newFactory();
  const node = factory.createNode(built);
  assert.ok(node.isA("vtkOpenGLProjectedTextureMapper"));
  assert.ok(node.isA("vtkOpenGLPolyDataMapper"));
});
