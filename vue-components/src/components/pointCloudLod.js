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
function getSharedMemoryPool() {
  if (!sharedMemoryPool) {
    sharedMemoryPool = createMemoryPool();
  }
  return sharedMemoryPool;
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
  const {
    endpoint,
    rootCube,
    rootSpacing,
    pointCount,
    pointBudget,
    refinementCutoffPx,
  } = block;
  if (
    typeof endpoint !== "string" ||
    !endpoint ||
    !rootCube ||
    !Array.isArray(rootCube.center) ||
    rootCube.center.length !== 3 ||
    !isPositiveFinite(rootCube.halfSize) ||
    !isPositiveFinite(rootSpacing)
  ) {
    return null;
  }
  return {
    endpoint,
    rootCube: {
      center: rootCube.center.map(Number),
      halfSize: Number(rootCube.halfSize),
    },
    rootSpacing: Number(rootSpacing),
    pointCount: Number.isFinite(pointCount) ? Number(pointCount) : 0,
    pointBudget: isPositiveFinite(pointBudget)
      ? Number(pointBudget)
      : undefined,
    refinementCutoffPx:
      Number.isFinite(refinementCutoffPx) && refinementCutoffPx >= 0
        ? Number(refinementCutoffPx)
        : undefined,
    adaptive: normalizeAdaptive(block),
    worldSizeFactor: isPositiveFinite(block.worldSizeFactor)
      ? Number(block.worldSizeFactor)
      : undefined,
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

function getViewportHeight(renderer, renderWindow) {
  const viewport = renderer?.getViewport?.() || [0, 0, 1, 1];
  const size = renderWindow?.getViews?.()?.[0]?.getSize?.();
  if (!size || size.length < 2) {
    return null;
  }
  const height = Math.abs(viewport[3] - viewport[1]) * Number(size[1]);
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
    const width = Math.abs(viewport[2] - viewport[0]) * Number(size[0]);
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
    viewportHeight,
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
      controller: null,
      adapter: null,
      adapterRenderer: null,
    });
  }
  return registry;
}

// Drop the streaming stack so it can rebuild against a new host renderer.
function resetStreaming(entry) {
  entry.controller?.dispose();
  entry.adapter?.dispose();
  entry.controller = null;
  entry.adapter = null;
  entry.adapterRenderer = null;
  entry.appliedEndpoint = null;
  entry.appliedBudget = null;
  entry.appliedRefinementCutoffPx = null;
}

function updateEntry(entry, renderers, renderWindow, scheduleRender) {
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
  if (!entry.adapter) {
    entry.adapter = createRendererAdapter({ renderer, scheduleRender });
    entry.adapterRenderer = renderer;
  }

  if (entry.appliedEndpoint !== config.endpoint) {
    const source = createHttpTileSource({
      endpoint: config.endpoint,
      metadata: {
        pointCount: config.pointCount,
        cube: config.rootCube,
        spacing: config.rootSpacing,
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
        // With adaptive enabled the budget tracks a target frame time (frame
        // durations arrive via recordPointCloudLodFrame) under the shared
        // memory pool's byte cap; the config pointBudget only applies as the
        // fixed budget when adaptive is off.
        adaptive: config.adaptive,
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
    }
    entry.appliedEndpoint = config.endpoint;
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

  // World-space splat sizing: diameter = node spacing x factor. The adapter
  // value-compares, so re-applying per update is a no-op.
  entry.adapter.setWorldSizing(
    config.worldSizeFactor !== undefined
      ? { rootSpacing: config.rootSpacing, factor: config.worldSizeFactor }
      : null,
  );

  entry.adapter.setBaseMatrix(actor.getUserMatrix?.() ?? null);
  // Hidden clouds own no renderer resources. Disable submission before
  // updating the camera; when showing, store the latest camera while inactive
  // and only then reactivate so the first selection uses the current view.
  if (!drawEnabled) entry.controller.setActive(false);
  entry.adapter.setVisible(drawEnabled);
  const pointSize = actor.getProperty?.()?.getPointSize?.();
  if (isPositiveFinite(pointSize)) {
    entry.adapter.setPointSize(pointSize);
  }

  const view = readCameraView(renderer, renderWindow);
  if (view) {
    entry.controller.setCamera(view);
  }
  if (drawEnabled) entry.controller.setActive(true);
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
    updateEntry(entry, renderers, renderWindow, scheduleRender ?? (() => {}));
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
  for (const entry of registry.values()) {
    entry.controller?.recordFrame(durationMs);
  }
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
}
