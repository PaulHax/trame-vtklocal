// Point-cloud LOD anchors: the `pointCloudLod` feature block handler and the
// per-render update pass.
//
// A block arrival creates a registry entry keyed by the anchor mapper's node
// id; the entry lazily builds a pointcloud-lod HttpTileSource + LOD
// controller + renderer adapter once the anchor actor resolves. Resolution
// happens at update time from the mirrored scene graph — the actor node whose
// `mapper` slot names this entry, and the renderer whose `viewProps` carry
// that actor — re-run once per applied sync message, since only a message can
// change the topology. The anchor may live in ANY of the view's synced
// renderers — views layer world geometry, video underlay, and annotations as
// separate VTK renderers — and the streamed tile actors are hosted in the
// same renderer as the anchor so they depth-composite in the anchor's layer.
// Camera state feeds the controller on every applied
// message and interactor render; anchor actor state (UserMatrix correction,
// visibility, point size) fans out to the streamed tile actors on the same
// cadence. Streaming, budgets, cancellation, and caching all live in the
// library — this module is only the wiring.
//
// The entry outlives its streaming stack, never the other way round: an anchor
// that was live and then disappears takes actors, controller and view-budget
// membership with it, leaving the normalized block to rebuild from if it comes
// back. Budget mode and adaptive options are reconciled the same way, as a
// whole, so nothing keeps drawing to a number an older block asked for.
//
// Renders are requested exclusively through the view's coalescing render
// callback; nothing here calls renderWindow.render().
//
// The per-render update also forwards every rendered camera to the governor's
// motion classifier: every camera that reaches LOD passes through here, so
// pointer gestures, locked-video playback, timeline scrubbing, programmatic
// animation and server-applied camera commands are all covered without any of
// them having to announce itself.

import {
  DEFAULTS as LOD_DEFAULTS,
  createHttpTileSource,
  createLodController,
  createMemoryPool,
  createViewGovernor,
} from "pointcloud-lod";
// The renderer adapter lives behind its own entry point: it imports vtk.js at
// module scope, so the core entry stays loadable without the peer.
import { createRendererAdapter } from "pointcloud-lod/vtk";

import { getWorldToClipMatrix } from "./cameraMatrix";
import { isLiveInstance, isPositiveFinite } from "./predicates";
import { getDevicePixelRatio, getViewportMetrics } from "./viewportMetrics";

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

// The view governor belongs to the VIEW, not to a cloud: one adaptive budget
// split across every adaptive cloud drawing into it. It is created with the
// first adaptive cloud and disposed with the last; a wire block that changes
// the options reconfigures the instance in place (`setOptions`), so
// memberships and motion references ride through options changes untouched.
const viewGovernors = new WeakMap();

function viewGovernorOf(registry) {
  return viewGovernors.get(registry) ?? null;
}

// What a cloud draws when its block configures neither an explicit point budget
// nor adaptive quality. Stated here rather than left to the library's default so
// that dropping `pointBudget` from a block lands on one known number instead of
// whatever the previous block happened to leave applied.
const DEFAULT_POINT_BUDGET = 2_000_000;

// The library rejects an adaptive maximum below the adaptive floor, and it
// throws rather than clamping. The bridge therefore always states the floor it
// wants, so an out-of-order pair is rejected while normalizing the block rather
// than thrown from the middle of a render pass. The floor itself is the
// library's, imported rather than restated: a copy here would accept a
// maximum the library then throws on the moment the policy moves.
const DEFAULT_ADAPTIVE_MIN_BUDGET = LOD_DEFAULTS.minBudget;

// One slot per explicit gesture the view is holding. Slots rather than bare
// references because the governor can be created or disposed mid-gesture, and
// a governor created mid-gesture has to inherit what the view was holding.
// Inferred (rendered-camera) motion is the library's: the governor classifies
// the cameras this module forwards. That classification is non-reporting by
// construction — it compares cameras the host has already rendered, so
// nothing there can echo a server-provided camera back upstream as a user
// camera report.
const explicitMotionSlots = new WeakMap();

// The adaptive quality options travel with a cloud but configure the view's
// governor, which takes them as construction options and throws on an unusable
// one rather than clamping it. So they are validated here under the library's
// own policy — targets strictly positive, budgets whole and ordered — and a
// block carrying an unusable one is as unusable as a block with no endpoint.
// Absent fields stay absent so the library's defaults apply.
function normalizeAdaptiveOptions(block) {
  const raw = block.adaptiveOptions ?? {};
  if (typeof raw !== "object") {
    return null;
  }
  const stated = (value) =>
    value === undefined || value === null ? undefined : Number(value);
  const statedWhole = (value) => {
    const number = stated(value);
    return number === undefined ? undefined : Math.floor(number);
  };
  const stationaryTargetMs = stated(raw.stationaryTargetMs);
  const interactionTargetMs = stated(raw.interactionTargetMs);
  const minBudget = statedWhole(raw.minBudget) ?? DEFAULT_ADAPTIVE_MIN_BUDGET;
  const maxBudget = statedWhole(raw.maxBudget);
  const usable =
    (stationaryTargetMs === undefined ||
      isPositiveFinite(stationaryTargetMs)) &&
    (interactionTargetMs === undefined ||
      isPositiveFinite(interactionTargetMs)) &&
    isPositiveFinite(minBudget) &&
    // Finiteness is checked here and not only in the library because the
    // library checks by throwing — from the middle of a render pass, taking
    // the whole scene sync down with it. `Infinity >= minBudget` is true, and
    // `Math.floor(Infinity)` is still `Infinity`, so without this test an
    // unbounded maximum sails through normalization.
    (maxBudget === undefined ||
      (isPositiveFinite(maxBudget) && maxBudget >= minBudget));
  return usable
    ? { minBudget, maxBudget, stationaryTargetMs, interactionTargetMs }
    : null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value ? value : null;
}

function normalizeConfig(block) {
  if (!block || typeof block !== "object") {
    return null;
  }
  const { endpoint, pointCount, pointBudget, refinementCutoffPx } = block;
  // The durable source identity and its revision are what scoped picking
  // matches queries against and echoes back as provenance; a block that
  // cannot say who it is cannot honestly answer "was that pick against you".
  const sourceAssetId = nonEmptyString(block.sourceAssetId);
  const revision = nonEmptyString(block.revision);
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
  const adaptiveOptions = normalizeAdaptiveOptions(block);
  if (
    typeof endpoint !== "string" ||
    !endpoint ||
    !sourceAssetId ||
    !revision ||
    !presentation ||
    !adaptiveOptions
  ) {
    return null;
  }
  return {
    sourceAssetId,
    revision,
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
    adaptive: !!block.adaptive,
    adaptiveOptions,
  };
}

// The xyz norm of one row of a world-to-clip matrix in the column-major
// layout getWorldToClipMatrix returns (`index = column * 4 + row`).
function rowNorm(m, row) {
  return Math.hypot(m[row], m[row + 4], m[row + 8]);
}

// Below this ratio of the w row to the vertical row, the projection is read
// as parallel. A perspective matrix's w row carries the view scale and its
// vertical row carries scale times cot(fovY/2), so the ratio is cot(fovY/2)
// whatever the scale — reaching 1e6 would mean a field of view of
// microdegrees, which no real camera produces, while a parallel projection's
// w row is exactly zero.
const PERSPECTIVE_W_RATIO_FLOOR = 1e-6;

// The projection mode and sizing scalar are read from the rendered matrix
// itself, never from camera state: a host that pushes a projection matrix
// every frame (the map layer does) leaves `parallelProjection`, `viewAngle`
// and `parallelScale` describing a camera vtk.js is not rendering, and the
// library projects a world spacing to pixels by a different law per mode.
// From the matrix, both scalars come out in exactly the form the library's
// SSE math needs, with any uniform view scale cancelled:
//
//   - perspective: |w row| / |y row| = tan(fovY/2) of what is rendered;
//   - parallel:    |y row| is NDC-per-world-unit, so 1 / |y row| is the
//     effective parallelScale.
//
// A camera whose matrix yields no usable scalar produces no view at all,
// leaving the controller on its last good camera.
export function readCameraView(renderer, renderWindow) {
  const camera = renderer?.getActiveCamera?.();
  const metrics = getViewportMetrics(renderer, renderWindow);
  if (!camera || !metrics) {
    return null;
  }
  // The library's frustum math wants the column-major world-to-clip layout.
  const viewProj = getWorldToClipMatrix(camera, metrics.aspect);
  const position = camera.getPosition?.();
  if (!viewProj || !position) {
    return null;
  }
  const common = {
    viewProj,
    position: [position[0], position[1], position[2]],
    viewportWidthCssPx: metrics.width,
    viewportHeightCssPx: metrics.height,
  };
  const verticalNorm = rowNorm(viewProj, 1);
  const wNorm = rowNorm(viewProj, 3);
  if (!isPositiveFinite(verticalNorm)) return null;
  if (wNorm > verticalNorm * PERSPECTIVE_W_RATIO_FLOOR) {
    const fovY = 2 * Math.atan(wNorm / verticalNorm);
    if (!isPositiveFinite(fovY)) return null;
    return { ...common, projection: "perspective", fovY };
  }
  const parallelScale = 1 / verticalNorm;
  if (!isPositiveFinite(parallelScale)) return null;
  return { ...common, projection: "orthographic", parallelScale };
}

// Scoped point pick against ONE streamed cloud, addressed by its durable
// sourceAssetId (never the tile-service id inside the endpoint, never "the
// frontmost cloud"). Returns the wire-shaped solve:
//
//   { status: "hit", asset_id, revision, nodes, world, distance_px }
//   { status: "miss", asset_id, revision, nodes }
//   null — unavailable: unknown or duplicate identity, unresolved anchor,
//   hidden cloud, non-drawing host renderer, unreadable camera, or a
//   non-similarity anchor transform.
//
// Only the explicit miss authorizes a caller's fallback, so every doubtful
// state must land on null rather than an empty sweep. The provenance fields
// are read from the matched entry, never echoed from the request: a caller
// comparing them against what it asked for is verifying the query really ran
// against the cloud it named.
//
// The anchor's live UserMatrix is read per query and handed to the
// controller as its model matrix before solving, so the sweep runs under the
// transform the user is looking at and the hit comes back in world
// coordinates — display scene-local ENU even while a correction preview is
// mid-flight.
export function pickPointCloudPoint(
  registry,
  sourceAssetId,
  cssXPx,
  cssYPx,
  context,
) {
  if (!registry) return null;
  const requested = nonEmptyString(sourceAssetId);
  if (!requested) return null;
  let entry = null;
  for (const candidate of registry.values()) {
    if (candidate?.config?.sourceAssetId !== requested) continue;
    // Two entries claiming one identity means "which cloud?" has no honest
    // answer; refusing beats silently solving against whichever came first.
    if (entry) return null;
    entry = candidate;
  }
  if (!entry?.controller) return null;
  // The anchor established by the update pass, revalidated: the pick must
  // run in the renderer hosting the anchor (its camera is the one the tiles
  // are drawn under), never an arbitrary primary renderer.
  const { actor, hostRenderer } = entry;
  if (!anchorStillValid(entry)) return null;
  if (!actorIsVisible(actor)) return null;
  // A renderer taken out of the draw pass hides everything it hosts just as
  // thoroughly as actor visibility does; what the user cannot see must not
  // support a depth (a missing getter means drawing, like a missing
  // visibility getter means visible).
  const rendererDraws = hostRenderer.getDraw?.();
  if (rendererDraws !== undefined && !rendererDraws) return null;
  // The transform the pick is solved through rides the ACTOR, while the LOD
  // block (and so `entry.id`) rides its mapper. The client resolved that
  // pairing to read the matrix, so it can name both nodes in the solve's
  // staleness list — the consumer checks them without rediscovering the
  // mapper/actor association in its own copy of the scene.
  const transformNodeId = context?.synchronizerContext?.getInstanceId?.(actor);
  if (transformNodeId === null || transformNodeId === undefined) return null;
  entry.controller.setModelMatrix(actor.getUserMatrix?.() ?? null);
  const view = readCameraView(hostRenderer, context?.renderWindow);
  if (!view) return null;
  // The caller measures the cursor on the canvas; the library sweeps in the
  // host renderer's own viewport (top-left origin, spanning its css size).
  // A non-full viewport makes those different spaces, so shift by the
  // viewport's canvas-css origin before querying.
  const metrics = getViewportMetrics(hostRenderer, context?.renderWindow);
  if (!metrics) return null;
  const result = entry.controller.pickPoint(
    view,
    cssXPx - metrics.leftCssPx,
    cssYPx - metrics.topCssPx,
  );
  if (!result) return null;
  const provenance = {
    asset_id: entry.config.sourceAssetId,
    revision: entry.config.revision,
    // The scene nodes this solve was measured through, named by the client the
    // same way a glyph pick names its own: the mapper carrying the LOD block
    // that was swept, and the actor carrying the transform the result was
    // converted through.
    nodes: [String(entry.id), String(transformNodeId)],
  };
  if (result.status !== "hit") {
    return { status: "miss", ...provenance };
  }
  return {
    status: "hit",
    ...provenance,
    world: result.pointOnRay,
    distance_px: result.distancePx,
  };
}

// The gesture payload types whose pointer is a ray the server would otherwise
// resolve against cloud depth. Hover enter/leave never solve: they fire per
// pointer move with no depth semantics.
const CLOUD_SOLVE_GESTURE_TYPES = new Set([
  "target.drag.start",
  "target.drag.move",
  "target.drag.end",
  "target.click",
]);

// The click-family payloads an armed pick spec governs. Drags stay tag-based:
// a drag's depth target is the glyph being dragged, never an app-armed cloud.
const ARMED_CLOUD_SOLVE_GESTURE_TYPES = new Set([
  "target.click",
  "background.click",
]);

// The cloud-depth enrichment policy for completed gesture payloads: attach a
// scoped solve as `cloud_solve` when — and only when — the gesture is tagged
// with a `depth_asset_id`, carries a resolved pointer (post grab-offset), and
// is neither cancelled nor unresolved. Everything else passes through
// untouched, so a terminal end without a pointer can never read as an
// explicit miss downstream — a miss authorizes fallback, absence holds.
// An unavailable scoped query (pickCloudPoint → null) also leaves the payload
// untouched for the same reason.
//
// While `armedAssetId` is set it is AUTHORITATIVE for clicks: a target.click
// solves against the armed cloud even when the glyph under the cursor is
// tagged with a different `depth_asset_id`, and a background.click (pick:
// null, so never tagged) solves too. Disarmed (null), clicks degrade exactly
// to the tag-based read above — an absent spec is not a miss.
export function enrichGestureWithCloudSolve(
  payload,
  pickCloudPoint,
  armedAssetId = null,
) {
  if (!payload) return payload;
  const armed =
    armedAssetId != null && ARMED_CLOUD_SOLVE_GESTURE_TYPES.has(payload.type);
  if (!armed && !CLOUD_SOLVE_GESTURE_TYPES.has(payload.type)) return payload;
  if (payload.cancelled || payload.unresolved || !payload.pointer) {
    return payload;
  }
  const assetId = armed ? armedAssetId : payload.pick?.tags?.depth_asset_id;
  if (assetId == null) return payload;
  const solve = pickCloudPoint(assetId, payload.pointer.x, payload.pointer.y);
  return solve ? { ...payload, cloud_solve: solve } : payload;
}

// Whether the cached anchor is still the live actor this entry streams into:
// the same live instance, still bound to the entry's mapper. The update pass
// and the pick query must agree on what makes an anchor valid — a pick solved
// against an actor the scene no longer uses is not a pick of what the user
// sees — so both read this one predicate. Renderer membership needs no
// per-frame check: actor/renderer topology only changes when a sync message
// is applied, and every applied message re-resolves the anchor.
function anchorStillValid(entry) {
  const actor = entry?.actor;
  return Boolean(isLiveInstance(actor) && actor.getMapper?.() === entry.mapper);
}

// Server-synced actors carry visibility as 0/1 ints, not booleans; only a
// missing getter defaults to visible.
function actorIsVisible(actor) {
  const visibility = actor?.getVisibility?.();
  return visibility === undefined ? true : !!visibility;
}

// The wire already states the anchor pairing: exactly one mirrored actor node
// carries this entry's node in its `mapper` slot, and the renderer hosting it
// lists that actor among its `viewProps`. Resolution is a lookup against that
// statement — never a scan of live renderer actor lists, which are dominated
// by this module's own streamed tile actors.
function resolveAnchor(entry, context) {
  const { referrersOf, getInstance, renderers } = context;
  if (!referrersOf || !getInstance) return null;
  for (const actorNodeId of referrersOf(entry.id, "mapper")) {
    const actor = getInstance(actorNodeId);
    if (!isLiveInstance(actor) || actor.getMapper?.() !== entry.mapper) {
      continue;
    }
    for (const rendererNodeId of referrersOf(actorNodeId, "viewProps")) {
      const renderer = getInstance(rendererNodeId);
      if (renderer && renderers.includes(renderer)) {
        return { actor, renderer };
      }
    }
  }
  return null;
}

// The anchor actor and the renderer hosting it, resolved once per applied
// sync message: `context.topologyVersion` advances with each applied message,
// and interactor renders in between cannot move an actor between renderers,
// so passes within one version reuse the cached association. A context
// without a version (no gating information) resolves every pass.
function findAnchor(entry, context) {
  const version = Number.isFinite(context.topologyVersion)
    ? context.topologyVersion
    : null;
  if (version === null || entry.anchorVersion !== version) {
    const anchor = resolveAnchor(entry, context);
    entry.anchorVersion = version;
    entry.actor = anchor?.actor ?? null;
    entry.hostRenderer = anchor?.renderer ?? null;
  }
  return anchorStillValid(entry)
    ? { actor: entry.actor, renderer: entry.hostRenderer }
    : null;
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
      resetStreaming(existing);
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
      anchorVersion: null,
      config,
      appliedEndpoint: null,
      appliedBudget: null,
      controller: null,
      adapter: null,
      adapterRenderer: null,
      governorMember: null,
    });
  }
  return registry;
}

// Drop the streaming stack — actors, controller, governor membership — leaving
// only the normalized configuration the entry rebuilds from. Its absence is
// also what tells updateEntry that this entry has no established anchor.
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
}

// Which of the three budget modes the block asks for — adaptive governor
// allocation, an explicit fixed number, or the bridge's default — reconciled as
// a whole, because leaving any of them half-applied means a cloud drawing to a
// number no live configuration asked for. Nothing here rebuilds the streaming
// stack: a budget is just the number the controller re-selects against, so
// dropping resident tiles to change it would blank the view for no gain.
function reconcileBudgetMode(registry, entry, drawEnabled) {
  const { config } = entry;
  if (config.adaptive && !entry.governorMember) {
    // Registering distributes, so the governor's allocation reaches the
    // controller inside this pass rather than after the next frame report.
    entry.governorMember =
      viewGovernorOf(registry)?.register({
        id: entry.id,
        active: drawEnabled,
        setPointBudget: (points) => entry.controller?.setPointBudget(points),
        setDensityFraction: (fraction) =>
          entry.controller?.setDensityFraction(fraction),
      }) ?? null;
    // The governor owns the number now; forget ours so leaving adaptive
    // re-applies a fixed budget over whatever it last allocated.
    entry.appliedBudget = null;
  } else if (!config.adaptive && entry.governorMember) {
    entry.governorMember.release();
    entry.governorMember = null;
  }
  if (config.adaptive) {
    // The draw state reaches the governor before the controller acts on it: a
    // share that arrives after reactivation leaves the first selection of a
    // revealed cloud running against a budget nobody granted it.
    entry.governorMember?.update({ active: drawEnabled });
    return;
  }
  const budget = config.pointBudget ?? DEFAULT_POINT_BUDGET;
  if (budget !== entry.appliedBudget) {
    entry.controller.setPointBudget(budget);
    entry.appliedBudget = budget;
  }
}

// `worldViewFor(renderer)` is the pass's rendered camera for that renderer,
// read once and shared with the motion classifier.
function updateEntry(registry, entry, context, worldViewFor, scheduleRender) {
  const { config } = entry;

  const anchor = findAnchor(entry, context);
  if (!anchor) {
    // Two situations reach here and only one of them is a retry. A block can
    // land before its anchor actor is wired to a renderer (block application
    // order inside a message is arbitrary), and that resolves on a later pass.
    // An anchor that WAS established and is now gone is different: its tiles
    // would keep drawing into a renderer the scene no longer anchors, and its
    // governor membership would keep claiming a share of the view budget. Tear
    // that down to the configuration and rebuild if the anchor comes back.
    if (entry.adapter) {
      resetStreaming(entry);
      scheduleRender();
    }
    return;
  }
  const { actor, renderer } = anchor;
  // Resolve visibility before controller construction so an initially hidden
  // cloud does not start hierarchy I/O.
  const drawEnabled = actorIsVisible(actor);

  // Tile actors depth-composite in the anchor's renderer, so an anchor that
  // migrated renderers (the server re-staged the layer) rebuilds the
  // streaming stack in its new home.
  if (entry.adapter && entry.adapterRenderer !== renderer) {
    resetStreaming(entry);
  }
  if (!entry.adapter) {
    entry.adapter = createRendererAdapter({
      renderer,
      scheduleRender,
      devicePixelRatio: getDevicePixelRatio(),
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
        onDrawPlan: (plan) => entry.adapter?.applyDrawPlan(plan),
        scheduleRender,
        presentation: config.presentation,
        onPointDiameterCssPx: (diameterCssPx) =>
          entry.adapter?.setPointDiameterCssPx(diameterCssPx),
        // No pointBudget here: reconcileBudgetMode below owns that number in
        // every mode, and it runs before the first camera reaches the
        // controller, so nothing is ever selected against a budget the wire
        // block did not ask for.
        active: drawEnabled,
        memory: getSharedMemoryPool(),
        ...(config.refinementCutoffPx !== undefined
          ? { refinementCutoffPx: config.refinementCutoffPx }
          : {}),
      });
    }
    entry.appliedEndpoint = config.endpoint;
  }

  reconcileBudgetMode(registry, entry, drawEnabled);

  // Both setters no-op on an unchanged value inside the library.
  entry.controller.setRefinementCutoffPx(config.refinementCutoffPx ?? 1);
  entry.controller.setPresentation(config.presentation);

  const baseMatrix = actor.getUserMatrix?.() ?? null;
  entry.adapter.setBaseMatrix(baseMatrix);
  // The controller owns the camera restatement the anchor transform needs;
  // this side only reads the matrix off the actor and hands it over.
  entry.controller.setModelMatrix(baseMatrix);
  entry.adapter.setDevicePixelRatio(getDevicePixelRatio());
  // Hiding stops the draw at once; disable submission before updating the
  // camera, and when showing store the latest camera while inactive and only
  // then reactivate, so the first selection uses the current view.
  if (!drawEnabled) entry.controller.setActive(false);
  entry.adapter.setVisible(drawEnabled);
  const view = worldViewFor(renderer);
  if (view) {
    entry.controller.setCamera(view);
  }
  if (drawEnabled) entry.controller.setActive(true);
  const controllerStats = entry.controller.stats();
  // Read after the active state settles: a ceiling taken while the cloud was
  // still inactive is zero, which would throw away the very reuse pool the
  // reactivation is about to draw from — and leaves a hidden cloud's retired
  // actors alive instead of releasing them.
  entry.adapter.setResourceCeilingBytes(controllerStats.memoryBudgetBytes);
  // The governor needs the memory ceiling to bound the aggregate before it
  // splits it, and the physical work counts to know whether another frame is
  // still worth painting.
  entry.governorMember?.update({
    active: drawEnabled,
    projectedImportance: controllerStats.selection.projectedImportance,
    memoryCeilingPoints: controllerStats.memoryCeilingPoints,
    physicalTileOperations: controllerStats.physicalTileOperations,
    physicalHierarchyOperations: controllerStats.physicalHierarchyOperations,
  });
}

// The options the view's governor must be running on: those of the first
// adaptive cloud in registry order, or null when no cloud asks for adaptive
// quality at all. One governor serves the whole view, so clouds that disagree
// need one stable answer — resolving per cloud would rebuild the governor once
// per cloud on every pass.
function desiredGovernorOptions(registry) {
  for (const entry of registry.values()) {
    if (entry.config?.adaptive) return entry.config.adaptiveOptions;
  }
  return null;
}

// Motion is a property of the view, so a governor created or disposed
// mid-drag inherits the explicit gestures the view is holding — otherwise the
// boundary would read as the camera having stopped and quality would jump
// mid-gesture. Inferred motion needs no equivalent: its baselines and burst
// reference live inside the governor itself. Options changes never come
// through here: the governor absorbs those in place, references intact.
function retakeMotionReferences(registry, governor) {
  for (const slot of explicitMotionSlots.get(registry) ?? []) {
    slot.reference?.release();
    slot.reference = governor?.beginMotion("explicit") ?? null;
  }
}

// The governor exists exactly while the view has an adaptive cloud. Options
// from a changed wire block are forwarded as-is — the library treats an
// equivalent bag as a no-op — so only the create and dispose boundaries have
// any ceremony: memberships belong to the instance that issued them, and the
// dispose path releases them so no cloud keeps drawing to a share of a
// governor that no longer exists.
function reconcileViewGovernor(registry, motionDebounceMs) {
  const adaptive = desiredGovernorOptions(registry);
  // `context.motionDebounceMs` exists so a test can shorten the inferred
  // burst debounce; nothing in the component chain supplies one, so every
  // view runs on the library's own default.
  const options =
    adaptive !== null &&
    Number.isFinite(motionDebounceMs) &&
    motionDebounceMs >= 0
      ? { ...adaptive, motionDebounceMs }
      : adaptive;
  const current = viewGovernors.get(registry) ?? null;
  if (options !== null && current) {
    current.setOptions(options);
    return;
  }
  if (options === null && !current) return;
  if (current) {
    for (const entry of registry.values()) {
      if (!entry.governorMember) continue;
      entry.governorMember.release();
      entry.governorMember = null;
      // The released allocation belonged to the disposed instance, so
      // whichever mode this entry lands in has to state its budget again.
      entry.appliedBudget = null;
    }
    current.dispose();
    viewGovernors.delete(registry);
    retakeMotionReferences(registry, null);
    return;
  }
  const governor = createViewGovernor(options);
  viewGovernors.set(registry, governor);
  retakeMotionReferences(registry, governor);
}

// Per-render update: feed the camera and mirror anchor-actor state. Called on
// every applied sync message and on interactor renders (camera interaction).
// `renderers` is the view's synced renderers; the anchor (and its tiles) may
// live in any of them.
export function updatePointCloudLods(registry, context) {
  if (!registry) {
    return;
  }
  const { renderers, renderWindow, scheduleRender, motionDebounceMs } =
    context || {};
  // Before anything else, including the early returns: entries must register
  // against the governor the current wire blocks describe and never one built
  // from an older block — and a view that has lost its last adaptive cloud must
  // lose the governor too, or it goes on asking for frames for nobody.
  reconcileViewGovernor(registry, motionDebounceMs);
  if (registry.size === 0 || !renderers?.length || !renderWindow) {
    // No cloud is being selected for, so nothing this pass could see is a
    // camera baseline; forget the old ones so the first camera after a cloud
    // comes back is a baseline again, exactly as on a fresh view.
    viewGovernorOf(registry)?.resetMotionBaselines();
    return;
  }
  const render = scheduleRender ?? (() => {});
  // The cameras this pass actually hands to LOD, one entry per host renderer:
  // the governor's classifier compares them against the previous pass, and
  // reading each renderer once keeps the matrix work off the per-entry path.
  const views = new Map();
  const worldViewFor = (renderer) => {
    if (!views.has(renderer)) {
      views.set(renderer, readCameraView(renderer, renderWindow));
    }
    return views.get(renderer);
  };
  for (const entry of registry.values()) {
    updateEntry(registry, entry, context, worldViewFor, render);
  }
  // After the loop, which is what fills the view map.
  viewGovernorOf(registry)?.noteRenderedCameras(views, render);
}

// Report one frame's wall-time (ms) to the view governor, feeding the
// adaptive-quality budget loop (a no-op when no controller has adaptive
// enabled). `hostFrameMs` is the whole frame; `vtkFrameMs` only the paint.
export function recordPointCloudLodHostFrame(registry, metrics) {
  if (!registry || registry.size === 0) return;
  if (!Number.isFinite(metrics?.hostFrameMs) || metrics.hostFrameMs < 0) return;
  viewGovernorOf(registry)?.recordHostFrame(metrics);
}

// The view's adaptive budget as the governor sees it: the regime, what is
// holding it (explicit gestures, inferred camera motion, or both), the target
// frame time, the ceilings, and the split across clouds. Null while no cloud in
// the view asks for adaptive quality, since that is when the view has no
// governor at all.
export function describePointCloudLodGovernor(registry) {
  if (!registry) return null;
  return viewGovernorOf(registry)?.stats() ?? null;
}

// Whether the view still owes the user another frame: the governor never
// schedules, so the host paints, reports the frame, and asks this.
export function pointCloudLodNeedsFrame(registry) {
  if (!registry) return false;
  return viewGovernorOf(registry)?.needsFrame() ?? false;
}

// The governor counts motion references rather than begin/end pairs, so each
// begin keeps its own slot and the matching end releases that slot. A stack,
// because interactions nest; a slot holding a nullable reference, because a
// gesture can outlive the governor it started against — or start before the
// view has one.
export function beginPointCloudLodInteraction(registry) {
  if (!registry) return;
  const held = explicitMotionSlots.get(registry) ?? [];
  held.push({
    reference: viewGovernorOf(registry)?.beginMotion("explicit") ?? null,
  });
  explicitMotionSlots.set(registry, held);
  for (const entry of registry.values()) entry.controller?.beginInteraction();
}

export function endPointCloudLodInteraction(registry) {
  if (!registry) return;
  explicitMotionSlots.get(registry)?.pop()?.reference?.release();
  for (const entry of registry.values()) entry.controller?.endInteraction();
}

// Anchor visibility for the diagnostic snapshot: `null` while the anchor actor
// is unresolved, so "hidden" and "unknown" stay distinguishable. Same defensive
// read as updateEntry — server-synced actors carry visibility as 0/1 ints, and
// a missing getter means visible.
function describeAnchorVisibility(entry) {
  return entry?.actor ? actorIsVisible(entry.actor) : null;
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
    // Resident vs drawn are different questions — a hidden cloud keeps its
    // actors so showing it again is a state restore — so both are reported
    // under the library's own names.
    const adapterStats = entry?.adapter?.stats?.() ?? {
      gpuResidentTiles: 0,
      gpuResidentPoints: 0,
      gpuResidentBytes: 0,
      drawnTiles: 0,
      drawnPoints: 0,
    };
    entries.push({
      id,
      endpoint: entry?.config?.endpoint ?? null,
      hasController: !!entry?.controller,
      gpuResidentTiles: adapterStats.gpuResidentTiles,
      gpuResidentPoints: adapterStats.gpuResidentPoints,
      gpuResidentBytes: adapterStats.gpuResidentBytes,
      anchorVisible,
      drawnTiles: adapterStats.drawnTiles,
      drawnPoints: adapterStats.drawnPoints,
      stats: entry?.controller?.stats?.() ?? null,
    });
  }
  return entries;
}

// Release every anchor's streamed tiles and controllers (view teardown).
export function disposePointCloudLods(registry) {
  if (!registry) {
    return;
  }
  for (const entry of registry.values()) {
    resetStreaming(entry);
  }
  registry.clear();
  // Hand the references back before dropping the slots holding them. The
  // governor is disposed on the next line, which makes the counts moot — but
  // "we release everything we took" has to be true of this teardown on its own
  // terms, not because of what the line after it happens to do.
  for (const slot of explicitMotionSlots.get(registry) ?? []) {
    slot.reference?.release();
    slot.reference = null;
  }
  explicitMotionSlots.delete(registry);
  viewGovernorOf(registry)?.dispose();
  viewGovernors.delete(registry);
}
