import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";

export const DISTANCE_TO_CAMERA_STATE_KEY = "distanceToCamera";
export const DEFAULT_DISTANCE_TO_CAMERA_ARRAY = "DistanceToCamera";

// World-unit safety cap for degenerate projections; applications with different
// scene units may override this with distanceToCamera.maxScale.
const DEFAULT_MAX_SCALE = 600;
const EPSILON = 1e-12;

export function createDistanceToCameraGlyphRegistry() {
  return new Map();
}

function isLiveInstance(instance) {
  return (
    !!instance &&
    !(typeof instance.isDeleted === "function" && instance.isDeleted())
  );
}

function isPositiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

function validArrayName(value) {
  return typeof value === "string" && value.length > 0;
}

function validObjectId(value) {
  return (
    (typeof value === "string" && value.length > 0) ||
    (Number.isInteger(value) && value > 0)
  );
}

function walkStateObjects(state, visit) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return;
  }

  visit(state);
  const deps = Array.isArray(state.dependencies) ? state.dependencies : [];
  deps.forEach((dep) => walkStateObjects(dep, visit));
}

function normalizeConfig(config) {
  if (!config || typeof config !== "object") {
    return null;
  }

  const screenSize = Number(config.screenSize);
  if (!isPositiveFinite(screenSize)) {
    return null;
  }

  if (!validObjectId(config.inputDataObjectId)) {
    return null;
  }

  const maxScale = Number(config.maxScale);
  return {
    screenSize,
    arrayName: validArrayName(config.arrayName)
      ? config.arrayName
      : DEFAULT_DISTANCE_TO_CAMERA_ARRAY,
    inputDataObjectId: String(config.inputDataObjectId),
    maxScale: isPositiveFinite(maxScale) ? maxScale : DEFAULT_MAX_SCALE,
  };
}

export function syncDistanceToCameraGlyphState(
  state,
  synchronizerContext,
  registry,
  { reset = false } = {},
) {
  if (!registry) {
    return registry;
  }
  if (reset) {
    registry.clear();
  }

  walkStateObjects(state, (node) => {
    if (node.type !== "vtkGlyph3DMapper" || node.id == null) {
      return;
    }

    const id = String(node.id);
    const config = normalizeConfig(node[DISTANCE_TO_CAMERA_STATE_KEY]);
    const mapper = synchronizerContext?.getInstance?.(id);
    const input = config
      ? synchronizerContext?.getInstance?.(config.inputDataObjectId)
      : null;

    if (!config) {
      registry.delete(id);
      return;
    }

    if (!isLiveInstance(mapper) || !isLiveInstance(input)) {
      registry.set(id, {
        id,
        mapper: null,
        input: null,
        ...config,
        lastSignature: null,
        pending: true,
      });
      return;
    }

    const previous = registry.get(id);
    const unchanged =
      previous &&
      previous.mapper === mapper &&
      previous.input === input &&
      previous.screenSize === config.screenSize &&
      previous.arrayName === config.arrayName &&
      previous.inputDataObjectId === config.inputDataObjectId &&
      previous.maxScale === config.maxScale;

    if (mapper.getInputData?.(0) !== input) {
      mapper.setInputData?.(input, 0);
    }
    mapper.setScaleArray?.(config.arrayName);

    registry.set(id, {
      ...(unchanged ? previous : {}),
      id,
      mapper,
      input,
      ...config,
      lastSignature: unchanged ? previous.lastSignature : null,
      pending: false,
    });
  });

  return registry;
}

export function syncDistanceToCameraGlyphPatch(
  patch,
  synchronizerContext,
  registry,
) {
  const ops = Array.isArray(patch?.ops) ? patch.ops : [];
  ops.forEach((op) => {
    if (op?.op === "updateObject") {
      syncDistanceToCameraGlyphState(op.state, synchronizerContext, registry);
    }
  });
  return registry;
}

export function createDistanceToCameraRenderCallback(updateScales, callback) {
  return function distanceToCameraRenderCallback(...args) {
    updateScales?.();
    return callback?.(...args);
  };
}

export function bindDistanceToCameraInteractorRenderEvent(
  interactor,
  updateScales,
) {
  if (
    typeof updateScales !== "function" ||
    typeof interactor?.onRenderEvent !== "function"
  ) {
    return null;
  }

  return interactor.onRenderEvent(() => {
    updateScales();
  });
}

function getDevicePixelRatio() {
  const ratio = Number(globalThis.window?.devicePixelRatio);
  return isPositiveFinite(ratio) ? ratio : 1;
}

function getViewportMetrics(renderer, renderWindow) {
  const viewport = renderer?.getViewport?.() || [0, 0, 1, 1];
  const view = renderWindow?.getViews?.()?.[0] || null;
  const size = view?.getSize?.();
  if (!size || size.length < 2) {
    return null;
  }

  // vtk.js view sizes are device pixels; vtkDistanceToCamera screenSize is
  // treated as CSS pixels to match the app's screen-space keypoint contract.
  const devicePixelRatio = getDevicePixelRatio();
  const viewWidth = Number(size[0]) / devicePixelRatio;
  const viewHeight = Number(size[1]) / devicePixelRatio;
  const x0 = Number(viewport[0] ?? 0);
  const y0 = Number(viewport[1] ?? 0);
  const x1 = Number(viewport[2] ?? 1);
  const y1 = Number(viewport[3] ?? 1);
  const width = Math.abs(x1 - x0) * viewWidth;
  const height = Math.abs(y1 - y0) * viewHeight;
  if (!isPositiveFinite(width) || !isPositiveFinite(height)) {
    return null;
  }

  return {
    width,
    height,
    aspect: width / height,
    viewport: [x0, y0, x1, y1],
  };
}

function getWorldToClipMatrix(camera, aspect) {
  // getCompositeProjectionMatrix already includes user projection matrices and
  // physicalScale, so sizing follows the actual rendered transform.
  const matrix = camera?.getCompositeProjectionMatrix?.(aspect, -1, 1);
  if (!matrix || matrix.length !== 16) {
    return null;
  }
  return transposeMatrix(matrix);
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

function transformPoint(out, point, matrix) {
  const x = point[0];
  const y = point[1];
  const z = point[2];
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15] || 1;
  out[0] = (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w;
  out[1] = (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w;
  out[2] = (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w;
  return out;
}

function projectToPixel(out, matrix, x, y, z, width, height) {
  transformPoint(out, [x, y, z], matrix);
  if (
    !Number.isFinite(out[0]) ||
    !Number.isFinite(out[1]) ||
    !Number.isFinite(out[2])
  ) {
    return false;
  }
  out[0] = out[0] * (width / 2) + width / 2;
  out[1] = out[1] * (height / 2) + height / 2;
  return Number.isFinite(out[0]) && Number.isFinite(out[1]);
}

function axisPixelsPerWorld(base, shifted) {
  return Math.hypot(shifted[0] - base[0], shifted[1] - base[1]);
}

export function computeDistanceToCameraScales(
  points,
  worldToClip,
  width,
  height,
  screenSize,
  { maxScale = DEFAULT_MAX_SCALE, output = null } = {},
) {
  const pointCount = Math.floor((points?.length || 0) / 3);
  const scales =
    output && output.length === pointCount
      ? output
      : new Float32Array(pointCount);
  const base = [0, 0, 0];
  const shifted = [0, 0, 0];

  for (let i = 0; i < pointCount; i += 1) {
    const offset = i * 3;
    const x = points[offset];
    const y = points[offset + 1];
    const z = points[offset + 2];

    let pixelsPerWorld = 0;
    if (projectToPixel(base, worldToClip, x, y, z, width, height)) {
      if (projectToPixel(shifted, worldToClip, x + 1, y, z, width, height)) {
        pixelsPerWorld = Math.max(
          pixelsPerWorld,
          axisPixelsPerWorld(base, shifted),
        );
      }
      if (projectToPixel(shifted, worldToClip, x, y + 1, z, width, height)) {
        pixelsPerWorld = Math.max(
          pixelsPerWorld,
          axisPixelsPerWorld(base, shifted),
        );
      }
      if (projectToPixel(shifted, worldToClip, x, y, z + 1, width, height)) {
        pixelsPerWorld = Math.max(
          pixelsPerWorld,
          axisPixelsPerWorld(base, shifted),
        );
      }
    }

    const scale =
      pixelsPerWorld > EPSILON ? screenSize / pixelsPerWorld : maxScale;
    scales[i] = Math.min(maxScale, Math.max(0, scale));
  }

  return scales;
}

function getPointDataArray(pointData, arrayName) {
  return (
    pointData?.getArray?.(arrayName) || pointData?.getArrayByName?.(arrayName)
  );
}

function ensureDistanceArray(input, arrayName, tupleCount) {
  const pointData = input?.getPointData?.();
  if (!pointData) {
    return null;
  }

  let array = getPointDataArray(pointData, arrayName);
  let values = array?.getData?.();
  if (!(values instanceof Float32Array) || values.length !== tupleCount) {
    values = new Float32Array(tupleCount);
    if (array) {
      array.setData(values, 1);
    } else {
      array = vtkDataArray.newInstance({
        name: arrayName,
        numberOfComponents: 1,
        values,
      });
    }
  }

  if (pointData.getScalars?.() !== array) {
    if (typeof pointData.setScalars === "function") {
      pointData.setScalars(array);
    } else if (!getPointDataArray(pointData, arrayName)) {
      pointData.addArray?.(array);
    }
  }

  return { pointData, array, values };
}

function entrySignature(entry, camera, input, points, metrics) {
  return [
    entry.screenSize,
    entry.arrayName,
    entry.maxScale,
    entry.inputDataObjectId,
    camera?.getMTime?.() ?? 0,
    camera?.getPhysicalScale?.() ?? 1,
    input?.getMTime?.() ?? 0,
    points?.getMTime?.() ?? 0,
    points?.getData?.()?.length ?? 0,
    metrics.width,
    metrics.height,
    ...metrics.viewport,
  ].join("|");
}

export function updateDistanceToCameraGlyphs(
  registry,
  { renderer, renderWindow, synchronizerContext } = {},
) {
  if (!registry?.size || !renderer || !renderWindow) {
    return false;
  }

  const camera = renderer.getActiveCamera?.();
  const metrics = getViewportMetrics(renderer, renderWindow);
  if (!camera || !metrics) {
    return false;
  }

  const worldToClip = getWorldToClipMatrix(camera, metrics.aspect);
  if (!worldToClip) {
    return false;
  }

  let updated = false;
  for (const [id, entry] of registry) {
    const mapper = entry.mapper;
    const input = entry.input;
    const hasContextLookup =
      typeof synchronizerContext?.getInstance === "function";
    const contextMapper = hasContextLookup
      ? synchronizerContext.getInstance(id)
      : mapper;
    const contextInput = hasContextLookup
      ? synchronizerContext.getInstance(entry.inputDataObjectId)
      : input;
    if (
      entry.pending &&
      isLiveInstance(contextMapper) &&
      isLiveInstance(contextInput)
    ) {
      entry.mapper = contextMapper;
      entry.input = contextInput;
      entry.pending = false;
      entry.lastSignature = null;
      if (contextMapper.getInputData?.(0) !== contextInput) {
        contextMapper.setInputData?.(contextInput, 0);
      }
      contextMapper.setScaleArray?.(entry.arrayName);
    }
    if (
      !isLiveInstance(entry.mapper) ||
      !isLiveInstance(entry.input) ||
      (hasContextLookup &&
        !entry.pending &&
        (contextMapper !== entry.mapper || contextInput !== entry.input))
    ) {
      registry.delete(id);
      continue;
    }

    const points = entry.input?.getPoints?.();
    const pointValues = points?.getData?.();
    if (!pointValues || pointValues.length === 0) {
      continue;
    }

    const signature = entrySignature(entry, camera, entry.input, points, metrics);
    if (entry.lastSignature === signature) {
      continue;
    }

    const tupleCount = Math.floor(pointValues.length / 3);
    const target = ensureDistanceArray(entry.input, entry.arrayName, tupleCount);
    if (!target) {
      continue;
    }

    computeDistanceToCameraScales(
      pointValues,
      worldToClip,
      metrics.width,
      metrics.height,
      entry.screenSize,
      { maxScale: entry.maxScale, output: target.values },
    );
    target.array.modified?.();
    target.pointData.modified?.();
    entry.input.modified?.();
    entry.mapper.modified?.();
    // input.modified() changes the MTime; cache the post-write signature so
    // the next render can converge without a redundant recompute.
    entry.lastSignature = entrySignature(
      entry,
      camera,
      entry.input,
      points,
      metrics,
    );
    updated = true;
  }

  return updated;
}

export function describeDistanceToCameraGlyphRegistry(registry) {
  const entries = [];
  if (!registry) {
    return { size: 0, entries };
  }

  for (const [id, entry] of registry) {
    const input = entry.input;
    const pointData = input?.getPointData?.();
    const arrays = [];
    const numberOfArrays = pointData?.getNumberOfArrays?.() ?? 0;
    for (let i = 0; i < numberOfArrays; i += 1) {
      const array = pointData.getArrayByIndex?.(i);
      arrays.push({
        name: array?.getName?.() ?? null,
        length: array?.getData?.()?.length ?? null,
      });
    }

    entries.push({
      id,
      pending: !!entry.pending,
      arrayName: entry.arrayName,
      screenSize: entry.screenSize,
      inputDataObjectId: entry.inputDataObjectId,
      mapperLive: isLiveInstance(entry.mapper),
      inputLive: isLiveInstance(entry.input),
      pointCount: input?.getPoints?.()?.getNumberOfPoints?.() ?? null,
      scalarName: pointData?.getScalars?.()?.getName?.() ?? null,
      arrays,
    });
  }

  return { size: registry.size, entries };
}

export default {
  createDistanceToCameraGlyphRegistry,
  syncDistanceToCameraGlyphState,
  syncDistanceToCameraGlyphPatch,
  createDistanceToCameraRenderCallback,
  bindDistanceToCameraInteractorRenderEvent,
  computeDistanceToCameraScales,
  updateDistanceToCameraGlyphs,
  describeDistanceToCameraGlyphRegistry,
};
