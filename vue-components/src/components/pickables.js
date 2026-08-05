// Client-side pick registry for server-tagged glyph mappers.
//
// The server marks a vtkGlyph3DMapper pickable (see interaction.py) and stamps
// an opaque `pickable` block onto its node. The reconcile engine routes that
// block here (`applyPickableBlock`); this module tracks the tagged mappers and
// answers `pickAt(x, y)` from what the client actually rendered: it projects
// the mapper's live glyph points through the active camera's composite
// projection and returns the nearest point within its grab radius.
//
// The block (`tags`, `ids`, `grabPx`, `priority`) is opaque here — the fork
// never interprets tag meaning; it round-trips them verbatim in the result.

import { getWorldToClipMatrix } from "./cameraMatrix";
import { isLiveInstance, isPositiveFinite } from "./predicates";
import { getViewportMetrics } from "./viewportMetrics";

export const PICKABLE_BLOCK_KEY = "pickable";

const BEHIND_CAMERA_EPSILON = 1e-9;

export function createPickableRegistry() {
  return new Map();
}

function normalizeConfig(config) {
  if (!config || typeof config !== "object") {
    return null;
  }

  const grabPx = Number(config.grabPx);
  if (!isPositiveFinite(grabPx)) {
    return null;
  }

  const priority = Number(config.priority);
  const preview = ["screen", "plane"].includes(config.preview)
    ? config.preview
    : null;
  const plane =
    preview === "plane" &&
    Array.isArray(config.plane?.origin) &&
    Array.isArray(config.plane?.normal)
      ? {
          origin: Array.from(config.plane.origin, Number),
          normal: Array.from(config.plane.normal, Number),
        }
      : null;
  return {
    tags: config.tags && typeof config.tags === "object" ? config.tags : {},
    ids: Array.isArray(config.ids) ? config.ids : null,
    grabPx,
    priority: Number.isFinite(priority) ? priority : 0,
    preview: preview === "plane" && !plane ? null : preview,
    plane,
  };
}

// A cheap config fingerprint so a re-sync with unchanged tags/ids/radius keeps
// the existing entry (and its resolved mapper) instead of churning it.
function configSignature(config) {
  return [
    config.grabPx,
    config.priority,
    config.ids ? config.ids.join(",") : "",
    JSON.stringify(config.tags),
    config.preview || "",
    JSON.stringify(config.plane),
  ].join("|");
}

// Block handler for the reconcile engine: `pickable` block changes land here
// as (nodeId, block|null, instance). A null/invalid block drops the entry.
export function applyPickableBlock(registry, nodeId, block, instance) {
  if (!registry || nodeId == null) {
    return registry;
  }

  const id = String(nodeId);
  const config = normalizeConfig(block);
  if (!config) {
    registry.delete(id);
    return registry;
  }

  const live = isLiveInstance(instance) ? instance : null;
  const signature = configSignature(config);
  const previous = registry.get(id);
  if (previous && previous.signature === signature) {
    // Config unchanged; just refresh (re)resolution of the mapper instance.
    if (previous.mapper !== live) previous.projectionCache = null;
    previous.mapper = live;
    previous.pending = !live;
    return registry;
  }

  registry.set(id, {
    id,
    mapper: live,
    pending: !live,
    projectionCache: null,
    signature,
    ...config,
  });
  return registry;
}

// Project a world point [x,y,z] to canvas CSS px (top-left origin), or null
// when the point is behind the camera. Mirrors the app's projectLocalEnuToCss
// exactly: the same behind-camera rejection and y-flip.
function projectWorldToCss(out, worldToClip, x, y, z, width, height) {
  const cw =
    worldToClip[3] * x +
    worldToClip[7] * y +
    worldToClip[11] * z +
    worldToClip[15];
  if (!(cw > BEHIND_CAMERA_EPSILON)) {
    return false;
  }
  const cx =
    worldToClip[0] * x +
    worldToClip[4] * y +
    worldToClip[8] * z +
    worldToClip[12];
  const cy =
    worldToClip[1] * x +
    worldToClip[5] * y +
    worldToClip[9] * z +
    worldToClip[13];
  out[0] = ((cx / cw) * 0.5 + 0.5) * width;
  out[1] = (0.5 - (cy / cw) * 0.5) * height;
  return Number.isFinite(out[0]) && Number.isFinite(out[1]);
}

function resolvePickableMapper(entry, synchronizerContext) {
  if (isLiveInstance(entry.mapper)) {
    return entry.mapper;
  }
  const resolved = synchronizerContext?.getInstance?.(entry.id);
  if (isLiveInstance(resolved)) {
    entry.mapper = resolved;
    entry.pending = false;
    return resolved;
  }
  return null;
}

// Nearest live glyph point of one pickable within its grab radius, or null.
function nearestPickablePoint(
  entry,
  mapper,
  worldToClip,
  width,
  height,
  cssX,
  cssY,
  grabPx,
) {
  const points = mapper.getInputData?.(0)?.getPoints?.();
  const values = points?.getData?.();
  if (!values || values.length === 0) {
    return null;
  }

  const grabSq = grabPx * grabPx;
  const count = Math.floor(values.length / 3);
  const signature = [
    width,
    height,
    points?.getMTime?.() ?? "",
    ...worldToClip,
  ].join("|");
  let cache = entry.projectionCache;
  if (!cache || cache.signature !== signature || cache.count !== count) {
    const css = new Float64Array(count * 2);
    const projected = [0, 0];
    for (let i = 0; i < count; i += 1) {
      const offset = i * 3;
      const cssOffset = i * 2;
      if (
        projectWorldToCss(
          projected,
          worldToClip,
          values[offset],
          values[offset + 1],
          values[offset + 2],
          width,
          height,
        )
      ) {
        css[cssOffset] = projected[0];
        css[cssOffset + 1] = projected[1];
      } else {
        css[cssOffset] = NaN;
        css[cssOffset + 1] = NaN;
      }
    }
    cache = { signature, count, css };
    entry.projectionCache = cache;
  }
  let best = null;
  for (let i = 0; i < count; i += 1) {
    const offset = i * 3;
    const x = values[offset];
    const y = values[offset + 1];
    const z = values[offset + 2];
    const projectedX = cache.css[i * 2];
    const projectedY = cache.css[i * 2 + 1];
    if (!Number.isFinite(projectedX) || !Number.isFinite(projectedY)) {
      continue;
    }
    const dx = projectedX - cssX;
    const dy = projectedY - cssY;
    const distSq = dx * dx + dy * dy;
    if (distSq <= grabSq && (!best || distSq < best.distSq)) {
      best = {
        distSq,
        pointIndex: i,
        world: [x, y, z],
        // grab offset = projected center - pointer (app offsetX/offsetY).
        grabOffset: { x: dx, y: dy },
      };
    }
  }
  return best;
}

// Higher priority wins; tie -> smaller pixel distance; tie -> declaration order.
function isBetterPick(candidate, best) {
  if (!best) return true;
  if (candidate.priority !== best.priority) {
    return candidate.priority > best.priority;
  }
  if (candidate.distSq !== best.distSq) {
    return candidate.distSq < best.distSq;
  }
  return candidate.order < best.order;
}

export function pickAt(
  registry,
  cssX,
  cssY,
  { renderer, renderWindow, synchronizerContext } = {},
) {
  if (!registry?.size || !renderer || !renderWindow) {
    return null;
  }
  if (!Number.isFinite(cssX) || !Number.isFinite(cssY)) {
    return null;
  }

  const camera = renderer.getActiveCamera?.();
  const metrics = getViewportMetrics(renderer, renderWindow);
  if (!camera || !metrics) {
    return null;
  }

  const worldToClip = getWorldToClipMatrix(camera, metrics.aspect);
  if (!worldToClip) {
    return null;
  }

  let best = null;
  let order = 0;
  for (const [id, entry] of registry) {
    const declarationOrder = order;
    order += 1;

    const mapper = resolvePickableMapper(entry, synchronizerContext);
    if (!mapper) {
      // Instance was deleted (or never resolvable); drop it. A live view
      // re-registers it on the next full/patch sync.
      registry.delete(id);
      continue;
    }

    const near = nearestPickablePoint(
      entry,
      mapper,
      worldToClip,
      metrics.width,
      metrics.height,
      cssX,
      cssY,
      entry.grabPx,
    );
    if (!near) {
      continue;
    }

    const candidate = {
      order: declarationOrder,
      priority: entry.priority,
      distSq: near.distSq,
      nodeId: id,
      pointIndex: near.pointIndex,
      pointId: entry.ids?.[near.pointIndex] ?? near.pointIndex,
      tags: entry.tags,
      preview: entry.preview,
      plane: entry.plane,
      pointsNodeId:
        synchronizerContext?.getInstanceId?.(mapper.getInputData?.(0)) ?? null,
      world: near.world,
      grabOffset: near.grabOffset,
    };
    if (isBetterPick(candidate, best)) {
      best = candidate;
    }
  }

  if (!best) {
    return null;
  }
  // nodeId and pointsNodeId are the picked mapper and its input point set,
  // addressed individually for the client's own use: the drag preview binds
  // the live points array through pointsNodeId and marks both nodes modified.
  // Staleness is not their job — that is `nodes` below.
  const pointsNodeId =
    best.pointsNodeId === null || best.pointsNodeId === undefined
      ? null
      : String(best.pointsNodeId);
  return {
    nodeId: best.nodeId,
    pointIndex: best.pointIndex,
    pointId: best.pointId,
    tags: best.tags,
    preview: best.preview,
    plane: best.plane,
    pointsNodeId,
    // The sole staleness contract: every scene node this pick's screen
    // position was measured through — the mapper carrying the glyph, and the
    // point set it drew that glyph from (a point move can republish only the
    // latter). The client names its own dependencies so the server validates a
    // list rather than a fixed pair, and a pick that grows a third one needs
    // no server change. Null means the client could not establish them, which
    // the server reads as stale.
    nodes: pointsNodeId === null ? null : [String(best.nodeId), pointsNodeId],
    distancePx: Math.sqrt(best.distSq),
    world: best.world,
    grabOffset: best.grabOffset,
  };
}

export function describePickableRegistry(registry) {
  const entries = [];
  if (!registry) {
    return { size: 0, entries };
  }
  for (const [id, entry] of registry) {
    entries.push({
      id,
      pending: !!entry.pending,
      grabPx: entry.grabPx,
      priority: entry.priority,
      preview: entry.preview,
      idCount: entry.ids ? entry.ids.length : null,
      mapperLive: isLiveInstance(entry.mapper),
    });
  }
  return { size: registry.size, entries };
}

export default {
  createPickableRegistry,
  applyPickableBlock,
  pickAt,
  describePickableRegistry,
};
