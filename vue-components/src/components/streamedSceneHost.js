// Per-view host for synthetic streamed-scene actors. The wire anchor is an
// inert actor; format members own the renderable actors they place beside it.

import {
  DecodeWorkerPool,
  createHttpTileSource,
  createMemoryPool,
  createStreamedMemberFactoryRegistry,
  createStreamedSceneCoordinator,
  cursorRay,
} from "pointcloud-lod";
import {
  DEFAULT_MIN_POINT_BUDGET,
  createPointCloudMember,
  createTiles3dMember,
} from "pointcloud-lod/vtk";
import { getCompressedTextureCapabilities } from "@kitware/vtk.js/Rendering/OpenGL/Texture/compressedFormats";

import { getWorldToClipMatrix } from "./cameraMatrix";
import { isLiveInstance, isPositiveFinite } from "./predicates";
import { getDevicePixelRatio, getViewportMetrics } from "./viewportMetrics";

export const STREAMED_SCENE_BLOCK_KEY = "streamedScene";

// All views draw through the same page/GPU, so they must divide one residency
// budget rather than each claiming a full-sized pool.
let pageMemoryPool = null;
function getPageMemoryPool() {
  if (!pageMemoryPool) pageMemoryPool = createMemoryPool();
  return pageMemoryPool;
}

export const TILES3D_ASSET_URLS = Object.freeze({
  worker: "/__trame_vtklocal/js/tiles3dDecodeWorker.classic.js",
  wasm: Object.freeze({
    draco: Object.freeze({
      wrapperUrl: "/__trame_vtklocal/wasm/tiles3d/draco_wasm_wrapper.js",
      wasmUrl: "/__trame_vtklocal/wasm/tiles3d/draco_decoder.wasm",
    }),
    basis: Object.freeze({
      encoderUrl: "/__trame_vtklocal/wasm/tiles3d/basis_encoder.js",
      wasmUrl: "/__trame_vtklocal/wasm/tiles3d/basis_encoder.wasm",
    }),
  }),
});

const absoluteAssetUrl = (value) =>
  new URL(value, globalThis.location?.href ?? "http://localhost/").href;

const tiles3dWasmUrls = () => ({
  draco: {
    wrapperUrl: absoluteAssetUrl(TILES3D_ASSET_URLS.wasm.draco.wrapperUrl),
    wasmUrl: absoluteAssetUrl(TILES3D_ASSET_URLS.wasm.draco.wasmUrl),
  },
  basis: {
    encoderUrl: absoluteAssetUrl(TILES3D_ASSET_URLS.wasm.basis.encoderUrl),
    wasmUrl: absoluteAssetUrl(TILES3D_ASSET_URLS.wasm.basis.wasmUrl),
  },
});

let pageWorkerPool = null;
let pageWorkerReferences = 0;
const pageWorkers = {
  get size() {
    return pageWorkerPool?.size ?? 0;
  },
  decode(request) {
    if (!pageWorkerPool) {
      pageWorkerPool = new DecodeWorkerPool({
        workerUrl: TILES3D_ASSET_URLS.worker,
      });
    }
    return pageWorkerPool.decode(request);
  },
  stats() {
    return (
      pageWorkerPool?.stats?.() ?? {
        size: 0,
        queuedJobs: 0,
        activeJobs: 0,
        completedJobs: 0,
        failedJobs: 0,
        cancelledJobs: 0,
        workerElapsedMs: 0,
        decodedGeometryBytes: 0,
        decodedTextureBytes: 0,
        basisRuntimeInitializationMs: 0,
        basisTranscodeMs: 0,
        basisTextures: 0,
        basisTargets: {},
        basisTargetTimings: {},
      }
    );
  },
};

function acquirePageWorkers() {
  pageWorkerReferences += 1;
  return {
    workers: pageWorkers,
    release() {
      pageWorkerReferences = Math.max(0, pageWorkerReferences - 1);
      if (pageWorkerReferences === 0) {
        pageWorkerPool?.dispose();
        pageWorkerPool = null;
      }
    },
  };
}

const defaultMemberFactories = createStreamedMemberFactoryRegistry();
defaultMemberFactories.register("pointCloud", (context, config) =>
  createPointCloudMember(context, config),
);
defaultMemberFactories.register("tiles3d", (context, config) =>
  createTiles3dMember(context, config),
);

const nonEmptyString = (value) =>
  typeof value === "string" && value.length > 0 ? value : null;

function normalizePresentation(value) {
  if (value?.mode === "fixed" && isPositiveFinite(value.diameterCssPx)) {
    return { mode: "fixed", diameterCssPx: Number(value.diameterCssPx) };
  }
  if (
    value?.mode === "auto" &&
    isPositiveFinite(value.userScale) &&
    isPositiveFinite(value.minDiameterCssPx) &&
    isPositiveFinite(value.maxDiameterCssPx) &&
    value.minDiameterCssPx <= value.maxDiameterCssPx
  ) {
    return {
      mode: "auto",
      userScale: Number(value.userScale),
      minDiameterCssPx: Number(value.minDiameterCssPx),
      maxDiameterCssPx: Number(value.maxDiameterCssPx),
    };
  }
  return null;
}

function normalizeAdaptiveOptions(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const key of ["interactionTargetMs", "stationaryTargetMs"]) {
    if (value[key] === undefined || value[key] === null) continue;
    if (!isPositiveFinite(value[key])) return null;
    result[key] = Number(value[key]);
  }
  for (const key of ["minBudget", "maxBudget"]) {
    if (value[key] === undefined || value[key] === null) continue;
    if (!isPositiveFinite(value[key])) return null;
    result[key] = Math.floor(Number(value[key]));
  }
  const minimum = result.minBudget ?? DEFAULT_MIN_POINT_BUDGET;
  if (result.maxBudget !== undefined && result.maxBudget < minimum) return null;
  return result;
}

function normalizePointCloud(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const presentation = normalizePresentation(value.presentation);
  const adaptiveOptions = normalizeAdaptiveOptions(value.adaptiveOptions);
  if (
    !Number.isFinite(value.pointCount) ||
    value.pointCount < 0 ||
    typeof value.adaptive !== "boolean" ||
    !presentation ||
    !adaptiveOptions
  ) {
    return null;
  }
  if (
    value.pointBudget !== undefined &&
    value.pointBudget !== null &&
    !isPositiveFinite(value.pointBudget)
  ) {
    return null;
  }
  if (
    value.refinementCutoffPx !== undefined &&
    value.refinementCutoffPx !== null &&
    (!Number.isFinite(value.refinementCutoffPx) || value.refinementCutoffPx < 0)
  ) {
    return null;
  }
  return {
    pointCount: Math.floor(Number(value.pointCount)),
    presentation,
    adaptive: value.adaptive,
    adaptiveOptions,
    ...(value.pointBudget === undefined || value.pointBudget === null
      ? {}
      : { pointBudget: Math.floor(Number(value.pointBudget)) }),
    ...(value.refinementCutoffPx === undefined ||
    value.refinementCutoffPx === null
      ? {}
      : { refinementCutoffPx: Number(value.refinementCutoffPx) }),
  };
}

function normalizeTiles3d(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    !Array.isArray(value.ecefToScene) ||
    value.ecefToScene.length !== 16 ||
    !value.ecefToScene.every(Number.isFinite)
  ) {
    return null;
  }
  const m = value.ecefToScene;
  const determinant =
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2]);
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= 1e-15) {
    return null;
  }
  const affineEntry = (index, expected) =>
    Math.abs(value.ecefToScene[index] - expected) <=
    1e-12 + 1e-9 * Math.abs(expected);
  if (
    !affineEntry(3, 0) ||
    !affineEntry(7, 0) ||
    !affineEntry(11, 0) ||
    !affineEntry(15, 1)
  ) {
    return null;
  }
  if (
    value.maximumScreenSpaceErrorPx !== undefined &&
    value.maximumScreenSpaceErrorPx !== null &&
    !isPositiveFinite(value.maximumScreenSpaceErrorPx)
  ) {
    return null;
  }
  const verticalExaggeration =
    value.verticalExaggeration === undefined ? 1 : value.verticalExaggeration;
  const verticalPivotZ =
    value.verticalPivotZ === undefined ? 0 : value.verticalPivotZ;
  const role = value.role === undefined ? "model" : value.role;
  if (
    !isPositiveFinite(verticalExaggeration) ||
    !Number.isFinite(verticalPivotZ) ||
    (role !== "model" && role !== "terrain")
  ) {
    return null;
  }
  const rawTextureAssetId = value.textureAssetId;
  let textureAssetId = null;
  if (rawTextureAssetId !== undefined && rawTextureAssetId !== null) {
    if (
      typeof rawTextureAssetId !== "string" ||
      rawTextureAssetId.trim().length === 0 ||
      role !== "terrain"
    ) {
      return null;
    }
    textureAssetId = rawTextureAssetId.trim();
  }
  return {
    ecefToScene: value.ecefToScene.map(Number),
    verticalExaggeration,
    verticalPivotZ,
    role,
    ...(textureAssetId === null ? {} : { textureAssetId }),
    ...(value.maximumScreenSpaceErrorPx === undefined ||
    value.maximumScreenSpaceErrorPx === null
      ? {}
      : {
          maximumScreenSpaceErrorPx: Number(value.maximumScreenSpaceErrorPx),
        }),
  };
}

// Normalization is deliberately atomic. A malformed common field, a missing
// kind payload, or an extra payload for another known kind drops the block.
export function normalizeStreamedSceneBlock(block, factories) {
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const kind = nonEmptyString(block.kind);
  const sourceAssetId = nonEmptyString(block.sourceAssetId);
  const revision = nonEmptyString(block.revision);
  const endpoint = nonEmptyString(block.endpoint);
  if (
    !kind ||
    !sourceAssetId ||
    !revision ||
    !endpoint ||
    endpoint.endsWith("/") ||
    !factories?.has?.(kind)
  ) {
    return null;
  }
  if (
    (kind !== "pointCloud" && block.pointCloud !== undefined) ||
    (kind !== "tiles3d" && block.tiles3d !== undefined)
  ) {
    return null;
  }
  const kindConfig =
    kind === "pointCloud"
      ? normalizePointCloud(block.pointCloud)
      : kind === "tiles3d"
        ? normalizeTiles3d(block.tiles3d)
        : null;
  return kindConfig
    ? { kind, sourceAssetId, revision, endpoint, kindConfig }
    : null;
}

function rowNorm(matrix, row) {
  return Math.hypot(matrix[row], matrix[row + 4], matrix[row + 8]);
}

const PERSPECTIVE_W_RATIO_FLOOR = 1e-6;

export function readCameraView(renderer, renderWindow) {
  const camera = renderer?.getActiveCamera?.();
  const metrics = getViewportMetrics(renderer, renderWindow);
  if (!camera || !metrics) return null;
  const viewProj = getWorldToClipMatrix(camera, metrics.aspect);
  const position = camera.getPosition?.();
  if (!viewProj || !position) return null;
  const verticalNorm = rowNorm(viewProj, 1);
  const wNorm = rowNorm(viewProj, 3);
  if (!isPositiveFinite(verticalNorm)) return null;
  const common = {
    viewProj,
    position: [position[0], position[1], position[2]],
    viewportWidthCssPx: metrics.width,
    viewportHeightCssPx: metrics.height,
  };
  if (wNorm > verticalNorm * PERSPECTIVE_W_RATIO_FLOOR) {
    const fovY = 2 * Math.atan(wNorm / verticalNorm);
    return isPositiveFinite(fovY)
      ? { ...common, projection: "perspective", fovY }
      : null;
  }
  const parallelScale = 1 / verticalNorm;
  return isPositiveFinite(parallelScale)
    ? { ...common, projection: "orthographic", parallelScale }
    : null;
}

function actorIsVisible(actor) {
  const value = actor?.getVisibility?.();
  return value === undefined ? true : !!value;
}

function rendererDraws(renderer) {
  const value = renderer?.getDraw?.();
  return value === undefined ? true : !!value;
}

function qualityPolicy(config, tiles3dQualityPolicy) {
  if (config.kind === "tiles3d") {
    return { managed: tiles3dQualityPolicy !== "fixed" };
  }
  if (!config.kindConfig.adaptive) return { managed: false };
  const { interactionTargetMs, stationaryTargetMs } =
    config.kindConfig.adaptiveOptions;
  return {
    managed: true,
    targets: {
      ...(interactionTargetMs === undefined ? {} : { interactionTargetMs }),
      ...(stationaryTargetMs === undefined ? {} : { stationaryTargetMs }),
    },
  };
}

function memberConfig(entry) {
  const { config } = entry;
  const common = {
    sourceAssetId: config.sourceAssetId,
    revision: config.revision,
    endpoint: config.endpoint,
  };
  if (config.kind === "tiles3d") {
    return {
      ...common,
      ...config.kindConfig,
      wasm: tiles3dWasmUrls(),
    };
  }
  const sourceKey = `${config.endpoint}\0${config.revision}`;
  if (entry.sourceKey !== sourceKey) {
    entry.source = createHttpTileSource({
      endpoint: config.endpoint,
      metadata: { pointCount: config.kindConfig.pointCount },
    });
    entry.sourceKey = sourceKey;
  }
  return { ...common, ...config.kindConfig, source: entry.source };
}

const SOFTWARE_WEBGL_RENDERER_TOKENS = [
  "swiftshader",
  "llvmpipe",
  "softpipe",
  "software rasterizer",
];

export function isSoftwareWebGLRenderer(renderer) {
  const value = String(renderer ?? "").toLowerCase();
  return (
    value.length > 0 &&
    SOFTWARE_WEBGL_RENDERER_TOKENS.some((token) => value.includes(token))
  );
}

export function isHeadlessBrowserUserAgent(userAgent) {
  return /(?:HeadlessChrome|HeadlessChromium)/i.test(String(userAgent ?? ""));
}

function requestedTexturePolicy() {
  try {
    return new URL(
      globalThis.location?.href ?? "http://localhost/",
    ).searchParams.get("tiles3dTexturePolicy");
  } catch {
    return null;
  }
}

function requestedTiles3dQualityPolicy() {
  try {
    const requested = new URL(
      globalThis.location?.href ?? "http://localhost/",
    ).searchParams.get("tiles3dQualityPolicy");
    return requested === "fixed" ? "fixed" : "adaptive";
  } catch {
    return "adaptive";
  }
}

export function texturePolicyRgbaReason(renderer, userAgent, requestedPolicy) {
  if (isSoftwareWebGLRenderer(renderer)) return "software-renderer";
  if (isHeadlessBrowserUserAgent(userAgent)) return "headless-browser";
  return requestedPolicy === "rgba" ? "forced-control" : null;
}

function readWebGLRenderer(gl) {
  const debug = gl.getExtension?.("WEBGL_debug_renderer_info");
  const read = (parameter) => {
    try {
      return parameter == null ? null : (gl.getParameter?.(parameter) ?? null);
    } catch {
      return null;
    }
  };
  return {
    vendor: read(debug?.UNMASKED_VENDOR_WEBGL) ?? read(gl.VENDOR),
    renderer: read(debug?.UNMASKED_RENDERER_WEBGL) ?? read(gl.RENDERER),
    version: read(gl.VERSION),
  };
}

function probeTextureEnvironment(context) {
  const openGLRenderWindow =
    context?.openGLRenderWindow ?? context?.renderWindow?.getViews?.()?.[0];
  const gl = openGLRenderWindow?.getContext?.();
  if (!gl) {
    return {
      capabilities: {
        capabilityKey: "compressed-texture-v1:rgba",
        compressedFormats: [],
      },
      renderer: { vendor: null, renderer: null, version: null },
    };
  }
  const renderer = readWebGLRenderer(gl);
  const rgbaReason = texturePolicyRgbaReason(
    renderer.renderer,
    globalThis.navigator?.userAgent,
    requestedTexturePolicy(),
  );
  const capabilities = rgbaReason
    ? {
        capabilityKey: "compressed-texture-v1:rgba",
        compressedFormats: [],
      }
    : getCompressedTextureCapabilities(gl);
  return { capabilities, renderer, rgbaReason };
}

function releaseEntry(entry) {
  entry.registration?.release();
  entry.registration = null;
  entry.member = null;
  entry.hostRenderer = null;
  entry.anchorVersion = null;
  entry.active = false;
}

const finitePositiveDepth = (value) => Number.isFinite(value) && value > 0;

const nearlyEqual = (left, right) =>
  Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));

function sameCursorRay(left, right) {
  return ["origin", "direction"].every((key) =>
    left[key].every((value, index) => nearlyEqual(value, right[key][index])),
  );
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function describeMember(entry) {
  const raw = entry.member?.stats?.() ?? null;
  if (!raw) return raw;
  const renderer = raw.renderer ?? {};
  if (entry.config.kind !== "tiles3d") {
    return {
      ...raw,
      residentBytes: renderer.gpuResidentBytes ?? raw.residentBytes ?? 0,
    };
  }
  const submissions = raw.submissions ?? {};
  return {
    ...raw,
    residentGeometryBytes: renderer.residentGeometryBytes ?? 0,
    logicalGeometryUploadBytes: renderer.logicalGeometryUploadBytes ?? 0,
    logicalTextureUploadBytes: renderer.logicalTextureUploadBytes ?? 0,
    logicalUploadBytes: renderer.logicalUploadBytes ?? 0,
    submittedTextureBytes: renderer.submittedTextureBytes ?? 0,
    pooledTextureBytes: renderer.pooledTextureBytes ?? 0,
    residentTextureBytes: renderer.residentTextureBytes ?? 0,
    residentBytes: renderer.residentBytes ?? 0,
    textureRepresentation: renderer.textureRepresentation ?? "none",
    textureFormats: [...(renderer.textureFormats ?? [])],
    queuedSubmissionJobs: submissions.queuedJobs ?? 0,
    queuedSubmissionBytes: submissions.queuedBytes ?? 0,
    lastFrameAdmittedJobs: submissions.lastFrameAdmittedJobs ?? 0,
    lastFrameAdmittedBytes: submissions.lastFrameAdmittedBytes ?? 0,
    drawnTiles: renderer.drawnTiles ?? 0,
    drawnActors: renderer.drawnActors ?? 0,
    drawnPrimitives: renderer.drawnPrimitives ?? 0,
    drawnTextureBytes: renderer.drawnTextureBytes ?? 0,
    drawnTriangles: renderer.drawnTriangles ?? 0,
  };
}

// Gesture enrichment remains wire-facing policy rather than member behavior.
const CLOUD_SOLVE_GESTURE_TYPES = new Set([
  "target.drag.start",
  "target.drag.move",
  "target.drag.end",
  "target.click",
]);
const ARMED_CLOUD_SOLVE_GESTURE_TYPES = new Set([
  "target.click",
  "background.click",
]);

export function enrichGestureWithCloudSolve(
  payload,
  pickAsset,
  armedAssetId = null,
) {
  if (!payload) return payload;
  const armed =
    armedAssetId != null && ARMED_CLOUD_SOLVE_GESTURE_TYPES.has(payload.type);
  if (!armed && !CLOUD_SOLVE_GESTURE_TYPES.has(payload.type)) return payload;
  if (payload.cancelled || payload.unresolved || !payload.pointer)
    return payload;
  const assetId = armed ? armedAssetId : payload.pick?.tags?.depth_asset_id;
  if (assetId == null) return payload;
  const solve = pickAsset(assetId, payload.pointer.x, payload.pointer.y);
  return solve ? { ...payload, cloud_solve: solve } : payload;
}

export function createStreamedSceneHost(options = {}) {
  const scheduleRender = options.scheduleRender ?? (() => {});
  const factories = options.factories ?? defaultMemberFactories;
  const tiles3dQualityPolicy =
    options.tiles3dQualityPolicy === "fixed"
      ? "fixed"
      : requestedTiles3dQualityPolicy();
  const pageWorkers = options.workers ? null : acquirePageWorkers();
  const textureCapabilities = {
    capabilityKey: "compressed-texture-v1:rgba",
    compressedFormats: [],
  };
  let webglRenderer = { vendor: null, renderer: null, version: null };
  let rgbaReason = null;
  const memory = options.memory ?? getPageMemoryPool();
  const coordinator = (
    options.createCoordinator ?? createStreamedSceneCoordinator
  )({
    scheduleRender,
    memory,
    workers: options.workers ?? pageWorkers.workers,
    textureCapabilities,
    ...(options.coordinatorOptions ?? {}),
  });
  const entries = new Map();
  let disposed = false;
  let lastContext = null;

  function reconcileTextureCapabilities(context) {
    const environment = options.textureCapabilities
      ? {
          capabilities: options.textureCapabilities,
          renderer: options.webglRenderer ?? webglRenderer,
          rgbaReason: options.rgbaReason ?? rgbaReason,
        }
      : probeTextureEnvironment(context);
    const next = environment.capabilities;
    webglRenderer = { ...environment.renderer };
    rgbaReason = environment.rgbaReason ?? null;
    if (next.capabilityKey === textureCapabilities.capabilityKey) return;
    textureCapabilities.capabilityKey = next.capabilityKey;
    textureCapabilities.compressedFormats = [...next.compressedFormats];
    for (const entry of entries.values()) {
      if (entry.config.kind !== "tiles3d" || !entry.member) continue;
      releaseEntry(entry);
      entry.configDirty = true;
      entry.error = null;
      entry.failedConfigGeneration = null;
      entry.failedTopologyVersion = null;
    }
    scheduleRender();
  }

  function remove(id) {
    const entry = entries.get(id);
    if (!entry) return false;
    releaseEntry(entry);
    entries.delete(id);
    scheduleRender();
    return true;
  }

  function applyBlock(nodeId, block, instance) {
    if (disposed || nodeId === null || nodeId === undefined) return;
    const id = String(nodeId);
    const config = normalizeStreamedSceneBlock(block, factories);
    if (!config) {
      remove(id);
      return;
    }
    const actor = isLiveInstance(instance) ? instance : null;
    const current = entries.get(id);
    if (!current) {
      entries.set(id, {
        id,
        actor,
        config,
        hostRenderer: null,
        anchorVersion: null,
        member: null,
        registration: null,
        source: null,
        sourceKey: null,
        configDirty: true,
        configGeneration: 1,
        error: null,
        failedConfigGeneration: null,
        failedTopologyVersion: null,
        active: false,
      });
    } else {
      const rebuild =
        current.config.kind !== config.kind || current.actor !== actor;
      if (rebuild) releaseEntry(current);
      current.actor = actor;
      current.config = config;
      current.configDirty = true;
      current.configGeneration += 1;
      current.error = null;
      current.failedConfigGeneration = null;
      current.failedTopologyVersion = null;
    }
    scheduleRender();
  }

  function resolveRenderer(entry, context, force = false) {
    const version = Number.isFinite(context?.topologyVersion)
      ? context.topologyVersion
      : null;
    const live =
      typeof context?.getInstance === "function"
        ? context.getInstance(entry.id)
        : entry.actor;
    if (!isLiveInstance(live)) {
      entry.anchorVersion = version;
      entry.hostRenderer = null;
      return null;
    }
    const adopted = live !== entry.actor;
    if (adopted) {
      releaseEntry(entry);
      entry.actor = live;
      entry.configDirty = true;
      entry.error = null;
      entry.failedConfigGeneration = null;
      entry.failedTopologyVersion = null;
    } else if (!force && version !== null && entry.anchorVersion === version) {
      return entry.hostRenderer;
    }
    entry.anchorVersion = version;
    entry.hostRenderer = null;
    for (const rendererId of context?.referrersOf?.(entry.id, "viewProps") ??
      []) {
      const renderer = context?.getInstance?.(rendererId);
      if (
        isLiveInstance(renderer) &&
        (!context?.renderers || context.renderers.includes(renderer))
      ) {
        entry.hostRenderer = renderer;
        break;
      }
    }
    return entry.hostRenderer;
  }

  function updateEntry(entry, context, views) {
    const previousRenderer = entry.hostRenderer;
    const renderer = resolveRenderer(entry, context);
    if (!renderer) {
      if (entry.member) releaseEntry(entry);
      return;
    }
    if (entry.member && previousRenderer && previousRenderer !== renderer) {
      releaseEntry(entry);
      entry.hostRenderer = renderer;
    }
    const active = actorIsVisible(entry.actor) && rendererDraws(renderer);
    if (!entry.member && !active) {
      entry.active = false;
      return;
    }
    if (!entry.member) {
      const topologyVersion = Number.isFinite(context?.topologyVersion)
        ? context.topologyVersion
        : null;
      if (
        entry.error &&
        entry.failedConfigGeneration === entry.configGeneration &&
        entry.failedTopologyVersion === topologyVersion
      ) {
        entry.active = false;
        return;
      }
      const contextForMember = coordinator.context(
        renderer,
        getDevicePixelRatio(),
      );
      try {
        entry.member = factories.create(
          entry.config.kind,
          contextForMember,
          memberConfig(entry),
        );
      } catch (error) {
        entry.member = null;
        entry.active = false;
        entry.error = errorMessage(error);
        entry.failedConfigGeneration = entry.configGeneration;
        entry.failedTopologyVersion = topologyVersion;
        return;
      }
      entry.error = null;
      entry.failedConfigGeneration = null;
      entry.failedTopologyVersion = null;
      const policy = qualityPolicy(entry.config, tiles3dQualityPolicy);
      entry.registration = coordinator.register(entry.member, {
        id: entry.id,
        active,
        qualityManaged: policy.managed,
        qualityTargets: policy.targets,
      });
      entry.configDirty = false;
    }
    entry.active = active;
    entry.registration.setActive(active);
    if (entry.configDirty) {
      entry.registration.setConfig(memberConfig(entry));
      const policy = qualityPolicy(entry.config, tiles3dQualityPolicy);
      entry.registration.setQualityPolicy(policy.managed, policy.targets);
      entry.configDirty = false;
    }
    entry.registration.setModelMatrix(entry.actor.getUserMatrix?.() ?? null);
    entry.registration.setDevicePixelRatio(getDevicePixelRatio());
    if (!views.has(renderer)) {
      views.set(renderer, readCameraView(renderer, context.renderWindow));
    }
    const view = views.get(renderer);
    if (view) entry.registration.setCamera(view);
  }

  function beforeRender(context = {}) {
    if (disposed) return;
    lastContext = context;
    reconcileTextureCapabilities(context);
    const views = new Map();
    for (const entry of entries.values()) updateEntry(entry, context, views);
    coordinator.noteRenderedCameras(views);
    coordinator.prepareFrame();
  }

  function queryState(entry, cssX, cssY) {
    if (!lastContext || !entry.member || !entry.registration) return null;
    const renderer = resolveRenderer(entry, lastContext, true);
    if (
      !renderer ||
      !entry.member ||
      !entry.registration ||
      !actorIsVisible(entry.actor) ||
      !rendererDraws(renderer)
    ) {
      return null;
    }
    const view = readCameraView(renderer, lastContext.renderWindow);
    const metrics = getViewportMetrics(renderer, lastContext.renderWindow);
    if (!view || !metrics) return null;
    const x = cssX - metrics.leftCssPx;
    const y = cssY - metrics.topCssPx;
    if (x < 0 || x > metrics.width || y < 0 || y > metrics.height) {
      return { status: "outside" };
    }
    const ray = cursorRay(
      view.viewProj,
      x,
      y,
      view.viewportWidthCssPx,
      view.viewportHeightCssPx,
    );
    if (!ray) return null;
    entry.registration.setModelMatrix(entry.actor.getUserMatrix?.() ?? null);
    entry.registration.setCamera(view);
    return {
      status: "ready",
      view,
      ray,
      x,
      y,
    };
  }

  function pickAssetImpl(sourceAssetId, cssX, cssY) {
    if (disposed || !nonEmptyString(sourceAssetId)) return null;
    let target = null;
    for (const entry of entries.values()) {
      if (entry.config.sourceAssetId !== sourceAssetId) continue;
      if (target) return null;
      target = entry;
    }
    if (!target) return null;
    const targetQuery = queryState(target, cssX, cssY);
    if (!targetQuery || targetQuery.status !== "ready") return null;
    const targetResult = target.member.pick(
      targetQuery.view,
      targetQuery.x,
      targetQuery.y,
    );
    if (!targetResult) return null;
    const targetDepth =
      targetResult.status === "miss" ? Infinity : targetResult.rayDepth;
    if (
      targetResult.status !== "miss" &&
      (targetResult.status !== "hit" || !finitePositiveDepth(targetDepth))
    ) {
      return null;
    }

    let closestBlocker = null;
    let closestDepth = Infinity;
    for (const blocker of entries.values()) {
      if (blocker === target || !blocker.member || !blocker.active) continue;
      if (!actorIsVisible(blocker.actor)) continue;
      const blockerRenderer = resolveRenderer(blocker, lastContext, true);
      if (!blockerRenderer) return null;
      if (!rendererDraws(blockerRenderer)) continue;
      const blockerQuery = queryState(blocker, cssX, cssY);
      if (!blockerQuery) return null;
      if (blockerQuery.status === "outside") continue;
      if (!sameCursorRay(targetQuery.ray, blockerQuery.ray)) return null;
      const result = blocker.member.occlusionDepth(
        blockerQuery.view,
        blockerQuery.x,
        blockerQuery.y,
      );
      if (!result) return null;
      if (result.status === "clear") continue;
      if (result.status !== "hit" || !finitePositiveDepth(result.rayDepth)) {
        return null;
      }
      if (result.rayDepth < targetDepth && result.rayDepth < closestDepth) {
        closestDepth = result.rayDepth;
        closestBlocker = blocker;
      }
    }

    const provenance = {
      asset_id: target.config.sourceAssetId,
      revision: target.config.revision,
      node_id: target.id,
    };
    if (closestBlocker) {
      return {
        status: "occluded",
        ...provenance,
        blocker: {
          asset_id: closestBlocker.config.sourceAssetId,
          revision: closestBlocker.config.revision,
          node_id: closestBlocker.id,
          kind: closestBlocker.config.kind,
        },
      };
    }
    if (targetResult.status === "miss")
      return { status: "miss", ...provenance };
    return {
      status: "hit",
      ...provenance,
      world: targetResult.pointOnRay,
      distance_px: targetResult.distancePx,
    };
  }

  const picking = {
    calls: 0,
    totalMs: 0,
    peakMs: 0,
    statuses: {},
  };

  function pickAsset(sourceAssetId, cssX, cssY) {
    const now = () => globalThis.performance?.now?.() ?? Date.now();
    const started = now();
    let result = null;
    try {
      result = pickAssetImpl(sourceAssetId, cssX, cssY);
      return result;
    } finally {
      const elapsedMs = Math.max(0, now() - started);
      const status = result?.status ?? "unavailable";
      picking.calls += 1;
      picking.totalMs += elapsedMs;
      picking.peakMs = Math.max(picking.peakMs, elapsedMs);
      picking.statuses[status] = (picking.statuses[status] ?? 0) + 1;
    }
  }

  return {
    applyBlock,
    beforeRender,
    beginInteraction: () => !disposed && coordinator.beginInteraction(),
    endInteraction: () => !disposed && coordinator.endInteraction(),
    recordHostFrame(metrics) {
      if (!disposed) coordinator.recordHostFrame(metrics);
    },
    needsFrame: () => !disposed && coordinator.needsFrame(),
    pickAsset,
    describe() {
      const coordinatorStats = coordinator.stats();
      return {
        members: [...entries.values()].map((entry) => ({
          nodeId: entry.id,
          kind: entry.config.kind,
          sourceAssetId: entry.config.sourceAssetId,
          revision: entry.config.revision,
          endpoint: entry.config.endpoint,
          configGeneration: entry.configGeneration,
          ...(entry.config.kind === "tiles3d"
            ? {
                verticalExaggeration:
                  entry.config.kindConfig.verticalExaggeration,
                verticalPivotZ: entry.config.kindConfig.verticalPivotZ,
                role: entry.config.kindConfig.role,
                textureAssetId: entry.config.kindConfig.textureAssetId ?? null,
              }
            : {}),
          active: entry.active,
          anchorVisible: entry.actor ? actorIsVisible(entry.actor) : null,
          anchorUserMatrix: entry.actor?.getUserMatrix?.() ?? null,
          hasMember: !!entry.member,
          error: entry.error,
          stats: describeMember(entry),
        })),
        coordinator: coordinatorStats,
        decodePool: (options.workers ?? pageWorkers.workers).stats?.() ?? null,
        textureCapabilities: {
          capabilityKey: textureCapabilities.capabilityKey,
          compressedFormats: [...textureCapabilities.compressedFormats],
        },
        webglRenderer: { ...webglRenderer },
        texturePolicy: {
          mode: rgbaReason ? "rgba" : "native",
          rgbaReason,
        },
        tiles3dQualityPolicy: {
          mode: tiles3dQualityPolicy,
          reason: tiles3dQualityPolicy === "fixed" ? "forced-control" : null,
        },
        picking: {
          calls: picking.calls,
          totalMs: picking.totalMs,
          meanMs: picking.calls ? picking.totalMs / picking.calls : 0,
          peakMs: picking.peakMs,
          statuses: { ...picking.statuses },
        },
        pageMemory: memory.stats?.() ?? {
          totalBytes: null,
          memberCount: memory.memberCount?.() ?? 0,
          shareBytes: null,
        },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of entries.values()) releaseEntry(entry);
      entries.clear();
      coordinator.dispose();
      pageWorkers?.release();
    },
  };
}
