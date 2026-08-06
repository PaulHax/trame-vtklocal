// Client mirror of the server's flat scene store (push sync v2).
//
// The mirror is the client's copy of `store.snapshot()["nodes"]`: an id ->
// node map that must equal the server store after every applied message.
// `applyOp`/`applyOps` are a line-for-line port of the normative reference
// applier (`apply_ops` in tests/test_scene_store.py). Violations of the op
// contract (removing an unknown id, patching a missing array) throw so the
// engine can fall back to a resync.

import { deepClone } from "./values";

export function createMirrorStore() {
  const nodes = new Map();
  const arrayRefCounts = new Map();

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
    nodes.clear();
    arrayRefCounts.clear();
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
    gcBlobCache,
    toObject,
  };
}
