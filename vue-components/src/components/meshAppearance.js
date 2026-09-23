// Apply layer appearance after the tile's authored alpha test and lighting.
export function createMeshAppearanceRenderer(renderer, readAppearance) {
  const actors = new Set();
  const originals = new WeakMap();
  function apply(actor) {
    const mapper = actor.getMapper?.();
    if (!mapper) return;
    let original = originals.get(actor);
    if (!original) {
      original = {
        properties: mapper.getViewSpecificProperties?.() ?? {},
        opaque: actor.getForceOpaque?.() ?? false,
        translucent: actor.getForceTranslucent?.() ?? false,
        key: null,
      };
      originals.set(actor, original);
    }
    const { opacity = 1, textureBlend = 1, overlayOrder = 0 } = readAppearance();
    const key = `${opacity}:${textureBlend}:${overlayOrder}`;
    if (original.key === key) return;
    original.key = key;
    const extra = [];
    const replacement = (shaderType, marker, code, replaceFirst = true) => ({
      shaderType, originalValue: marker,
      replacementValue: `${marker}\n${code}`, replaceFirst, replaceAll: false,
    });
    if (overlayOrder > 0) {
      // Break depth ties between flat rasters without changing their elevations.
      extra.push(replacement("Vertex", "//VTK::PositionVC::Impl",
        `gl_Position.z -= ${(overlayOrder * 0.000001).toFixed(6)} * gl_Position.w;`));
    }
    if (textureBlend < 1) {
      extra.push(
        { shaderType: "Vertex", originalValue: "uniform mat4 MCVCMatrix;",
          replacementValue: "", replaceFirst: false, replaceAll: true },
        replacement("Vertex", "uniform mat4 MCPCMatrix;", "uniform mat4 MCVCMatrix;", false),
        replacement("Vertex", "//VTK::PositionVC::Dec", "varying vec3 terrainPosition;"),
        replacement("Vertex", "//VTK::PositionVC::Impl", "terrainPosition = (MCVCMatrix * vertexMC).xyz;"),
        replacement("Fragment", "//VTK::PositionVC::Dec", "varying vec3 terrainPosition;"),
        replacement("Fragment", "//VTK::UniformFlow::Impl",
          "vec3 terrainNormal = normalize(cross(dFdx(terrainPosition), dFdy(terrainPosition)));"),
        replacement("Fragment", "//VTK::Light::Impl",
          `float terrainShade = 0.25 + 0.65 * abs(dot(terrainNormal, normalize(vec3(0.3, 0.5, 1.0))));\n` +
          `gl_FragData[0].rgb = mix(vec3(terrainShade), gl_FragData[0].rgb, ${textureBlend.toFixed(6)});`, false),
      );
    }
    if (opacity < 1) {
      extra.push(replacement("Fragment", "//VTK::Light::Impl",
        `gl_FragData[0].a *= ${opacity.toFixed(6)};`, false));
    }
    mapper.setViewSpecificProperties({
      ...original.properties,
      OpenGL: {
        ...original.properties.OpenGL,
        ShaderReplacements: [
          ...(original.properties.OpenGL?.ShaderReplacements ?? []), ...extra,
        ],
      },
    });
    actor.setForceOpaque(opacity < 1 ? false : original.opaque);
    actor.setForceTranslucent(opacity < 1 ? true : original.translucent);
  }
  return {
    renderer: { ...renderer,
      addActor(actor) { actors.add(actor); apply(actor); renderer.addActor(actor); },
      removeActor(actor) { actors.delete(actor); renderer.removeActor(actor); },
    },
    update() { for (const actor of actors) apply(actor); },
  };
}
