import { createTypedArray } from "./sync/base64";
import { extractInlineArrays } from "./sync/syncUpdaters";
import { createFetchArrays } from "./vtkJsSync";

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

function collectStateArrayDescriptors(state, descriptors = new Map()) {
  function visit(value) {
    if (!value || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
      return;
    }

    if (isArrayDescriptor(value) && !descriptors.has(value.hash)) {
      descriptors.set(value.hash, value);
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
  return descriptors;
}

function collectQueuedStateHashes(states, hashes = new Set()) {
  (states || []).forEach((state) => {
    collectStateArrayDescriptors(state).forEach((_descriptor, hash) => {
      hashes.add(hash);
    });
  });

  return hashes;
}

function createPushArrayCache(synchronizerContext) {
  const durableCache = new Map();

  function get(hash) {
    if (!hash) {
      return null;
    }

    let values = durableCache.get(hash);
    if (!values && synchronizerContext?.getCachedArray) {
      values = synchronizerContext.getCachedArray(hash, synchronizerContext);
      if (values) {
        durableCache.set(hash, values);
      }
    }

    return values || null;
  }

  function set(hash, values) {
    if (!hash || !values) {
      return values;
    }

    durableCache.set(hash, values);
    synchronizerContext?.cacheArray?.(hash, values, synchronizerContext);
    return values;
  }

  function clear() {
    durableCache.clear();
  }

  function prune(retainedHashes = new Set()) {
    durableCache.forEach((_values, hash) => {
      if (!retainedHashes.has(hash)) {
        durableCache.delete(hash);
      }
    });
  }

  function captureInlineState(state, { stripInlineData = false } = {}) {
    extractInlineArrays(state, synchronizerContext, durableCache, {
      stripInlineData,
    });
  }

  function prepareState(state) {
    captureInlineState(state);

    const missingDescriptors = [];
    collectStateArrayDescriptors(state).forEach((descriptor, hash) => {
      const values = get(hash);
      if (!values) {
        missingDescriptors.push(descriptor);
        return;
      }

      synchronizerContext?.cacheArray?.(hash, values, synchronizerContext);
    });

    return missingDescriptors;
  }

  return {
    get,
    set,
    clear,
    prune,
    captureInlineState,
    prepareState,
  };
}

export function applyPartialArrayUpdate(update, synchronizerContext) {
  const { instanceId, arrayPath, offset, data, dataType } = update;

  const instance = synchronizerContext.getInstance(instanceId);
  if (!instance) {
    console.warn(`[pushSync] Instance ${instanceId} not found for partial update`);
    return false;
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

  if (!target || typeof target.getData !== "function") {
    console.warn(`[pushSync] Cannot find array at path ${arrayPath} on instance ${instanceId}`);
    return false;
  }

  const values = target.getData();
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

export function createPushSync(client, syncRenderWindow, synchronizerContext, rwId, callbacks = {}) {
  const { onStateReceived, onQueueReady, onPartialUpdate } = callbacks;

  const fetchArrays = createFetchArrays(client);
  const pushArrayCache = createPushArrayCache(synchronizerContext);
  const inflightFetches = new Map();

  let stateQueue = [];
  let visibilityHandler = null;
  let acceptBroadcasts = false;
  let resyncPending = false;
  let queueVersion = 0;

  const session = client.getConnection().getSession();

  function getQueuedHashes() {
    return collectQueuedStateHashes(stateQueue);
  }

  function pruneArrayCacheToQueue() {
    pushArrayCache.prune(getQueuedHashes());
  }

  async function prefetchStateArrays(state, version) {
    const uniqueDescriptors = new Map();
    pushArrayCache.prepareState(state).forEach((descriptor) => {
      if (descriptor?.hash && !uniqueDescriptors.has(descriptor.hash)) {
        uniqueDescriptors.set(descriptor.hash, descriptor);
      }
    });

    if (!uniqueDescriptors.size) {
      return false;
    }

    const pendingFetches = [];
    const hashesToFetch = [];

    uniqueDescriptors.forEach((descriptor, hash) => {
      if (pushArrayCache.get(hash)) {
        return;
      }

      const inflight = inflightFetches.get(hash);
      if (inflight) {
        pendingFetches.push(inflight);
        return;
      }

      hashesToFetch.push(hash);
    });

    if (hashesToFetch.length) {
      const batchFetch = fetchArrays(hashesToFetch)
        .then((buffersByHash) => {
          if (version !== queueVersion) {
            return;
          }

          const queuedHashes = getQueuedHashes();
          hashesToFetch.forEach((hash) => {
            if (!queuedHashes.has(hash)) {
              return;
            }

            const descriptor = uniqueDescriptors.get(hash);
            const buffer = buffersByHash.get(hash);
            if (!descriptor || !buffer) {
              throw new Error(`Missing fetched payload for array ${hash}`);
            }

            pushArrayCache.set(hash, createTypedArray(descriptor.dataType, buffer));
          });
        })
        .finally(() => {
          hashesToFetch.forEach((hash) => {
            if (inflightFetches.get(hash) === batchFetch) {
              inflightFetches.delete(hash);
            }
          });
        });

      hashesToFetch.forEach((hash) => {
        inflightFetches.set(hash, batchFetch);
      });
      pendingFetches.push(batchFetch);
    }

    if (!pendingFetches.length) {
      return false;
    }

    await Promise.all(pendingFetches);
    return true;
  }

  function enqueueState(state) {
    stateQueue.push(state);
    pruneArrayCacheToQueue();

    const version = queueVersion;
    prefetchStateArrays(state, version)
      .then((didPrefetch) => {
        if (!didPrefetch || version !== queueVersion) {
          return;
        }

        onQueueReady?.();
      })
      .catch(async (error) => {
        if (version !== queueVersion) {
          return;
        }

        console.warn("[pushSync] Failed to prefetch missing arrays, requesting resync", error);
        await requestResync();
      });

    onStateReceived?.(state);
  }

  const wsSubscription = session.subscribe("trame.vtk.delta", ([deltaState]) => {
    if (!acceptBroadcasts) return;
    if (!rwId || deltaState.id === rwId) {
      enqueueState(deltaState);
    }
  });

  const wsPartialUpdateSubscription = session.subscribe("trame.vtk.array.partial", async ([update]) => {
    if (!acceptBroadcasts || resyncPending || !synchronizerContext) return;
    if (update?.rwId && String(update.rwId) !== rwId) return;

    if (onPartialUpdate) {
      await onPartialUpdate(update, synchronizerContext);
    } else {
      applyPartialArrayUpdate(update, synchronizerContext);
    }
  });

  async function requestResync() {
    acceptBroadcasts = false;
    resyncPending = true;
    stateQueue.length = 0;
    inflightFetches.clear();
    pruneArrayCacheToQueue();

    const version = ++queueVersion;
    const state = await session.call("vtkjs.push.resync", [rwId]);
    if (version !== queueVersion) {
      return;
    }

    enqueueState(state);
    acceptBroadcasts = true;
  }

  visibilityHandler = () => {
    if (document.visibilityState === "visible") {
      requestResync();
    }
  };
  document.addEventListener("visibilitychange", visibilityHandler);

  requestResync();

  function drainReadyQueue() {
    const readyStates = [];

    while (stateQueue.length) {
      const nextState = stateQueue[0];
      const missingDescriptors = pushArrayCache.prepareState(nextState);
      if (missingDescriptors.length) {
        break;
      }

      readyStates.push(stateQueue.shift());
    }

    if (readyStates.length) {
      resyncPending = false;
    }

    pruneArrayCacheToQueue();
    return readyStates;
  }

  async function applyQueuedState() {
    if (!syncRenderWindow) return false;

    const states = drainReadyQueue();
    if (!states.length) return false;

    for (const state of states) {
      await syncRenderWindow.synchronize(state);
    }

    return true;
  }

  function cleanup() {
    queueVersion += 1;
    stateQueue.length = 0;
    inflightFetches.clear();
    pushArrayCache.clear();

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

  function drainQueue() {
    return drainReadyQueue();
  }

  return {
    applyQueuedState,
    cleanup,
    drainQueue,
    drainReadyQueue,
    getQueueLength,
    requestResync,
  };
}
