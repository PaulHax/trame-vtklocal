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

function arrayPathKey(instanceId, arrayPath) {
  return `${instanceId}:${arrayPath}`;
}

function getMessageKind(message, fallbackKind = null) {
  return message?.kind || fallbackKind;
}

function getMessageRwId(message) {
  return message?.rwId ?? message?.id;
}

export function getPartialUpdates(message) {
  if (Array.isArray(message?.updates)) {
    return message.updates;
  }
  return message ? [message] : [];
}

function collectStateArrayPathHashes(state, into = new Map()) {
  function visit(value) {
    if (!value || typeof value !== "object") {
      return;
    }

    const instanceId = value.id;
    const properties = value.properties;
    if (instanceId !== undefined && properties) {
      ["points"].forEach((arrayPath) => {
        const descriptor = properties[arrayPath];
        if (isArrayDescriptor(descriptor)) {
          into.set(arrayPathKey(instanceId, arrayPath), descriptor.hash);
        }
      });
    }

    if (Array.isArray(value.dependencies)) {
      value.dependencies.forEach((dependency) => visit(dependency));
    }
  }

  visit(state);
  return into;
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
    console.warn(
      `[pushSync] Partial update type mismatch at ${arrayPath}: ` +
        `payload=${dataType}, target=${TargetCtor.name}`,
    );
    return false;
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

export function bindPartialResultToCache(
  update,
  synchronizerContext,
  pushCache,
) {
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

export function applyPatchUpdate(patch, synchronizerContext) {
  const ops = Array.isArray(patch?.ops) ? patch.ops : [];
  const targets = [];

  for (const op of ops) {
    if (op?.op !== "setProperties") {
      console.warn(`[pushSync] Unsupported patch op ${op?.op}`);
      return false;
    }

    const instance = synchronizerContext?.getInstance?.(op.id);
    if (!instance) {
      console.warn(`[pushSync] Instance ${op?.id} not found for patch update`);
      return false;
    }
    if (typeof instance.set !== "function") {
      console.warn(
        `[pushSync] Instance ${op?.id} cannot apply patch properties`,
      );
      return false;
    }

    targets.push({ instance, properties: op.properties || {} });
  }

  targets.forEach(({ instance, properties }) => {
    instance.set(properties);
    instance.modified?.();
  });

  return true;
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

  let messageQueue = [];
  let visibilityHandler = null;
  let acceptBroadcasts = false;
  let resyncVersion = 0;
  let clientEpoch = null;
  let clientLastSeq = 0;
  const arrayPathHashes = new Map();

  const session = client.getConnection().getSession();

  function collectQueuedFullStateHashes(into = new Set()) {
    messageQueue.forEach(({ payload, kind }) => {
      if (kind === "full") {
        collectStateHashes(payload, into);
      }
    });
    return into;
  }

  function retainCacheForAppliedStateAndQueue(state) {
    const live = collectStateHashes(state);
    collectQueuedFullStateHashes(live);
    pruneCacheToHashes(pushCache, live);
  }

  function markStatesApplied(states) {
    if (!states?.length) {
      return;
    }
    states.forEach((state) => {
      if (state?.epoch !== undefined) {
        clientEpoch = state.epoch;
      }
      if (state?.seq !== undefined) {
        clientLastSeq = state.seq;
      }
      arrayPathHashes.clear();
      collectStateArrayPathHashes(state, arrayPathHashes);
    });
    retainCacheForAppliedStateAndQueue(states[states.length - 1]);
  }

  async function dispatchPartialUpdate(update) {
    if (onPartialUpdate) {
      return onPartialUpdate(update, synchronizerContext);
    }

    const applied = applyPartialArrayUpdate(update, synchronizerContext);
    if (applied) {
      bindPartialResultToCache(update, synchronizerContext, pushCache);
    }
    return applied;
  }

  function enqueueMessage(payload, fallbackKind) {
    const kind = getMessageKind(payload, fallbackKind);

    // The server is authoritative: every hash referenced by `state` is either
    // already in the push cache or inlined in this payload. Capture inline
    // payloads now so consumers see a fully-populated cache.
    if (kind === "full") {
      extractInlineArrays(payload, pushCache, { stripInlineData: true });
    }

    const wasEmpty = messageQueue.length === 0;
    messageQueue.push({ kind, payload });

    if (wasEmpty) {
      onQueueReady?.();
    }

    if (kind === "full") {
      onStateReceived?.(payload);
    }
  }

  const wsSubscription = session.subscribe(
    "trame.vtk.delta",
    ([deltaState]) => {
      if (!acceptBroadcasts) return;
      const messageRwId = getMessageRwId(deltaState);
      if (!rwId || String(messageRwId) === rwId) {
        enqueueMessage(deltaState, "full");
      }
    },
  );

  const wsPartialUpdateSubscription = session.subscribe(
    "trame.vtk.array.partial",
    ([update]) => {
      if (!acceptBroadcasts || !synchronizerContext) return;
      const messageRwId = getMessageRwId(update);
      if (messageRwId && String(messageRwId) !== rwId) return;

      enqueueMessage(update, "arrayPartial");
    },
  );

  const wsPatchSubscription = session.subscribe(
    "trame.vtk.patch",
    ([patch]) => {
      if (!acceptBroadcasts || !synchronizerContext) return;
      const messageRwId = getMessageRwId(patch);
      if (messageRwId && String(messageRwId) !== rwId) return;

      enqueueMessage(patch, "patch");
    },
  );

  async function requestResync() {
    acceptBroadcasts = false;
    messageQueue.length = 0;
    pushCache.clear();
    arrayPathHashes.clear();
    clientEpoch = null;
    clientLastSeq = 0;
    const version = ++resyncVersion;

    try {
      const state = await session.call("vtkjs.push.resync", [rwId]);
      if (version !== resyncVersion) {
        return false;
      }
      enqueueMessage(state, "full");
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

  function validateMessageEnvelope(message) {
    const { kind, payload } = message;
    const { epoch, seq, baseSeq } = payload || {};

    if (epoch !== undefined && clientEpoch !== null && epoch < clientEpoch) {
      return "drop";
    }

    if (
      epoch !== undefined &&
      clientEpoch !== null &&
      epoch === clientEpoch &&
      seq !== undefined &&
      seq <= clientLastSeq
    ) {
      return "drop";
    }

    if (kind === "full") {
      return "ready";
    }

    if (clientEpoch === null) {
      return "resync";
    }

    if (epoch !== undefined && epoch !== clientEpoch) {
      return "resync";
    }

    if (baseSeq === undefined || baseSeq !== clientLastSeq) {
      return "resync";
    }

    return "ready";
  }

  function takeNextMessage() {
    while (messageQueue.length) {
      const message = messageQueue[0];
      const status = validateMessageEnvelope(message);
      if (status === "drop") {
        messageQueue.shift();
        continue;
      }
      if (status === "resync") {
        requestResync();
        return null;
      }
      return messageQueue.shift();
    }
    return null;
  }

  function validatePartialUpdate(update) {
    if (!update?.oldHash) {
      return true;
    }

    const key = arrayPathKey(update.instanceId, update.arrayPath);
    const currentHash = arrayPathHashes.get(key);
    if (currentHash !== update.oldHash) {
      console.warn(
        `[pushSync] Partial update hash mismatch at ${key}: ` +
          `expected=${currentHash}, oldHash=${update.oldHash}`,
      );
      requestResync();
      return false;
    }
    return true;
  }

  function markMessageApplied(message) {
    if (!message) {
      return;
    }

    const { kind, payload } = message;
    if (payload?.epoch !== undefined) {
      clientEpoch = payload.epoch;
    }
    if (payload?.seq !== undefined) {
      clientLastSeq = payload.seq;
    }

    if (kind === "full") {
      arrayPathHashes.clear();
      collectStateArrayPathHashes(payload, arrayPathHashes);
      retainCacheForAppliedStateAndQueue(payload);
      return;
    }

    getPartialUpdates(payload).forEach((update) => {
      if (update?.newHash) {
        arrayPathHashes.set(
          arrayPathKey(update.instanceId, update.arrayPath),
          update.newHash,
        );
      }
    });
  }

  function markMessageFailed() {
    requestResync();
  }

  function drainReadyStates() {
    const readyStates = [];
    while (messageQueue.length && messageQueue[0].kind === "full") {
      const status = validateMessageEnvelope(messageQueue[0]);
      if (status === "drop") {
        messageQueue.shift();
        continue;
      }
      if (status === "resync") {
        requestResync();
        break;
      }
      readyStates.push(messageQueue.shift().payload);
    }
    return readyStates;
  }

  function drainReadyPartialUpdates() {
    const readyUpdates = [];
    while (messageQueue.length && messageQueue[0].kind !== "full") {
      const status = validateMessageEnvelope(messageQueue[0]);
      if (status === "drop") {
        messageQueue.shift();
        continue;
      }
      if (status === "resync") {
        requestResync();
        break;
      }
      const message = messageQueue.shift();
      readyUpdates.push(...getPartialUpdates(message.payload));
    }
    return readyUpdates;
  }

  async function applyQueuedState() {
    let didApply = false;
    let message = takeNextMessage();
    while (message) {
      if (message.kind === "full") {
        if (syncRenderWindow) {
          await syncRenderWindow.synchronize(message.payload);
        }
      } else if (message.kind === "arrayPartial") {
        for (const update of getPartialUpdates(message.payload)) {
          if (!validatePartialUpdate(update)) {
            return didApply;
          }
          const applied = await dispatchPartialUpdate(update);
          if (!applied) {
            markMessageFailed();
            return didApply;
          }
        }
      } else if (!applyPatchUpdate(message.payload, synchronizerContext)) {
        markMessageFailed();
        return didApply;
      }

      markMessageApplied(message);
      didApply = true;
      message = takeNextMessage();
    }
    return didApply;
  }

  function cleanup() {
    resyncVersion += 1;
    messageQueue.length = 0;
    pushCache.clear();
    arrayPathHashes.clear();

    if (wsSubscription) {
      session.unsubscribe(wsSubscription);
    }
    if (wsPartialUpdateSubscription) {
      session.unsubscribe(wsPartialUpdateSubscription);
    }
    if (wsPatchSubscription) {
      session.unsubscribe(wsPatchSubscription);
    }
    if (visibilityHandler) {
      document.removeEventListener("visibilitychange", visibilityHandler);
      visibilityHandler = null;
    }
  }

  function getQueueLength() {
    return messageQueue.length;
  }

  return {
    applyQueuedState,
    cleanup,
    drainReadyPartialUpdates,
    drainReadyStates,
    getQueueLength,
    markMessageApplied,
    markMessageFailed,
    markStatesApplied,
    requestResync,
    takeNextMessage,
    validatePartialUpdate,
  };
}
