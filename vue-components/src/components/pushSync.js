import { extractInlineArrays } from "./sync/syncUpdaters";

const TYPED_ARRAY_CONSTRUCTORS = {
  Int8Array,
  Uint8Array,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
};

function isArrayDescriptor(value) {
  return (
    value &&
    typeof value === "object" &&
    value.hash !== undefined &&
    value.dataType !== undefined
  );
}

function collectStateHashes(state, into = new Set()) {
  function visit(value) {
    if (!value || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
      return;
    }

    if (isArrayDescriptor(value)) {
      into.add(value.hash);
    }

    if (value.arrays) {
      Object.values(value.arrays).forEach((arrayValue) => visit(arrayValue));
    }

    if (value.properties) {
      Object.values(value.properties).forEach((propertyValue) =>
        visit(propertyValue),
      );
    }

    if (value.dependencies) {
      value.dependencies.forEach((dependency) => visit(dependency));
    }
  }

  visit(state);
  return into;
}

function collectStatesHashes(states) {
  const hashes = new Set();
  states.forEach((state) => collectStateHashes(state, hashes));
  return hashes;
}

function pruneCacheToHashes(pushCache, live) {
  pushCache.forEach((_value, hash) => {
    if (!live.has(hash)) {
      pushCache.delete(hash);
    }
  });
}

function getPartialArrayTarget(update, synchronizerContext) {
  const { instanceId, arrayPath } = update;

  const instance = synchronizerContext.getInstance(instanceId);
  if (!instance) {
    return { instance: null, target: null, values: null };
  }

  let target = instance;
  if (arrayPath === "points" && instance.getPoints) {
    target = instance.getPoints();
  } else if (arrayPath === "polys" && instance.getPolys) {
    target = instance.getPolys();
  } else if (arrayPath === "lines" && instance.getLines) {
    target = instance.getLines();
  } else if (arrayPath === "verts" && instance.getVerts) {
    target = instance.getVerts();
  } else if (arrayPath === "strips" && instance.getStrips) {
    target = instance.getStrips();
  }

  const values = target?.getData?.() || null;
  return { instance, target, values };
}

export function applyPartialArrayUpdate(update, synchronizerContext) {
  const { instanceId, arrayPath, offset, data, dataType } = update;

  const { instance, target, values } = getPartialArrayTarget(
    update,
    synchronizerContext,
  );
  if (!instance) {
    console.warn(
      `[pushSync] Instance ${instanceId} not found for partial update`,
    );
    return false;
  }

  if (!target || typeof target.getData !== "function") {
    console.warn(
      `[pushSync] Cannot find array at path ${arrayPath} on instance ${instanceId}`,
    );
    return false;
  }

  if (!values) {
    console.warn(`[pushSync] No data array found at ${arrayPath}`);
    return false;
  }

  const TypedArrayCtor = TYPED_ARRAY_CONSTRUCTORS[dataType] || Float32Array;
  let newData;
  if (data instanceof ArrayBuffer) {
    newData = new TypedArrayCtor(data);
  } else if (ArrayBuffer.isView(data)) {
    // msgpack may place binary data at unaligned offsets within a shared buffer
    if (data.byteOffset % TypedArrayCtor.BYTES_PER_ELEMENT === 0) {
      newData = new TypedArrayCtor(
        data.buffer,
        data.byteOffset,
        data.byteLength / TypedArrayCtor.BYTES_PER_ELEMENT,
      );
    } else {
      newData = new TypedArrayCtor(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      );
    }
  } else {
    newData = new TypedArrayCtor(data);
  }

  const TargetCtor = values.constructor;
  if (TypedArrayCtor !== TargetCtor) {
    newData = new TargetCtor(newData);
  }

  if (!newData.length) return true;

  if (offset < 0 || offset + newData.length > values.length) {
    console.warn(
      `[pushSync] Partial update out of bounds: offset=${offset}, ` +
        `newData.length=${newData.length}, values.length=${values.length}`,
    );
    return false;
  }

  values.set(newData, offset);

  if (target.modified) {
    target.modified();
  }

  if (instance.modified) {
    instance.modified();
  }

  return true;
}

export function bindPartialResultToCache(update, synchronizerContext, pushCache) {
  if (!pushCache || !update?.newHash) {
    return;
  }

  const { values } = getPartialArrayTarget(update, synchronizerContext);
  if (values) {
    pushCache.set(update.newHash, values);
  }
  if (update.oldHash && update.oldHash !== update.newHash) {
    pushCache.delete(update.oldHash);
  }
}

export function createPushSync(
  client,
  syncRenderWindow,
  synchronizerContext,
  rwId,
  pushCache,
  callbacks = {},
) {
  const { onStateReceived, onQueueReady, onPartialUpdate } = callbacks;

  let stateQueue = [];
  let pendingPartialUpdates = [];
  let visibilityHandler = null;
  let acceptBroadcasts = false;
  let resyncPending = false;
  let resyncVersion = 0;

  const session = client.getConnection().getSession();

  function retainCacheForStates(states) {
    pruneCacheToHashes(pushCache, collectStatesHashes(states));
  }

  function markStatesApplied(states) {
    if (!states?.length) {
      return;
    }
    pruneCacheToHashes(pushCache, collectStateHashes(states[states.length - 1]));
  }

  async function dispatchPartialUpdate(update) {
    let applied = false;
    if (onPartialUpdate) {
      applied = await onPartialUpdate(update, synchronizerContext);
    } else {
      applied = applyPartialArrayUpdate(update, synchronizerContext);
    }
    if (applied) {
      bindPartialResultToCache(update, synchronizerContext, pushCache);
    }
    return applied;
  }

  function enqueueState(state) {
    // The server is authoritative: every hash referenced by `state` is either
    // already in the push cache or inlined in this payload. Capture inline
    // payloads now so consumers see a fully-populated cache.
    extractInlineArrays(state, pushCache, { stripInlineData: true });

    stateQueue.push(state);

    if (stateQueue[0] === state) {
      onQueueReady?.();
    }

    onStateReceived?.(state);
  }

  const wsSubscription = session.subscribe(
    "trame.vtk.delta",
    ([deltaState]) => {
      if (!acceptBroadcasts) return;
      if (!rwId || deltaState.id === rwId) {
        enqueueState(deltaState);
      }
    },
  );

  const wsPartialUpdateSubscription = session.subscribe(
    "trame.vtk.array.partial",
    async ([update]) => {
      if (!acceptBroadcasts || resyncPending || !synchronizerContext) return;
      if (update?.rwId && String(update.rwId) !== rwId) return;

      if (stateQueue.length) {
        pendingPartialUpdates.push(update);
        return;
      }

      await dispatchPartialUpdate(update);
    },
  );

  async function requestResync() {
    acceptBroadcasts = false;
    resyncPending = true;
    stateQueue.length = 0;
    pendingPartialUpdates.length = 0;
    pushCache.clear();
    const version = ++resyncVersion;

    try {
      const state = await session.call("vtkjs.push.resync", [rwId]);
      if (version !== resyncVersion) {
        return false;
      }
      enqueueState(state);
      acceptBroadcasts = true;
      return true;
    } catch (error) {
      if (version !== resyncVersion) {
        return false;
      }
      console.warn("[pushSync] Failed to request resync", error);
      acceptBroadcasts = true;
      return false;
    }
  }

  visibilityHandler = () => {
    if (document.visibilityState === "visible") {
      requestResync();
    }
  };
  document.addEventListener("visibilitychange", visibilityHandler);

  requestResync();

  function drainReadyStates() {
    if (!stateQueue.length) {
      return [];
    }

    const readyStates = stateQueue.splice(0);
    resyncPending = false;
    retainCacheForStates(readyStates);
    return readyStates;
  }

  function drainReadyPartialUpdates() {
    if (stateQueue.length || !pendingPartialUpdates.length) {
      return [];
    }

    return pendingPartialUpdates.splice(0);
  }

  async function applyQueuedState() {
    const states = drainReadyStates();
    const partialUpdates = drainReadyPartialUpdates();
    if (!states.length && !partialUpdates.length) return false;

    for (const state of states) {
      if (!syncRenderWindow) continue;
      await syncRenderWindow.synchronize(state);
    }
    markStatesApplied(states);

    for (const partialUpdate of partialUpdates) {
      await dispatchPartialUpdate(partialUpdate);
    }

    return states.length > 0 || partialUpdates.length > 0;
  }

  function cleanup() {
    resyncVersion += 1;
    stateQueue.length = 0;
    pendingPartialUpdates.length = 0;
    pushCache.clear();

    if (wsSubscription) {
      session.unsubscribe(wsSubscription);
    }
    if (wsPartialUpdateSubscription) {
      session.unsubscribe(wsPartialUpdateSubscription);
    }
    if (visibilityHandler) {
      document.removeEventListener("visibilitychange", visibilityHandler);
      visibilityHandler = null;
    }
  }

  function getQueueLength() {
    return stateQueue.length;
  }

  return {
    applyQueuedState,
    cleanup,
    drainReadyPartialUpdates,
    drainReadyStates,
    getQueueLength,
    markStatesApplied,
    requestResync,
  };
}
