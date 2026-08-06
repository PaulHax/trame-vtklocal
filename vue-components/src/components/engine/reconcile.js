// Node-vs-mirror reconcile applier.
//
// Applies broadcast ops to live vtk.js instances by diffing each upserted
// node against the client mirror: changed props -> instance.set, ref-slot
// diffs -> the pinned add/remove/set calls, array entries -> blob-cache
// bindings, feature blocks -> registered handlers. `patchArray` mutates the
// bound typed array in place; `remove` tears the instance down.
//
// Two passes per message: (1) build instances for upserted ids missing from
// the synchronizer context, so same-message refs always resolve; (2) apply
// ops in order (upserts, patches, removes — the store orders them). A type
// change on an existing id rebuilds the instance and force-rewires every
// referrer slot afterwards.

import { deepEqual } from "./values";
import {
  bindArrayEntry,
  cachedTypedArray,
  removeArrayEntry,
  typedArrayConstructor,
} from "./arrayBinding";
import { viewAsTypedArray } from "../sync/base64";
import { isLiveInstance } from "../predicates";

// Ref-slot -> vtk.js call map (pinned by the wire protocol).
const SINGLE_REF_SETTERS = {
  activeCamera: "setActiveCamera",
  mapper: "setMapper",
  property: "setProperty",
  lookupTable: "setLookupTable",
};

const LIST_REF_SLOTS = {
  renderers: {
    add: "addRenderer",
    remove: "removeRenderer",
    read: "getRenderers",
  },
  viewProps: {
    add: "addViewProp",
    remove: "removeViewProp",
    read: "getViewProps",
  },
  lights: { add: "addLight", remove: "removeLight", read: "getLights" },
  textures: { add: "addTexture", remove: "removeTexture", read: "getTextures" },
};

const INDEXED_REF_SETTERS = {
  rgbTransferFunction: "setRGBTransferFunction",
  grayTransferFunction: "setGrayTransferFunction",
  scalarOpacity: "setScalarOpacity",
};

function slotIds(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return typeof value === "string" ? [value] : value;
}

function sameIdList(a, b) {
  return a.length === b.length && a.every((id, i) => b[i] === id);
}

export function createReconciler({
  synchronizerContext,
  objectManager,
  rootId,
  rootInstance,
  shouldDeferProps = () => false,
}) {
  const blockHandlers = new Map();
  // nodeId -> Map(arrayKey -> { array: vtk data array, ref }) — the client's
  // record of which blob each bound array holds, for rebinds and patches.
  const bindings = new Map();
  const bindingsByRef = new Map(); // ref -> Set(binding)
  // ref -> the binding whose rendered typed array is also the cache's canonical
  // typed array. Later binders copy eagerly, moving unavoidable alias work away
  // from patches and pointer interaction. An explicitly local-writable binding
  // is always private and never appears here.
  const bufferOwners = new Map();
  // nodeId -> Set(arrayKey). Previewable arrays stay private across ordinary
  // server rebinds so every optimistic write is cache-safe and allocation-free.
  const privateSlots = new Map();
  const deferredProps = new Map(); // id -> latest server props
  let rootAttached = false;

  // The root render window is widget-owned, never built. Register it so
  // getInstance/getInstanceId treat it like every other node.
  if (rootInstance && synchronizerContext?.registerInstance) {
    synchronizerContext.registerInstance(String(rootId), rootInstance);
  }

  function getInstance(id) {
    return synchronizerContext?.getInstance?.(String(id)) ?? null;
  }

  function liveInstanceFor(id) {
    const instance = getInstance(id);
    return isLiveInstance(instance) ? instance : null;
  }

  function registerBlockHandler(key, handler) {
    blockHandlers.set(key, handler);
    return () => {
      if (blockHandlers.get(key) === handler) {
        blockHandlers.delete(key);
      }
    };
  }

  // ---------------------------------------------------------------------
  // Ref slots
  // ---------------------------------------------------------------------

  function applyListSlot(instance, spec, prevIds, nextIds) {
    if (sameIdList(prevIds, nextIds)) {
      return;
    }
    // Slot order is render order. When the change is pure removals plus
    // appends the diff is surgical; any other reorder rebuilds the slot.
    const nextSet = new Set(nextIds);
    const survivors = prevIds.filter((id) => nextSet.has(id));
    const appendOnly = survivors.every((id, i) => nextIds[i] === id);
    const removeIds = appendOnly
      ? prevIds.filter((id) => !nextSet.has(id))
      : prevIds;
    const addIds = appendOnly ? nextIds.slice(survivors.length) : nextIds;
    for (const refId of removeIds) {
      const child = getInstance(refId);
      if (child) {
        instance[spec.remove](child);
      }
    }
    for (const refId of addIds) {
      const child = liveInstanceFor(refId);
      if (child) {
        instance[spec.add](child);
      }
    }
  }

  function applyIndexedSlot(instance, setter, prevIds, nextIds) {
    for (let i = 0; i < nextIds.length; i += 1) {
      if (prevIds[i] !== nextIds[i]) {
        const child = liveInstanceFor(nextIds[i]);
        if (child) {
          instance[setter](i, child);
        }
      }
    }
    for (let i = nextIds.length; i < prevIds.length; i += 1) {
      instance[setter](i, null);
    }
  }

  function applyInputsSlot(instance, prevIds, nextIds) {
    for (let port = 0; port < nextIds.length; port += 1) {
      if (prevIds[port] !== nextIds[port]) {
        const dataset = liveInstanceFor(nextIds[port]);
        if (dataset) {
          instance.setInputData(dataset, port);
        }
      }
    }
  }

  function applySlotDiff(instance, slot, prevValue, nextValue) {
    if (slot === "inputs") {
      applyInputsSlot(instance, slotIds(prevValue), slotIds(nextValue));
      return;
    }
    const singleSetter = SINGLE_REF_SETTERS[slot];
    if (singleSetter) {
      // A slot that disappears is left alone: a renderer with no activeCamera
      // ref keeps its own local camera (client camera authority), and
      // mapper/property/lookupTable only ever leave with their owner node.
      if (nextValue === undefined || nextValue === null) {
        return;
      }
      if (prevValue !== nextValue) {
        const child = liveInstanceFor(nextValue);
        if (child && typeof instance[singleSetter] === "function") {
          instance[singleSetter](child);
        }
      }
      return;
    }
    const listSpec = LIST_REF_SLOTS[slot];
    if (listSpec) {
      applyListSlot(instance, listSpec, slotIds(prevValue), slotIds(nextValue));
      return;
    }
    const indexedSetter = INDEXED_REF_SETTERS[slot];
    if (indexedSetter) {
      applyIndexedSlot(
        instance,
        indexedSetter,
        slotIds(prevValue),
        slotIds(nextValue),
      );
      return;
    }
    console.warn(`[reconcile] unknown ref slot ${slot}`);
  }

  function applyRefsDiff(instance, nextRefs, prevRefs) {
    const slots = new Set([...Object.keys(prevRefs), ...Object.keys(nextRefs)]);
    for (const slot of slots) {
      applySlotDiff(instance, slot, prevRefs[slot], nextRefs[slot]);
    }
  }

  function drainListSlot(instance, listSpec) {
    for (const item of [...(instance[listSpec.read]?.() || [])]) {
      instance[listSpec.remove](item);
    }
  }

  // Re-apply a slot from scratch against live state — used after an instance
  // rebuild, when the referrer's collections may hold a stale (replaced)
  // instance that id lookups can no longer name. Draining those collections
  // first turns the diff below into a full re-apply against an empty previous.
  function forceApplySlot(instance, slot, value) {
    const listSpec = LIST_REF_SLOTS[slot];
    if (listSpec) {
      drainListSlot(instance, listSpec);
    }
    applySlotDiff(instance, slot, undefined, value);
  }

  function rewireRebuilt(rebuiltIds, mirror) {
    for (const [referrerId, node] of mirror.entries()) {
      const refs = node.refs || {};
      for (const [slot, value] of Object.entries(refs)) {
        if (!slotIds(value).some((refId) => rebuiltIds.has(refId))) {
          continue;
        }
        const instance = liveInstanceFor(referrerId);
        if (instance) {
          forceApplySlot(instance, slot, value);
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Props / arrays / blocks
  // ---------------------------------------------------------------------

  function applyPropsDiff(instance, nextProps, prevProps, isNew) {
    const changed = {};
    let count = 0;
    for (const [key, value] of Object.entries(nextProps)) {
      if (isNew || !deepEqual(prevProps[key], value)) {
        changed[key] = value;
        count += 1;
      }
    }
    // Props absent from the new node are left at their current value — the
    // server emits explicit values for anything it wants reset.
    if (count) {
      instance.set(changed);
    }
  }

  function isPrivateSlot(id, key) {
    return privateSlots.get(id)?.has(key) || false;
  }

  function rememberPrivateSlot(id, key) {
    let keys = privateSlots.get(id);
    if (!keys) {
      keys = new Set();
      privateSlots.set(id, keys);
    }
    keys.add(key);
  }

  function addRefBinding(binding) {
    let refBindings = bindingsByRef.get(binding.ref);
    if (!refBindings) {
      refBindings = new Set();
      bindingsByRef.set(binding.ref, refBindings);
    }
    refBindings.add(binding);
  }

  function removeRefBinding(binding) {
    const refBindings = bindingsByRef.get(binding.ref);
    refBindings?.delete(binding);
    if (refBindings?.size === 0) {
      bindingsByRef.delete(binding.ref);
    }
  }

  function unlinkBinding(binding) {
    if (!binding) return;
    if (bufferOwners.get(binding.ref) === binding) {
      bufferOwners.delete(binding.ref);
    }
    removeRefBinding(binding);
  }

  function moveBindingRef(binding, ref) {
    removeRefBinding(binding);
    binding.ref = ref;
    addRefBinding(binding);
  }

  function dropBindings(id, { forgetPrivate = false } = {}) {
    for (const bound of bindings.get(id)?.values() || []) {
      unlinkBinding(bound);
    }
    bindings.delete(id);
    if (forgetPrivate) privateSlots.delete(id);
  }

  // Move canonical ownership of a still-live ref off the binding that is about
  // to mutate. Alias binders already own private copies, so the normal path is
  // Map bookkeeping only. A copy is the safe fallback for an unbound or
  // explicitly local-writable sibling.
  function preserveSharedCanonical(ref, mutatingBinding, cache) {
    for (const candidate of bindingsByRef.get(ref) || []) {
      if (candidate !== mutatingBinding && !candidate.privateLocal) {
        cache.set(ref, candidate.array.getData());
        bufferOwners.set(ref, candidate);
        return;
      }
    }
    cache.set(ref, mutatingBinding.array.getData().slice());
    bufferOwners.delete(ref);
  }

  function applyArraysDiff(instance, id, nextArrays, prevArrays, cache) {
    let nodeBindings = bindings.get(id);
    for (const [key, entry] of Object.entries(prevArrays)) {
      if (!(key in nextArrays)) {
        removeArrayEntry(instance, entry);
        unlinkBinding(nodeBindings?.get(key));
        nodeBindings?.delete(key);
      }
    }
    for (const [key, entry] of Object.entries(nextArrays)) {
      const bound = nodeBindings?.get(key);
      if (
        bound &&
        bound.ref === entry.ref &&
        deepEqual(prevArrays[key], entry)
      ) {
        continue;
      }
      const cached = cachedTypedArray(cache, entry.ref, entry.dataType);
      if (!cached) {
        throw new Error(
          `blob ${entry.ref} missing from cache (node ${id}, array ${key})`,
        );
      }
      unlinkBinding(bound);
      const privateLocal = isPrivateSlot(id, key);
      const ownsCache = !privateLocal && !bufferOwners.has(entry.ref);
      const values = ownsCache ? cached : cached.slice();
      const array = bindArrayEntry(instance, entry, values);
      if (!nodeBindings) {
        nodeBindings = new Map();
        bindings.set(id, nodeBindings);
      }
      const binding = {
        id,
        key,
        array,
        ref: entry.ref,
        numberOfComponents: entry.numberOfComponents || 1,
        privateLocal,
      };
      nodeBindings.set(key, binding);
      addRefBinding(binding);
      if (ownsCache) bufferOwners.set(entry.ref, binding);
    }
  }

  function applyBlocksDiff(instance, id, nextBlocks, prevBlocks, isNew) {
    const keys = new Set([
      ...Object.keys(prevBlocks),
      ...Object.keys(nextBlocks),
    ]);
    for (const key of keys) {
      const nextBlock = key in nextBlocks ? nextBlocks[key] : null;
      const prevBlock = key in prevBlocks ? prevBlocks[key] : null;
      if (!isNew && deepEqual(prevBlock, nextBlock)) {
        continue;
      }
      const handler = blockHandlers.get(key);
      if (!handler) {
        console.warn(`[reconcile] no handler for block ${key} (node ${id})`);
        continue;
      }
      handler(id, nextBlock, instance);
    }
  }

  // ---------------------------------------------------------------------
  // Ops
  // ---------------------------------------------------------------------

  function drainRootCollections(instance) {
    // A widget-owned render window can carry renderers from a previous
    // binding when the first root node arrives; the diff below is against an
    // empty mirror, so drain by hand once.
    drainListSlot(instance, LIST_REF_SLOTS.renderers);
  }

  function applyNodeDiff(id, node, prev, cache) {
    const instance = liveInstanceFor(id);
    if (!instance) {
      // Unbuildable type (already warned in the build pass); skip its state.
      return;
    }
    const isNew = prev === undefined;
    if (isNew && id === rootId && !rootAttached) {
      drainRootCollections(instance);
    }
    if (id === rootId) {
      rootAttached = true;
    }
    if (shouldDeferProps(id, node)) {
      deferredProps.set(id, { instance, props: node.props || {} });
    } else {
      deferredProps.delete(id);
      applyPropsDiff(instance, node.props || {}, prev?.props || {}, isNew);
    }
    applyRefsDiff(instance, node.refs || {}, prev?.refs || {});
    applyArraysDiff(instance, id, node.arrays || {}, prev?.arrays || {}, cache);
    applyBlocksDiff(instance, id, node.blocks || {}, prev?.blocks || {}, isNew);
  }

  function applyArrayPatch(op, mirror, cache) {
    const id = String(op.id);
    const node = mirror.get(id);
    const entry = node?.arrays?.[op.key];
    if (!entry) {
      throw new Error(`patchArray target ${id}.${op.key} missing from mirror`);
    }
    const binding = bindings.get(id)?.get(op.key);
    if (!binding || binding.ref !== entry.ref) {
      throw new Error(
        `patchArray ${id}.${op.key}: no binding for ref ${entry.ref}`,
      );
    }
    const values = binding.array.getData();
    const Ctor = typedArrayConstructor(op.dataType);
    if (values.constructor !== Ctor) {
      throw new Error(
        `patchArray ${id}.${op.key}: dataType mismatch ` +
          `(${op.dataType} vs ${values.constructor.name})`,
      );
    }
    const data = viewAsTypedArray(op.data, op.dataType);
    if (op.offset < 0 || op.offset + data.length > values.length) {
      throw new Error(
        `patchArray ${id}.${op.key}: out of bounds ` +
          `(offset=${op.offset}, length=${data.length}, size=${values.length})`,
      );
    }
    const oldRef = binding.ref;
    const oldRefShared = (mirror.refCount?.(oldRef) || 1) > 1;
    const ownsOldCache = bufferOwners.get(oldRef) === binding;

    let canonicalNew = null;
    if (binding.privateLocal) {
      const canonicalOld = cachedTypedArray(cache, oldRef, op.dataType);
      if (!canonicalOld) {
        throw new Error(`patchArray ${id}.${op.key}: cache ref ${oldRef} missing`);
      }
      if (oldRefShared) {
        // The old server version remains live elsewhere, so the new canonical
        // version needs independent storage. This is the one inherently
        // expensive edge: two server versions plus a private preview buffer.
        canonicalNew = canonicalOld.slice();
      } else {
        cache.delete(oldRef);
        canonicalNew = canonicalOld;
      }
    } else if (ownsOldCache) {
      if (oldRefShared) {
        preserveSharedCanonical(oldRef, binding, cache);
      } else {
        cache.delete(oldRef);
        bufferOwners.delete(oldRef);
      }
    } else if (!oldRefShared) {
      cache.delete(oldRef);
      bufferOwners.delete(oldRef);
    }

    if (data.length) {
      values.set(data, op.offset);
      canonicalNew?.set(data, op.offset);
    }
    binding.array.modified?.();
    getInstance(id)?.modified?.();
    moveBindingRef(binding, op.ref);
    if (binding.privateLocal) {
      cache.set(op.ref, canonicalNew);
      bufferOwners.delete(op.ref);
    } else {
      cache.set(op.ref, values);
      bufferOwners.set(op.ref, binding);
    }
  }

  function teardownNode(id, prevNode) {
    if (id === rootId) {
      return;
    }
    const instance = getInstance(id);
    for (const key of Object.keys(prevNode?.blocks || {})) {
      blockHandlers.get(key)?.(id, null, instance);
    }
    dropBindings(id, { forgetPrivate: true });
    deferredProps.delete(id);
    if (instance) {
      synchronizerContext.unregisterInstance?.(id);
      if (isLiveInstance(instance)) {
        instance.delete?.();
      }
    }
  }

  function buildFor(id, type) {
    const built = objectManager.build(type, { managedInstanceId: id });
    if (!built) {
      console.warn(`[reconcile] cannot build type ${type} (node ${id})`);
      return null;
    }
    synchronizerContext.registerInstance(id, built);
    return built;
  }

  function buildInstances(ops, mirror) {
    const rebuilt = new Map(); // id -> replaced (old) instance
    for (const op of ops) {
      if (op.op !== "upsert") {
        continue;
      }
      const id = String(op.id);
      if (id === rootId) {
        continue;
      }
      let instance = getInstance(id);
      if (instance && !isLiveInstance(instance)) {
        synchronizerContext.unregisterInstance?.(id);
        dropBindings(id);
        instance = null;
      }
      if (!instance) {
        buildFor(id, op.node.type);
        continue;
      }
      const prevType = mirror.get(id)?.type;
      if (prevType && prevType !== op.node.type) {
        // Same id, new type: rebuild, then rewire referrers after the ops
        // apply. When the new type cannot be built, keep the old instance
        // registered so live wiring stays render-safe.
        if (buildFor(id, op.node.type)) {
          rebuilt.set(id, instance);
          dropBindings(id);
        }
      }
    }
    return rebuilt;
  }

  // Apply one broadcast message's ops to instances and the mirror together.
  // Throws on contract violations; the engine translates throws into resyncs.
  function applyMessage(ops, mirror, cache) {
    const rebuilt = buildInstances(ops, mirror);
    for (const op of ops) {
      if (op.op === "upsert") {
        const id = String(op.id);
        const prev = rebuilt.has(id) ? undefined : mirror.get(id);
        applyNodeDiff(id, op.node, prev, cache);
        mirror.applyOp(op);
      } else if (op.op === "patchArray") {
        applyArrayPatch(op, mirror, cache);
        mirror.applyOp(op);
      } else if (op.op === "remove") {
        teardownNode(String(op.id), mirror.get(String(op.id)));
        mirror.applyOp(op);
      } else {
        throw new Error(`unknown op ${op.op}`);
      }
    }
    if (rebuilt.size) {
      rewireRebuilt(new Set(rebuilt.keys()), mirror);
      for (const oldInstance of rebuilt.values()) {
        if (isLiveInstance(oldInstance)) {
          oldInstance.delete?.();
        }
      }
    }
  }

  // Reconcile a resync snapshot: upsert every snapshot node (diffing against
  // the mirror keeps unchanged instances untouched), then remove leftovers.
  function applySnapshot(nodes, mirror, cache) {
    const ops = [];
    for (const [id, node] of Object.entries(nodes || {})) {
      ops.push({ op: "upsert", id, node });
    }
    for (const id of mirror.ids()) {
      if (!(id in nodes)) {
        ops.push({ op: "remove", id });
      }
    }
    applyMessage(ops, mirror, cache);
  }

  // Full local reset: drop every managed instance (the root stays; its
  // collections drain) so the next snapshot rebuilds from scratch. Used when
  // an apply failure leaves instances and mirror potentially diverged.
  function reset(mirror) {
    const rootInstanceLive = liveInstanceFor(rootId);
    if (rootInstanceLive) {
      drainRootCollections(rootInstanceLive);
    }
    for (const id of mirror.ids()) {
      teardownNode(id, mirror.get(id));
    }
    mirror.clear();
    bindings.clear();
    bindingsByRef.clear();
    bufferOwners.clear();
    privateSlots.clear();
    rootAttached = false;
  }

  function getBoundArray(id, key) {
    return bindings.get(String(id))?.get(key)?.array ?? null;
  }

  // Reserve a binding for client-local in-place writes (drag preview). The
  // one-time copy happens when scene state is applied, never on pointer-down;
  // subsequent server patches update this runtime array and its separate
  // canonical cache buffer by patch range.
  function protectLocalWrites(id, key) {
    id = String(id);
    rememberPrivateSlot(id, key);
    const binding = bindings.get(id)?.get(key);
    if (!binding || binding.privateLocal) return !!binding;
    binding.privateLocal = true;
    if (bufferOwners.get(binding.ref) === binding) {
      bufferOwners.delete(binding.ref);
      binding.array.setData(
        binding.array.getData().slice(),
        binding.numberOfComponents,
      );
      binding.array.modified?.();
      getInstance(id)?.modified?.();
    }
    return true;
  }

  function flushDeferredProps() {
    for (const [id, deferred] of deferredProps) {
      const instance = liveInstanceFor(id) || deferred.instance;
      if (isLiveInstance(instance)) {
        instance.set(deferred.props);
      }
    }
    deferredProps.clear();
  }

  function teardown() {
    bindings.clear();
    bindingsByRef.clear();
    bufferOwners.clear();
    privateSlots.clear();
    deferredProps.clear();
    blockHandlers.clear();
  }

  return {
    registerBlockHandler,
    applyMessage,
    applySnapshot,
    reset,
    getBoundArray,
    protectLocalWrites,
    flushDeferredProps,
    teardown,
  };
}
