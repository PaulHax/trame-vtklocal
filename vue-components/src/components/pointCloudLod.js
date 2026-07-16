// Point-cloud LOD anchors: the `pointCloudLod` feature block handler and the
// per-render update pass.
//
// A block arrival creates a registry entry keyed by the anchor mapper's node
// id; the entry lazily builds a vtk-pointcloud-lod HttpTileSource + LOD
// controller + renderer adapter once a renderer is available (renderer/actor
// access resolves lazily at update time, mirroring distanceToCameraGlyphs:
// block application order inside a message is arbitrary, so the anchor actor
// may not be wired to the renderer yet when the block lands). Camera state
// feeds the controller on every applied message and interactor render; anchor
// actor state (UserMatrix correction, visibility, point size) fans out to the
// streamed tile actors on the same cadence. Streaming, budgets, cancellation,
// and caching all live in the library — this module is only the wiring.
//
// Renders are requested exclusively through the view's coalescing render
// callback; nothing here calls renderWindow.render().

import {
  createHttpTileSource,
  createLodController,
  createRendererAdapter,
} from "vtk-pointcloud-lod";

import { isLiveInstance } from "./vtkJsSync";

export const POINT_CLOUD_LOD_BLOCK_KEY = "pointCloudLod";

const DEG_TO_RAD = Math.PI / 180;

function isPositiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

function normalizeConfig(block) {
  if (!block || typeof block !== "object") {
    return null;
  }
  const { endpoint, rootCube, rootSpacing, pointCount, pointBudget } = block;
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
    pointBudget: isPositiveFinite(pointBudget) ? Number(pointBudget) : undefined,
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
    fovY: (Number.isFinite(viewAngle) && viewAngle > 0 ? viewAngle : 30) * DEG_TO_RAD,
    viewportHeight,
  };
}

function findAnchorActor(entry, renderer) {
  const cached = entry.actor;
  if (
    isLiveInstance(cached) &&
    cached.getMapper?.() === entry.mapper &&
    renderer.getActors?.().includes(cached)
  ) {
    return cached;
  }
  entry.actor =
    renderer
      .getActors?.()
      ?.find(
        (actor) => isLiveInstance(actor) && actor.getMapper?.() === entry.mapper,
      ) ?? null;
  return entry.actor;
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
      config,
      appliedEndpoint: null,
      appliedBudget: null,
      controller: null,
      adapter: null,
    });
  }
  return registry;
}

function updateEntry(entry, renderer, renderWindow, scheduleRender) {
  const { config } = entry;

  if (!entry.adapter) {
    entry.adapter = createRendererAdapter({ renderer, scheduleRender });
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
      const adapter = entry.adapter;
      entry.controller = createLodController({
        source,
        onTiles: (batch) => adapter.applyBatch(batch),
        scheduleRender,
        ...(config.pointBudget !== undefined
          ? { pointBudget: config.pointBudget }
          : {}),
      });
      entry.appliedBudget = config.pointBudget ?? null;
    }
    entry.appliedEndpoint = config.endpoint;
  }

  const budget = config.pointBudget ?? null;
  if (budget !== null && budget !== entry.appliedBudget) {
    entry.controller.setPointBudget(budget);
    entry.appliedBudget = budget;
  }

  const actor = findAnchorActor(entry, renderer);
  if (actor) {
    entry.adapter.setBaseMatrix(actor.getUserMatrix?.() ?? null);
    // Server-synced actors carry visibility as 0/1 ints, not booleans; only
    // a missing getter defaults to visible.
    const anchorVisible = actor.getVisibility?.();
    entry.adapter.setVisible(anchorVisible === undefined ? true : !!anchorVisible);
    const pointSize = actor.getProperty?.()?.getPointSize?.();
    if (isPositiveFinite(pointSize)) {
      entry.adapter.setPointSize(pointSize);
    }
  }

  const view = readCameraView(renderer, renderWindow);
  if (view) {
    entry.controller.setCamera(view);
  }
}

// Per-render update: feed the camera and mirror anchor-actor state. Called on
// every applied sync message and on interactor renders (camera interaction).
export function updatePointCloudLods(registry, context) {
  if (!registry || registry.size === 0) {
    return;
  }
  const { renderer, renderWindow, scheduleRender } = context || {};
  if (!renderer || !renderWindow) {
    return;
  }
  for (const entry of registry.values()) {
    updateEntry(entry, renderer, renderWindow, scheduleRender ?? (() => {}));
  }
}

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
