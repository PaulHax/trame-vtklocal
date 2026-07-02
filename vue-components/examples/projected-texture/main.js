// Visual gate for vtkProjectedTextureMapper: two quads placed at geo-scale
// coordinates (so vtk.js CoordShiftAndScale rebases the VBOs), one textured
// through a keystoned ground homography, one through a world-to-clip
// projector matrix. A live clock redraws onto the source canvas twice a
// second to exercise the per-frame re-upload path.
import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import vtkFullScreenRenderWindow from "@kitware/vtk.js/Rendering/Misc/FullScreenRenderWindow";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";

import projectedTexture, {
  ProjectedTextureMode,
} from "../../src/components/projectedTextureMapper.js";
import { getExternalTextures } from "../../src/components/externalTextures.js";

// Geo-scale placement: far from the origin relative to its size, which makes
// the CABO enable shift/scale rebasing (vertexMC != world coordinates).
const QUAD_W = 100;
const QUAD_H = 75;
const LEFT_X0 = 450000;
const RIGHT_X0 = LEFT_X0 + QUAD_W + 20;
const Y0 = 5600000;

function makeQuad(x0, y0, width, height) {
  const polydata = vtkPolyData.newInstance();
  polydata
    .getPoints()
    .setData(
      Float64Array.of(
        x0,
        y0,
        0,
        x0 + width,
        y0,
        0,
        x0 + width,
        y0 + height,
        0,
        x0,
        y0 + height,
        0,
      ),
      3,
    );
  polydata.getPolys().setData(Uint32Array.of(4, 0, 1, 2, 3));
  return polydata;
}

// Column-major mat3 mapping world (x, y, 1) -> texture (u*w, v*w, w) with a
// keystone term in w, so sampling is genuinely projective: the image
// footprint on the quad is a trapezoid and fragments past v=1 discard (a
// wedge at the bottom-left), like a real sensor footprint. Written in world
// coordinates: the intermediate coefficients are large and would be destroyed
// by float32 uniforms — the mapper's internal shift/scale fold is what makes
// this work on the GPU.
function groundHomography(x0, y0, width, height, keystone = 0.5) {
  const g = 1 + keystone;
  return [
    g / width,
    0,
    keystone / width,
    0,
    -g / height,
    0,
    (-g * x0) / width,
    (g * (y0 + height)) / height,
    1 - (keystone * x0) / width,
  ];
}

// Column-major mat4 of a virtual nadir orthographic projector whose image
// exactly covers the quad: clip.xy in [-1, 1] across it, w = 1.
function projectorWorldToClip(x0, y0, width, height) {
  const matrix = new Array(16).fill(0);
  matrix[0] = 2 / width;
  matrix[5] = 2 / height;
  matrix[10] = 1;
  matrix[12] = (-2 * x0) / width - 1;
  matrix[13] = (-2 * y0) / height - 1;
  matrix[15] = 1;
  return matrix;
}

function createSourceCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 384;
  return canvas;
}

function drawSource(canvas) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#204060");
  gradient.addColorStop(1, "#60a080");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, width - 8, height - 8);

  ctx.font = "bold 40px monospace";
  ctx.fillStyle = "#ffdd44";
  ctx.textAlign = "center";
  ctx.fillText("PROJECTED", width / 2, height / 2 - 30);
  ctx.fillText("TEXTURE", width / 2, height / 2 + 20);
  ctx.font = "bold 28px monospace";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(new Date().toLocaleTimeString(), width / 2, height / 2 + 70);

  // Corner labels prove orientation (TL must render top-left on both quads).
  ctx.textAlign = "left";
  ctx.fillStyle = "#ff5555";
  ctx.fillText("TL", 16, 42);
  ctx.textAlign = "right";
  ctx.fillStyle = "#55ff55";
  ctx.fillText("TR", width - 16, 42);
  ctx.textAlign = "left";
  ctx.fillStyle = "#5599ff";
  ctx.fillText("BL", 16, height - 20);
  ctx.textAlign = "right";
  ctx.fillStyle = "#ff55ff";
  ctx.fillText("BR", width - 16, height - 20);
}

const fullScreenRenderer = vtkFullScreenRenderWindow.newInstance({
  background: [0.1, 0.1, 0.12],
});
const renderer = fullScreenRenderer.getRenderer();
const renderWindow = fullScreenRenderer.getRenderWindow();

function addQuad(polydata, configureMapper) {
  const mapper = projectedTexture.newInstance({ textureKey: "demo" });
  configureMapper(mapper);
  mapper.setInputData(polydata);
  const actor = vtkActor.newInstance();
  actor.getProperty().setAmbient(1);
  actor.getProperty().setDiffuse(0);
  actor.setMapper(mapper);
  renderer.addActor(actor);
  return mapper;
}

// Left: homography drape via the homography prop (a field-data array named by
// homographyArrayName also works), keystoned to prove the projective divide.
const leftQuad = makeQuad(LEFT_X0, Y0, QUAD_W, QUAD_H);
addQuad(leftQuad, (mapper) => {
  mapper.setMode(ProjectedTextureMode.HOMOGRAPHY);
  mapper.setHomography(groundHomography(LEFT_X0, Y0, QUAD_W, QUAD_H));
});

// Right: world-to-clip projection through a per-render provider.
const rightQuad = makeQuad(RIGHT_X0, Y0, QUAD_W, QUAD_H);
const rightWorldToClip = projectorWorldToClip(RIGHT_X0, Y0, QUAD_W, QUAD_H);
addQuad(rightQuad, (mapper) => {
  mapper.setMode(ProjectedTextureMode.WORLD_TO_CLIP);
  mapper.setWorldToClipProvider(() => rightWorldToClip);
});

const sourceCanvas = createSourceCanvas();
const textures = getExternalTextures(renderWindow);

function updateTexture() {
  drawSource(sourceCanvas);
  textures.setSource("demo", sourceCanvas);
  renderWindow.render();
}

updateTexture();
renderer.resetCamera();
renderWindow.render();
setInterval(updateTexture, 500);

// Handy for console poking.
globalThis.projectedTextureExample = {
  renderer,
  renderWindow,
  textures,
  updateTexture,
};
