// Client mirror of the server's flat scene store (push sync v2).
//
// The mirror is the client's copy of `store.snapshot()["nodes"]`: an id ->
// node map that must equal the server store after every applied message.
// `applyOp`/`applyOps` are a line-for-line port of the normative reference
// applier (`apply_ops` in tests/test_scene_store.py). Violations of the op
// contract (removing an unknown id, patching a missing array) throw so the
// engine can fall back to a resync.
//
// Beside the nodes the store maintains derived indexes — array ref counts and
// forward/reverse ref edges — updated in `applyOp` so they can never diverge
// from the authoritative node refs. A removed target keeps its incoming
// edges (they belong to the referrers); that is what makes create-after-remove
// reattachment resolvable without rescanning the scene.

import { deepClone } from "./values";

export function createMirrorStore() {
  const nodes = new Map();
  const arrayRefCounts = new Map();
  const forwardRefs = new Map(); // referrer id -> Map(slot -> ordered target ids)
  const reverseRefs = new Map(); // target id -> Map(slot -> Set(referrer ids))
  let refRevision = 0;

  function refIds(value) {
    if (value === undefined || value === null) return [];
    const values = Array.isArray(value) ? value : [value];
    return values.map(String);
  }

  function sameIds(left, right) {
    return (
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }

  function normalizedRefs(refs) {
    const normalized = new Map();
    for (const [slot, value] of Object.entries(refs || {})) {
      const ids = refIds(value);
      if (ids.length) normalized.set(slot, ids);
    }
    return normalized;
  }

  function sameRefs(left, right) {
    if (left.size !== right.size) return false;
    for (const [slot, ids] of left) {
      if (!right.has(slot) || !sameIds(ids, right.get(slot))) return false;
    }
    return true;
  }

  function addReverse(targetId, slot, referrerId) {
    let slots = reverseRefs.get(targetId);
    if (!slots) {
      slots = new Map();
      reverseRefs.set(targetId, slots);
    }
    let referrers = slots.get(slot);
    if (!referrers) {
      referrers = new Set();
      slots.set(slot, referrers);
    }
    referrers.add(referrerId);
  }

  function removeReverse(targetId, slot, referrerId) {
    const slots = reverseRefs.get(targetId);
    const referrers = slots?.get(slot);
    referrers?.delete(referrerId);
    if (referrers?.size === 0) slots.delete(slot);
    if (slots?.size === 0) reverseRefs.delete(targetId);
  }

  function updateRefs(id, refs) {
    const previous = forwardRefs.get(id) || new Map();
    const next = normalizedRefs(refs);
    if (sameRefs(previous, next)) return;

    for (const [slot, targetIds] of previous) {
      for (const targetId of new Set(targetIds)) {
        removeReverse(targetId, slot, id);
      }
    }
    for (const [slot, targetIds] of next) {
      for (const targetId of new Set(targetIds)) {
        addReverse(targetId, slot, id);
      }
    }
    if (next.size) forwardRefs.set(id, next);
    else forwardRefs.delete(id);
    refRevision += 1;
  }

  function referrersOf(targetId, slot) {
    return [...(reverseRefs.get(String(targetId))?.get(slot) || [])];
  }

  function referrerSlotsOf(targetId) {
    const slots = reverseRefs.get(String(targetId));
    if (!slots) return [];
    const edges = [];
    for (const [slot, referrers] of slots) {
      for (const referrerId of referrers) {
        edges.push({ referrerId, slot });
      }
    }
    return edges;
  }

  function referrerCount(targetId) {
    const uniqueReferrers = new Set();
    for (const slotReferrers of reverseRefs.get(String(targetId))?.values() ||
      []) {
      for (const referrerId of slotReferrers) {
        uniqueReferrers.add(referrerId);
      }
    }
    return uniqueReferrers.size;
  }

  function adjustRef(ref, delta) {
    const count = (arrayRefCounts.get(ref) || 0) + delta;
    if (count > 0) {
      arrayRefCounts.set(ref, count);
    } else {
      arrayRefCounts.delete(ref);
    }
  }

  function adjustNodeRefs(node, delta) {
    for (const entry of Object.values(node?.arrays || {})) {
      adjustRef(entry.ref, delta);
    }
  }

  function get(id) {
    return nodes.get(String(id));
  }

  function applyOp(op) {
    if (op.op === "upsert") {
      const id = String(op.id);
      const node = deepClone(op.node);
      adjustNodeRefs(nodes.get(id), -1);
      nodes.set(id, node);
      adjustNodeRefs(node, 1);
      updateRefs(id, node.refs);
      return;
    }
    if (op.op === "remove") {
      const id = String(op.id);
      const node = nodes.get(id);
      if (!node) {
        throw new Error(`remove of unknown node ${op.id}`);
      }
      adjustNodeRefs(node, -1);
      nodes.delete(id);
      updateRefs(id, {});
      return;
    }
    if (op.op === "patchArray") {
      const node = nodes.get(String(op.id));
      const entry = node?.arrays?.[op.key];
      if (!entry) {
        throw new Error(`patchArray target ${op.id}.${op.key} missing`);
      }
      adjustRef(entry.ref, -1);
      adjustRef(op.ref, 1);
      nodes.set(String(op.id), {
        ...node,
        arrays: { ...node.arrays, [op.key]: { ...entry, ref: op.ref } },
      });
      return;
    }
    throw new Error(`unknown op ${op.op}`);
  }

  function applyOps(ops) {
    for (const op of ops || []) {
      applyOp(op);
    }
  }

  function clear() {
    const hadRefs = forwardRefs.size > 0;
    nodes.clear();
    arrayRefCounts.clear();
    forwardRefs.clear();
    reverseRefs.clear();
    if (hadRefs) refRevision += 1;
  }

  function ids() {
    return [...nodes.keys()];
  }

  function entries() {
    return nodes.entries();
  }

  function size() {
    return nodes.size;
  }

  // Every array ref any mirror node references (the live blob set).
  function liveRefs() {
    return new Set(arrayRefCounts.keys());
  }

  function refCount(ref) {
    return arrayRefCounts.get(ref) || 0;
  }

  // Per-message blob-cache GC: drop cache entries no mirror node references.
  function gcBlobCache(cache) {
    if (!cache) {
      return;
    }
    const live = liveRefs();
    for (const ref of [...cache.keys()]) {
      if (!live.has(ref)) {
        cache.delete(ref);
      }
    }
  }

  function toObject() {
    const out = {};
    for (const [id, node] of nodes) {
      out[id] = deepClone(node);
    }
    return out;
  }

  return {
    get,
    applyOp,
    applyOps,
    clear,
    ids,
    entries,
    size,
    liveRefs,
    refCount,
    referrersOf,
    referrerSlotsOf,
    referrerCount,
    refRevision: () => refRevision,
    gcBlobCache,
    toObject,
  };
}
