// vtkProjectedTextureMapper: a vtkMapper whose fragment shader generates
// texture coordinates by pushing positions through a projective matrix —
// either a ground-plane homography (mat3 on model XY) or a world-to-clip
// camera projection (mat4 on model XYZ). The projective divide must happen per
// fragment (linearly interpolated vec2 TCoords are wrong for a projective
// map), so this is genuinely a shader-level primitive.
//
// Modeled on vtk.js's in-tree vtkCutterMapper: a renderable subclass carrying
// declarative props plus a vtkOpenGLPolyDataMapper subclass overriding
// replaceShaderValues/setMapperShaderParameters, registered with
// registerOverride (scene graph). syntheticTypes.js owns its state-sync type
// mapping. Because the mapper's type and props live in serialized state, a
// full scene re-serialization rebuilds it correctly with no reapply hook.
import macro from "@kitware/vtk.js/macros";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkOpenGLPolyDataMapper from "@kitware/vtk.js/Rendering/OpenGL/PolyDataMapper";
import vtkShaderProgram from "@kitware/vtk.js/Rendering/OpenGL/ShaderProgram";
import { registerOverride } from "@kitware/vtk.js/Rendering/OpenGL/ViewNodeFactory";

import { getExternalTextures } from "./externalTextures";

const { vtkWarningMacro } = macro;

export const ProjectedTextureMode = {
  HOMOGRAPHY: "homography",
  WORLD_TO_CLIP: "worldToClip",
};

// The GLSL bodies consume the //VTK::TCoord::Dec and //VTK::TCoord::Impl
// markers (no marker preserved) so the default TCoord handling cannot
// interfere. At //VTK::TCoord::Impl in the fragment template, ambientColor,
// diffuseColor and opacity are in scope (set by //VTK::Color::Impl) and are
// consumed by //VTK::Light::Impl afterwards.
const SHADER_REPLACEMENTS = {
  [ProjectedTextureMode.HOMOGRAPHY]: {
    vertexDec: "varying vec2 vProjTexModelXY;",
    vertexImpl: "vProjTexModelXY = vertexMC.xy;",
    fragmentDec: [
      "varying vec2 vProjTexModelXY;",
      "uniform mat3 uProjTexHomographyInv;",
      "uniform sampler2D uProjTex;",
    ].join("\n"),
    fragmentImpl: [
      "vec3 projTexTC = uProjTexHomographyInv * vec3(vProjTexModelXY, 1.0);",
      "vec2 projTexCoord = projTexTC.xy / projTexTC.z;",
      "if (projTexCoord.x < 0.0 || projTexCoord.x > 1.0 || projTexCoord.y < 0.0 || projTexCoord.y > 1.0) {",
      "  discard;",
      "}",
      "vec4 projTexColor = texture2D(uProjTex, projTexCoord);",
      "ambientColor = projTexColor.rgb;",
      "diffuseColor = projTexColor.rgb;",
      "opacity *= projTexColor.a;",
    ].join("\n"),
  },
  [ProjectedTextureMode.WORLD_TO_CLIP]: {
    vertexDec: "varying vec3 vProjTexModelXYZ;",
    vertexImpl: "vProjTexModelXYZ = vertexMC.xyz;",
    fragmentDec: [
      "varying vec3 vProjTexModelXYZ;",
      "uniform mat4 uProjTexWorldToClip;",
      "uniform vec3 uProjTexCoordShift;",
      "uniform vec3 uProjTexCoordScale;",
      "uniform sampler2D uProjTex;",
    ].join("\n"),
    // Clip +y is up while texture v grows downward, hence the y flip; the
    // homography mode maps straight into texture space so it has none.
    fragmentImpl: [
      "vec3 projTexWorld = vProjTexModelXYZ / uProjTexCoordScale + uProjTexCoordShift;",
      "vec4 projTexClip = uProjTexWorldToClip * vec4(projTexWorld, 1.0);",
      "if (abs(projTexClip.w) < 1.0e-8) {",
      "  discard;",
      "}",
      "vec2 projTexRaw = (projTexClip.xy / projTexClip.w) * 0.5 + 0.5;",
      "vec2 projTexCoord = vec2(projTexRaw.x, 1.0 - projTexRaw.y);",
      "if (projTexCoord.x < 0.0 || projTexCoord.x > 1.0 || projTexCoord.y < 0.0 || projTexCoord.y > 1.0) {",
      "  discard;",
      "}",
      "vec4 projTexColor = texture2D(uProjTex, projTexCoord);",
      "ambientColor = projTexColor.rgb;",
      "diffuseColor = projTexColor.rgb;",
      "opacity *= projTexColor.a;",
    ].join("\n"),
  },
};

export function applyProjectedTextureShaderReplacements(shaders, mode) {
  const replacement = SHADER_REPLACEMENTS[mode];
  if (!replacement) {
    vtkWarningMacro(`Unknown projected-texture mode: ${mode}`);
    return shaders;
  }
  shaders.Vertex = vtkShaderProgram.substitute(
    shaders.Vertex,
    "//VTK::TCoord::Dec",
    replacement.vertexDec,
  ).result;
  shaders.Vertex = vtkShaderProgram.substitute(
    shaders.Vertex,
    "//VTK::TCoord::Impl",
    replacement.vertexImpl,
  ).result;
  shaders.Fragment = vtkShaderProgram.substitute(
    shaders.Fragment,
    "//VTK::TCoord::Dec",
    replacement.fragmentDec,
  ).result;
  shaders.Fragment = vtkShaderProgram.substitute(
    shaders.Fragment,
    "//VTK::TCoord::Impl",
    replacement.fragmentImpl,
  ).result;
  return shaders;
}

// vtk.js CoordShiftAndScale rebases VBO positions as
// vertexMC = (world - shift) * scale, with no opt-out on geo-scale
// coordinates. Fold the un-rebase into the homography so the shader math is
// exact: out = H * M where M maps rebased XY back to world XY. Column-major.
export function foldHomographyCoordShiftScale(
  h,
  shift,
  scale,
  out = new Float32Array(9),
) {
  const sx = scale[0];
  const sy = scale[1];
  const shx = shift[0];
  const shy = shift[1];
  out[0] = h[0] / sx;
  out[1] = h[1] / sx;
  out[2] = h[2] / sx;
  out[3] = h[3] / sy;
  out[4] = h[4] / sy;
  out[5] = h[5] / sy;
  out[6] = h[0] * shx + h[3] * shy + h[6];
  out[7] = h[1] * shx + h[4] * shy + h[7];
  out[8] = h[2] * shx + h[5] * shy + h[8];
  return out;
}

// ----------------------------------------------------------------------------
// vtkProjectedTextureMapper (renderable)
// ----------------------------------------------------------------------------

function vtkProjectedTextureMapper(publicAPI, model) {
  model.classHierarchy.push("vtkProjectedTextureMapper");

  // The homography prop wins; otherwise the matrix may ride the input
  // polydata as a field-data array, arriving with the geometry it applies to.
  publicAPI.getResolvedHomography = () => {
    if (model.homography?.length === 9) {
      return model.homography;
    }
    const fieldArray = publicAPI
      .getInputData(0)
      ?.getFieldData?.()
      ?.getArrayByName?.(model.homographyArrayName);
    const values = fieldArray?.getData?.();
    return values?.length >= 9 ? values : null;
  };

  // A client-installed provider wins so per-render matrices (e.g. derived
  // from an externally animated camera) need no prop churn.
  publicAPI.getResolvedWorldToClip = () => {
    if (typeof model.worldToClipProvider === "function") {
      const matrix = model.worldToClipProvider();
      if (matrix?.length === 16) {
        return matrix;
      }
    }
    return model.worldToClip?.length === 16 ? model.worldToClip : null;
  };
}

const RENDERABLE_DEFAULT_VALUES = {
  textureKey: null,
  mode: ProjectedTextureMode.HOMOGRAPHY,
  homography: null, // 9 values, column-major
  homographyArrayName: "HomographyInverse",
  worldToClip: null, // 16 values, column-major
  worldToClipProvider: null, // client-side only, never serialized
};

export function extend(publicAPI, model, initialValues = {}) {
  Object.assign(model, RENDERABLE_DEFAULT_VALUES, initialValues);

  vtkMapper.extend(publicAPI, model, initialValues);

  macro.setGet(publicAPI, model, [
    "textureKey",
    "mode",
    "homography",
    "homographyArrayName",
    "worldToClip",
    "worldToClipProvider",
  ]);

  vtkProjectedTextureMapper(publicAPI, model);
}

export const newInstance = macro.newInstance(
  extend,
  "vtkProjectedTextureMapper",
);

// ----------------------------------------------------------------------------
// vtkOpenGLProjectedTextureMapper
// ----------------------------------------------------------------------------

const ZERO_SHIFT = [0, 0, 0];
const UNIT_SCALE = [1, 1, 1];

function vtkOpenGLProjectedTextureMapper(publicAPI, model) {
  model.classHierarchy.push("vtkOpenGLProjectedTextureMapper");

  const superClass = { ...publicAPI };

  publicAPI.replaceShaderValues = (shaders, ren, actor) => {
    // Consume the TCoord markers before the base class walks the template.
    applyProjectedTextureShaderReplacements(
      shaders,
      model.renderable.getMode(),
    );
    superClass.replaceShaderValues(shaders, ren, actor);
  };

  publicAPI.renderPieceStart = (ren, actor) => {
    superClass.renderPieceStart(ren, actor);

    model._projTexUnit = -1;
    const gl = model.context;
    const key = model.renderable.getTextureKey();
    const renderWindow = model._openGLRenderWindow?.getRenderable?.();
    const registry = getExternalTextures(renderWindow);
    if (!gl || key == null || !registry) {
      return;
    }

    const unit = model._openGLRenderWindow.getTextureUnitManager().allocate();
    if (unit < 0) {
      return;
    }
    model._projTexUnit = unit;
    gl.activeTexture(gl.TEXTURE0 + unit);
    registry.bindTexture(key, gl);
    gl.activeTexture(gl.TEXTURE0);
  };

  publicAPI.renderPieceFinish = (ren, actor) => {
    if (model._projTexUnit >= 0) {
      model._openGLRenderWindow
        .getTextureUnitManager()
        .free(model._projTexUnit);
      model._projTexUnit = -1;
    }
    superClass.renderPieceFinish(ren, actor);
  };

  publicAPI.setMapperShaderParameters = (cellBO, ren, actor) => {
    superClass.setMapperShaderParameters(cellBO, ren, actor);

    const program = cellBO.getProgram();
    if (!program) {
      return;
    }

    if (model._projTexUnit >= 0 && program.isUniformUsed("uProjTex")) {
      program.setUniformi("uProjTex", model._projTexUnit);
    }

    const cabo = cellBO.getCABO();
    const shiftScaleEnabled = cabo.getCoordShiftAndScaleEnabled?.();
    const shift = shiftScaleEnabled ? cabo.getCoordShift() : null;
    const scale = shiftScaleEnabled ? cabo.getCoordScale() : null;

    if (model.renderable.getMode() === ProjectedTextureMode.HOMOGRAPHY) {
      if (!program.isUniformUsed("uProjTexHomographyInv")) {
        return;
      }
      const homography = model.renderable.getResolvedHomography();
      if (!homography) {
        return;
      }
      if (shift && scale) {
        program.setUniformMatrix3x3(
          "uProjTexHomographyInv",
          foldHomographyCoordShiftScale(
            homography,
            shift,
            scale,
            model._projTexFoldedHomography,
          ),
        );
      } else {
        program.setUniformMatrix3x3("uProjTexHomographyInv", homography);
      }
    } else {
      const worldToClip = model.renderable.getResolvedWorldToClip();
      if (worldToClip && program.isUniformUsed("uProjTexWorldToClip")) {
        program.setUniformMatrix("uProjTexWorldToClip", worldToClip);
      }
      if (program.isUniformUsed("uProjTexCoordShift")) {
        const s = shift || ZERO_SHIFT;
        program.setUniform3f("uProjTexCoordShift", s[0], s[1], s[2]);
      }
      if (program.isUniformUsed("uProjTexCoordScale")) {
        const s = scale || UNIT_SCALE;
        program.setUniform3f("uProjTexCoordScale", s[0], s[1], s[2]);
      }
    }
  };
}

const OPENGL_DEFAULT_VALUES = {};

export function extendOpenGL(publicAPI, model, initialValues = {}) {
  Object.assign(model, OPENGL_DEFAULT_VALUES, initialValues);

  vtkOpenGLPolyDataMapper.extend(publicAPI, model, initialValues);

  model._projTexUnit = -1;
  model._projTexFoldedHomography = new Float32Array(9);

  vtkOpenGLProjectedTextureMapper(publicAPI, model);
}

export const newOpenGLInstance = macro.newInstance(
  extendOpenGL,
  "vtkOpenGLProjectedTextureMapper",
);

// ----------------------------------------------------------------------------
// Registration: renderable -> OpenGL scene-graph node. Serialized type
// construction is centralized in syntheticTypes.js.
// ----------------------------------------------------------------------------

registerOverride("vtkProjectedTextureMapper", newOpenGLInstance);

export default {
  newInstance,
  extend,
  newOpenGLInstance,
  extendOpenGL,
  ProjectedTextureMode,
  applyProjectedTextureShaderReplacements,
  foldHomographyCoordShiftScale,
};
