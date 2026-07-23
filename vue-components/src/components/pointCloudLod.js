// Point-cloud LOD anchors: the `pointCloudLod` feature block handler and the
// per-render update pass.
//
// A block arrival creates a registry entry keyed by the anchor mapper's node
// id; the entry lazily builds a pointcloud-lod HttpTileSource + LOD
// controller + renderer adapter once the anchor actor is found (actor access
// resolves lazily at update time, mirroring distanceToCameraGlyphs: block
// application order inside a message is arbitrary, so the anchor actor may
// not be wired to a renderer yet when the block lands). The anchor may live
// in ANY of the view's synced renderers — views layer world geometry, video
// underlay, and annotations as separate VTK renderers — and the streamed tile
// actors are hosted in the same renderer as the anchor so they depth-composite
// in the anchor's layer. Camera state feeds the controller on every applied
// message and interactor render; anchor actor state (UserMatrix correction,
// visibility, point size) fans out to the streamed tile actors on the same
// cadence. Streaming, budgets, cancellation, and caching all live in the
// library — this module is only the wiring.
//
// Renders are requested exclusively through the view's coalescing render
// callback; nothing here calls renderWindow.render().

import {
  createHttpTileSource,
  createLodController,
  createMemoryPool,
  createViewGovernor,
} from "pointcloud-lod";
// The renderer adapter lives behind its own entry point: it imports vtk.js at
// module scope, so the core entry stays loadable without the peer.
import { createRendererAdapter } from "pointcloud-lod/vtk";

import { isLiveInstance } from "./vtkJsSync";

export const POINT_CLOUD_LOD_BLOCK_KEY = "pointCloudLod";

// One memory pool per page: every LOD controller — across all views and
// registries — renders on the same GPU, so resident tile bytes come out of
// one device-sized budget divided among the active clouds. Without this, N
// clouds would each claim a full budget and multiply GPU memory by N.
let sharedMemoryPool = null;
const viewGovernors = new WeakMap();
function getSharedMemoryPool() {
  if (!sharedMemoryPool) {
    sharedMemoryPool = createMemoryPool();
  }
  return sharedMemoryPool;
}

function getViewGovernor(registry, options = {}) {
  let governor = viewGovernors.get(registry);
  if (!governor) {
    governor = createViewGovernor(options);
    viewGovernors.set(registry, governor);
  }
  return governor;
}

const DEG_TO_RAD = Math.PI / 180;

function isPositiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

// The adaptive-quality block (Phase 5). `adaptive` truthy enables the library's
// render-duration-driven budget loop; frame time and the shared GPU-memory
// pool govern the budget — there is no configured point ceiling. The tuning
// fields are optional — the library supplies defaults for anything omitted.
function normalizeAdaptive(block) {
  if (!block || !block.adaptive) {
    return false;
  }
  const options = {};
  if (isPositiveFinite(block.minBudget))
    options.minBudget = Number(block.minBudget);
  if (isPositiveFinite(block.stationaryTargetMs)) {
    options.stationaryTargetMs = Number(block.stationaryTargetMs);
  }
  if (isPositiveFinite(block.interactionTargetMs)) {
    options.interactionTargetMs = Number(block.interactionTargetMs);
  }
  return options;
}

function normalizeConfig(block) {
  if (!block || typeof block !== "object") {
    return null;
  }
  const { endpoint, pointCount, pointBudget, refinementCutoffPx } = block;
  const presentation =
    block.presentation?.mode === "fixed" &&
    isPositiveFinite(block.presentation.diameterCssPx)
      ? {
          mode: "fixed",
          diameterCssPx: Number(block.presentation.diameterCssPx),
        }
      : block.presentation?.mode === "auto" &&
          isPositiveFinite(block.presentation.userScale) &&
          isPositiveFinite(block.presentation.minDiameterCssPx) &&
          isPositiveFinite(block.presentation.maxDiameterCssPx) &&
          block.presentation.minDiameterCssPx <=
            block.presentation.maxDiameterCssPx
        ? {
            mode: "auto",
            userScale: Number(block.presentation.userScale),
            minDiameterCssPx: Number(block.presentation.minDiameterCssPx),
            maxDiameterCssPx: Number(block.presentation.maxDiameterCssPx),
          }
        : null;
  if (typeof endpoint !== "string" || !endpoint || !presentation) {
    return null;
  }
  return {
    endpoint,
    pointCount: Number.isFinite(pointCount) ? Number(pointCount) : 0,
    presentation,
    pointBudget: isPositiveFinite(pointBudget)
      ? Number(pointBudget)
      : undefined,
    refinementCutoffPx:
      Number.isFinite(refinementCutoffPx) && refinementCutoffPx >= 0
        ? Number(refinementCutoffPx)
        : undefined,
    adaptive: normalizeAdaptive(block),
  };
}

function transpose16(m) {
  const out = new Array(16);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      out[column * 4 + row] = m[row * 4 + column];
    }
  }
  return out;
}

export function getViewportHeight(renderer, renderWindow) {
  const viewport = renderer?.getViewport?.() || [0, 0, 1, 1];
  const size = renderWindow?.getViews?.()?.[0]?.getSize?.();
  if (!size || size.length < 2) {
    return null;
  }
  const dpr = isPositiveFinite(globalThis.devicePixelRatio)
    ? Number(globalThis.devicePixelRatio)
    : 1;
  const height =
    (Math.abs(viewport[3] - viewport[1]) * Number(size[1])) / dpr;
  return isPositiveFinite(height) ? height : null;
}

function readCameraView(renderer, renderWindow) {
  const camera = renderer?.getActiveCamera?.();
  const viewportHeight = getViewportHeight(renderer, renderWindow);
  if (!camera || viewportHeight === null) {
    return null;
  }
  const aspect = (() => {
    const size = renderWindow.getViews()[0].getSize();
    const viewport = renderer.getViewport?.() || [0, 0, 1, 1];
    const dpr = isPositiveFinite(globalThis.devicePixelRatio)
      ? Number(globalThis.devicePixelRatio)
      : 1;
    const width =
      (Math.abs(viewport[2] - viewport[0]) * Number(size[0])) / dpr;
    return width > 0 && viewportHeight > 0 ? width / viewportHeight : 1;
  })();
  // getCompositeProjectionMatrix returns the world-to-clip matrix row-major;
  // the library's frustum math wants column-major.
  const rowMajor = camera.getCompositeProjectionMatrix?.(aspect, -1, 1);
  const position = camera.getPosition?.();
  const viewAngle = camera.getViewAngle?.();
  if (!rowMajor || rowMajor.length !== 16 || !position) {
    return null;
  }
  return {
    viewProj: transpose16(rowMajor),
    position: [position[0], position[1], position[2]],
    fovY:
      (Number.isFinite(viewAngle) && viewAngle > 0 ? viewAngle : 30) *
      DEG_TO_RAD,
    viewportHeightCssPx: viewportHeight,
  };
}

function multiplyMat4(a, b) {
  const out = new Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let k = 0; k < 4; k += 1) {
        value += a[k * 4 + row] * b[column * 4 + k];
      }
      out[column * 4 + row] = value;
    }
  }
  return out;
}

function inverseSimilarity(matrix) {
  const m = matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (
    m.length !== 16 ||
    !Array.from(m).every(Number.isFinite) ||
    Math.abs(m[3]) > 1e-9 ||
    Math.abs(m[7]) > 1e-9 ||
    Math.abs(m[11]) > 1e-9 ||
    Math.abs(m[15] - 1) > 1e-9
  ) {
    return null;
  }
  const columns = [
    [m[0], m[1], m[2]],
    [m[4], m[5], m[6]],
    [m[8], m[9], m[10]],
  ];
  const lengths = columns.map((column) => Math.hypot(...column));
  const scale = lengths[0];
  const tolerance = Math.max(1e-9, scale * 1e-6);
  if (
    !isPositiveFinite(scale) ||
    lengths.some((length) => Math.abs(length - scale) > tolerance)
  ) {
    return null;
  }
  for (let left = 0; left < 3; left += 1) {
    for (let right = left + 1; right < 3; right += 1) {
      const dot = columns[left].reduce(
        (sum, value, axis) => sum + value * columns[right][axis],
        0,
      );
      if (Math.abs(dot) > scale * tolerance) return null;
    }
  }
  const inverseScaleSquared = 1 / (scale * scale);
  const inverse = [
    m[0] * inverseScaleSquared,
    m[4] * inverseScaleSquared,
    m[8] * inverseScaleSquared,
    0,
    m[1] * inverseScaleSquared,
    m[5] * inverseScaleSquared,
    m[9] * inverseScaleSquared,
    0,
    m[2] * inverseScaleSquared,
    m[6] * inverseScaleSquared,
    m[10] * inverseScaleSquared,
    0,
    0,
    0,
    0,
    1,
  ];
  const translation = [m[12], m[13], m[14]];
  inverse[12] = -(
    inverse[0] * translation[0] +
    inverse[4] * translation[1] +
    inverse[8] * translation[2]
  );
  inverse[13] = -(
    inverse[1] * translation[0] +
    inverse[5] * translation[1] +
    inverse[9] * translation[2]
  );
  inverse[14] = -(
    inverse[2] * translation[0] +
    inverse[6] * translation[1] +
    inverse[10] * translation[2]
  );
  return inverse;
}

function transformPoint(matrix, point) {
  return [
    matrix[0] * point[0] +
      matrix[4] * point[1] +
      matrix[8] * point[2] +
      matrix[12],
    matrix[1] * point[0] +
      matrix[5] * point[1] +
      matrix[9] * point[2] +
      matrix[13],
    matrix[2] * point[0] +
      matrix[6] * point[1] +
      matrix[10] * point[2] +
      matrix[14],
  ];
}

export function cameraInAnchorCoordinates(view, matrix) {
  if (!view) return null;
  const inverse = inverseSimilarity(matrix);
  if (!inverse) return null;
  const base =
    matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return {
    ...view,
    viewProj: multiplyMat4(view.viewProj, base),
    position: transformPoint(inverse, view.position),
  };
}

// Resolve the anchor actor and the renderer hosting it. The anchor can live
// in any synced renderer, so the search spans them all; the cached hit is
// revalidated against its cached renderer first.
function findAnchor(entry, renderers) {
  const cached = entry.actor;
  if (
    isLiveInstance(cached) &&
    cached.getMapper?.() === entry.mapper &&
    entry.hostRenderer?.getActors?.().includes(cached) &&
    renderers.includes(entry.hostRenderer)
  ) {
    return { actor: cached, renderer: entry.hostRenderer };
  }
  for (const renderer of renderers) {
    const actor = renderer
      .getActors?.()
      ?.find(
        (candidate) =>
          isLiveInstance(candidate) && candidate.getMapper?.() === entry.mapper,
      );
    if (actor) {
      entry.actor = actor;
      entry.hostRenderer = renderer;
      return { actor, renderer };
    }
  }
  entry.actor = null;
  entry.hostRenderer = null;
  return null;
}

function disposeEntry(entry) {
  entry?.governorMember?.release();
  if (entry) entry.governorMember = null;
  entry?.controller?.dispose();
  entry?.adapter?.dispose();
}

// Block handler for the reconcile engine: `pointCloudLod` block changes land
// here as (nodeId, block|null, instance). `scheduleRender` must be the view's
// coalescing render request.
export function applyPointCloudLodBlock(
  registry,
  nodeId,
  block,
  instance,
  scheduleRender,
) {
  if (!registry || nodeId == null) {
    return registry;
  }
  const id = String(nodeId);
  const existing = registry.get(id);
  const config = normalizeConfig(block);

  if (!config) {
    if (existing) {
      disposeEntry(existing);
      registry.delete(id);
      scheduleRender?.();
    }
    return registry;
  }

  if (existing) {
    existing.mapper = isLiveInstance(instance) ? instance : existing.mapper;
    existing.config = config;
  } else {
    registry.set(id, {
      id,
      mapper: isLiveInstance(instance) ? instance : null,
      actor: null,
      hostRenderer: null,
      config,
      appliedEndpoint: null,
      appliedBudget: null,
      appliedRefinementCutoffPx: null,
      appliedPresentation: null,
      controller: null,
      adapter: null,
      adapterRenderer: null,
      governorMember: null,
    });
  }
  return registry;
}

// Drop the streaming stack so it can rebuild against a new host renderer.
function resetStreaming(entry) {
  entry.governorMember?.release();
  entry.governorMember = null;
  entry.controller?.dispose();
  entry.adapter?.dispose();
  entry.controller = null;
  entry.adapter = null;
  entry.adapterRenderer = null;
  entry.appliedEndpoint = null;
  entry.appliedBudget = null;
  entry.appliedRefinementCutoffPx = null;
  entry.appliedPresentation = null;
}

function updateEntry(registry, entry, renderers, renderWindow, scheduleRender) {
  const { config } = entry;

  const anchor = findAnchor(entry, renderers);
  if (!anchor) {
    // The block can land before the anchor actor is wired to its renderer
    // (block application order inside a message is arbitrary) — retry on the
    // next applied message / interactor render.
    return;
  }
  const { actor, renderer } = anchor;
  // Server-synced actors carry visibility as 0/1 ints, not booleans; only a
  // missing getter defaults to visible. Resolve this before controller
  // construction so an initially hidden cloud does not start hierarchy I/O.
  const anchorVisible = actor.getVisibility?.();
  const drawEnabled = anchorVisible === undefined ? true : !!anchorVisible;

  // Tile actors depth-composite in the anchor's renderer, so an anchor that
  // migrated renderers (the server re-staged the layer) rebuilds the
  // streaming stack in its new home.
  if (entry.adapter && entry.adapterRenderer !== renderer) {
    resetStreaming(entry);
  }
  if (entry.controller && !!entry.governorMember !== !!config.adaptive) {
    resetStreaming(entry);
  }
  if (!entry.adapter) {
    entry.adapter = createRendererAdapter({
      renderer,
      scheduleRender,
      devicePixelRatio: isPositiveFinite(globalThis.devicePixelRatio)
        ? Number(globalThis.devicePixelRatio)
        : 1,
    });
    entry.adapterRenderer = renderer;
  }

  if (entry.appliedEndpoint !== config.endpoint) {
    const source = createHttpTileSource({
      endpoint: config.endpoint,
      metadata: {
        pointCount: config.pointCount,
      },
    });
    if (entry.controller) {
      entry.controller.setSource(source);
    } else {
      entry.controller = createLodController({
        source,
        // Late-bound: the adapter is replaced when the anchor migrates.
        onTiles: (batch) => entry.adapter?.applyBatch(batch),
        scheduleRender,
        presentation: config.presentation,
        onPointDiameterCssPx: (diameterCssPx) =>
          entry.adapter?.setPointDiameterCssPx(diameterCssPx),
        // With adaptive enabled the budget tracks a target frame time (frame
        // durations arrive via recordPointCloudLodFrame) under the shared
        // memory pool's byte cap; the config pointBudget only applies as the
        // fixed budget when adaptive is off.
        active: drawEnabled,
        memory: getSharedMemoryPool(),
        ...(config.pointBudget !== undefined
          ? { pointBudget: config.pointBudget }
          : {}),
        ...(config.refinementCutoffPx !== undefined
          ? { refinementCutoffPx: config.refinementCutoffPx }
          : {}),
      });
      entry.appliedBudget = config.pointBudget ?? null;
      entry.appliedRefinementCutoffPx = config.refinementCutoffPx ?? 1;
      if (config.adaptive) {
        entry.governorMember = getViewGovernor(
          registry,
          config.adaptive,
        ).register({
          active: drawEnabled,
          setPointBudget: (points) => entry.controller?.setPointBudget(points),
        });
      }
    }
    entry.appliedEndpoint = config.endpoint;
    entry.appliedPresentation = config.presentation;
  }

  const budget = config.pointBudget ?? null;
  if (budget !== null && budget !== entry.appliedBudget) {
    entry.controller.setPointBudget(budget);
    entry.appliedBudget = budget;
  }

  const cutoff = config.refinementCutoffPx ?? 1;
  if (cutoff !== entry.appliedRefinementCutoffPx) {
    entry.controller.setRefinementCutoffPx(cutoff);
    entry.appliedRefinementCutoffPx = cutoff;
  }

  if (
    JSON.stringify(entry.appliedPresentation) !==
    JSON.stringify(config.presentation)
  ) {
    entry.controller.setPresentation(config.presentation);
    entry.appliedPresentation = config.presentation;
  }

  const baseMatrix = actor.getUserMatrix?.() ?? null;
  entry.adapter.setBaseMatrix(baseMatrix);
  entry.adapter.setDevicePixelRatio(
    isPositiveFinite(globalThis.devicePixelRatio)
      ? Number(globalThis.devicePixelRatio)
      : 1,
  );
  entry.adapter.setResourceCeilingBytes(
    entry.controller.stats().memoryBudgetBytes,
  );
  // Hidden clouds own no renderer resources. Disable submission before
  // updating the camera; when showing, store the latest camera while inactive
  // and only then reactivate so the first selection uses the current view.
  if (!drawEnabled) entry.controller.setActive(false);
  entry.adapter.setVisible(drawEnabled);
  const view = cameraInAnchorCoordinates(
    readCameraView(renderer, renderWindow),
    baseMatrix,
  );
  if (view) {
    entry.controller.setCamera(view);
  }
  if (drawEnabled) entry.controller.setActive(true);
  const controllerStats = entry.controller.stats();
  entry.governorMember?.update({
    active: drawEnabled,
    projectedImportance: controllerStats.selection.projectedImportance,
  });
}

// Per-render update: feed the camera and mirror anchor-actor state. Called on
// every applied sync message and on interactor renders (camera interaction).
// `renderers` is the view's synced renderers; the anchor (and its tiles) may
// live in any of them.
export function updatePointCloudLods(registry, context) {
  if (!registry || registry.size === 0) {
    return;
  }
  const { renderers, renderWindow, scheduleRender } = context || {};
  if (!renderers?.length || !renderWindow) {
    return;
  }
  for (const entry of registry.values()) {
    updateEntry(
      registry,
      entry,
      renderers,
      renderWindow,
      scheduleRender ?? (() => {}),
    );
  }
}

// Report one painted frame's wall-time (ms) to every anchor's LOD controller,
// feeding the adaptive-quality budget loop (a no-op for controllers without
// adaptive enabled). Called by the view once per render, measuring only the
// paint — not the pre-render camera/LOD update pass.
export function recordPointCloudLodFrame(registry, durationMs) {
  if (!registry || registry.size === 0) {
    return;
  }
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return;
  }
  recordPointCloudLodHostFrame(registry, {
    hostFrameMs: durationMs,
    vtkFrameMs: durationMs,
  });
}

export function recordPointCloudLodHostFrame(registry, metrics) {
  if (!registry || registry.size === 0) return;
  if (!Number.isFinite(metrics?.hostFrameMs) || metrics.hostFrameMs < 0) return;
  viewGovernors.get(registry)?.recordHostFrame(metrics);
}

export function beginPointCloudLodInteraction(registry) {
  if (!registry) return;
  viewGovernors.get(registry)?.beginInteraction();
  for (const entry of registry.values()) entry.controller?.beginInteraction();
}

export function endPointCloudLodInteraction(registry) {
  if (!registry) return;
  viewGovernors.get(registry)?.endInteraction();
  for (const entry of registry.values()) entry.controller?.endInteraction();
}

// --- phase0-bench (removable; see app/telesculptor_web/app/bench/README.md) ---
// Anchor visibility for the diagnostic snapshot: `null` while the anchor actor
// is unresolved, so "hidden" and "unknown" stay distinguishable. Same defensive
// read as updateEntry — server-synced actors carry visibility as 0/1 ints, and
// a missing getter means visible.
function describeAnchorVisibility(entry) {
  const actor = entry?.actor;
  if (!actor) {
    return null;
  }
  const visibility = actor.getVisibility?.();
  return visibility === undefined ? true : !!visibility;
}

// Read-only snapshot of the LOD registry for the diagnostic API. Controller and
// adapter both resolve lazily (after the anchor actor is found), so every read
// tolerates a half-built entry; nothing here mutates controller state.
export function describePointCloudLodRegistry(registry) {
  const entries = [];
  if (!registry) {
    return entries;
  }
  for (const [id, entry] of registry) {
    const anchorVisible = describeAnchorVisibility(entry);
    const adapterStats = entry?.adapter?.stats?.() ?? {
      gpuResidentTiles: 0,
      gpuResidentPoints: 0,
      gpuResidentBytes: 0,
      activeDrawTiles: 0,
      activeDrawPoints: 0,
    };
    entries.push({
      id,
      endpoint: entry?.config?.endpoint ?? null,
      hasController: !!entry?.controller,
      residentActorTiles: adapterStats.gpuResidentTiles,
      gpuResidentTiles: adapterStats.gpuResidentTiles,
      gpuResidentPoints: adapterStats.gpuResidentPoints,
      gpuResidentBytes: adapterStats.gpuResidentBytes,
      anchorVisible,
      activeDrawTiles: adapterStats.activeDrawTiles,
      activeDrawPoints: adapterStats.activeDrawPoints,
      stats: entry?.controller?.stats?.() ?? null,
    });
  }
  return entries;
}
// --- end phase0-bench ---

// Release every anchor's streamed tiles and controllers (view teardown).
export function disposePointCloudLods(registry) {
  if (!registry) {
    return;
  }
  for (const entry of registry.values()) {
    disposeEntry(entry);
  }
  registry.clear();
  viewGovernors.get(registry)?.dispose();
  viewGovernors.delete(registry);
}
