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

  function get(id) {
    return nodes.get(String(id));
  }

  function applyOp(op) {
    if (op.op === "upsert") {
      nodes.set(String(op.id), deepClone(op.node));
      return;
    }
    if (op.op === "remove") {
      if (!nodes.delete(String(op.id))) {
        throw new Error(`remove of unknown node ${op.id}`);
      }
      return;
    }
    if (op.op === "patchArray") {
      const node = nodes.get(String(op.id));
      const entry = node?.arrays?.[op.key];
      if (!entry) {
        throw new Error(`patchArray target ${op.id}.${op.key} missing`);
      }
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
    const refs = new Set();
    for (const node of nodes.values()) {
      for (const entry of Object.values(node.arrays || {})) {
        refs.add(entry.ref);
      }
    }
    return refs;
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
    gcBlobCache,
    toObject,
  };
}
