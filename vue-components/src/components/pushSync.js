import {
  extractInlineArrays,
  genericUpdaterSync,
  getSyncUpdater,
} from "./sync/syncUpdaters";

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

const PUSH_PROTOCOL_VERSION = 1;
const SUPPORTED_MESSAGE_KINDS = new Set(["full", "patch", "arrayPartial"]);
const SUPPORTED_PATCH_OPS = new Set(["updateObject", "setProperties"]);

function isArrayDescriptor(value) {
  return (
    value &&
    typeof value === "object" &&
    value.hash !== undefined &&
    value.dataType !== undefined
  );
}

function isBinaryLike(value) {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function collectStateHashes(state, into = new Set()) {
  function visit(value) {
    if (!value || typeof value !== "object" || isBinaryLike(value)) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
      return;
    }

    if (isArrayDescriptor(value)) {
      into.add(value.hash);
      return;
    }

    Object.values(value).forEach((child) => visit(child));
  }

  visit(state);
  return into;
}

function pruneCacheToHashes(pushCache, live) {
  // The server's known-hash ledger is based on delivered payloads, not on the
  // client's current scene. Do not evict full-state payloads here unless the
  // server also observes that eviction. Partial updates still delete superseded
  // hashes explicitly via bindPartialResultToCache().
  void pushCache;
  void live;
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

function getMessageKind(message) {
  return message?.kind;
}

function getMessageRwId(message) {
  return message?.rwId;
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !isBinaryLike(value)
  );
}

function mergePatchExtra(previousExtra, nextExtra) {
  if (nextExtra === undefined) {
    return previousExtra;
  }
  if (previousExtra === undefined) {
    return nextExtra;
  }
  if (isPlainObject(previousExtra) && isPlainObject(nextExtra)) {
    return { ...previousExtra, ...nextExtra };
  }
  return nextExtra;
}

function removeOpsForId(ops, id) {
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    if (ops[i]?.id === id) {
      ops.splice(i, 1);
    }
  }
}

function findLastOpForId(ops, id) {
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    if (ops[i]?.id === id) {
      return ops[i];
    }
  }
  return null;
}

function appendMergedPatchOp(ops, op) {
  if (op?.op === "updateObject") {
    removeOpsForId(ops, op.id);
    ops.push(op);
    return;
  }

  if (op?.op !== "setProperties") {
    ops.push(op);
    return;
  }

  const properties = isPlainObject(op.properties) ? op.properties : {};
  const previous = findLastOpForId(ops, op.id);
  if (previous?.op === "setProperties") {
    previous.properties = {
      ...(isPlainObject(previous.properties) ? previous.properties : {}),
      ...properties,
    };
    return;
  }

  if (
    previous?.op === "updateObject" &&
    isPlainObject(previous.state?.properties)
  ) {
    previous.state.properties = {
      ...previous.state.properties,
      ...properties,
    };
    return;
  }

  ops.push({ ...op, properties: { ...properties } });
}

function isSupportedPatchOp(op) {
  return SUPPORTED_PATCH_OPS.has(op?.op);
}

function hasOnlySupportedPatchOps(message) {
  const ops = Array.isArray(message?.ops) ? message.ops : [];
  return ops.every((op) => isSupportedPatchOp(op));
}

function mergePatchOps(firstOps = [], secondOps = []) {
  const merged = [];
  [...firstOps, ...secondOps].forEach((op) => {
    appendMergedPatchOp(merged, op);
  });
  return merged;
}

function canMergePatchMessages(previous, next) {
  if (previous?.kind !== "patch" || next?.kind !== "patch") {
    return false;
  }
  if (previous.epoch !== next.epoch) {
    return false;
  }
  if (!hasOnlySupportedPatchOps(previous) || !hasOnlySupportedPatchOps(next)) {
    return false;
  }
  if (previous.seq === undefined || next.baseSeq === undefined) {
    return false;
  }
  return previous.seq === next.baseSeq;
}

export function getPartialUpdates(message) {
  if (Array.isArray(message?.updates)) {
    return message.updates;
  }
  return message ? [message] : [];
}

function collectStateArrayPathHashes(state, into = new Map()) {
  function visit(value) {
    if (!value || typeof value !== "object" || isBinaryLike(value)) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
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

    if (isArrayDescriptor(value)) {
      return;
    }

    Object.values(value).forEach((child) => visit(child));
  }

  visit(state);
  return into;
}

function hasSupportedProtocolVersion(payload) {
  return payload?.version === PUSH_PROTOCOL_VERSION;
}

function hasSupportedMessageKind(payload) {
  return SUPPORTED_MESSAGE_KINDS.has(payload?.kind);
}

function warnUnsupportedProtocolVersion(payload, kind) {
  console.warn(
    `[pushSync] Unsupported ${kind || "message"} protocol version ` +
      `${payload?.version}; expected ${PUSH_PROTOCOL_VERSION}`,
  );
}

function warnUnsupportedMessageKind(payload) {
  console.warn(`[pushSync] Unsupported message kind ${payload?.kind}`);
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

function applyObjectStatePatch(
  op,
  synchronizerContext,
  objectManager,
  pushCache,
) {
  const state = op?.state;
  if (!state?.id || !state?.type) {
    console.warn("[pushSync] Missing object state for patch update");
    return false;
  }

  const instance = synchronizerContext?.getInstance?.(state.id);
  if (!instance) {
    console.warn(`[pushSync] Instance ${state.id} not found for object patch`);
    return false;
  }

  try {
    extractInlineArrays(state, pushCache, { stripInlineData: true });

    const updater = getSyncUpdater(state.type) || genericUpdaterSync;
    updater(instance, state, synchronizerContext, objectManager, pushCache);
    instance.modified?.();
    return true;
  } catch (error) {
    console.warn(
      `[pushSync] Failed to apply object patch for ${state.id}: ${error.message}`,
    );
    return false;
  }
}

export function applyPatchUpdate(
  patch,
  synchronizerContext,
  objectManager = null,
  pushCache = null,
) {
  const ops = Array.isArray(patch?.ops) ? patch.ops : [];

  for (const op of ops) {
    if (op?.op === "updateObject") {
      if (
        !applyObjectStatePatch(op, synchronizerContext, objectManager, pushCache)
      ) {
        return false;
      }
      continue;
    }

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

    instance.set(op.properties || {});
    instance.modified?.();
  }

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
  const {
    gapResyncDelayMs = 1000,
    onStateReceived,
    onQueueReady,
    onPartialUpdate,
  } = callbacks;

  let messageQueue = [];
  let acceptBroadcasts = false;
  let bufferBroadcasts = false;
  const broadcastBuffer = [];
  let gapResyncTimer = null;
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

  function clearGapResyncTimer() {
    if (gapResyncTimer !== null) {
      clearTimeout(gapResyncTimer);
      gapResyncTimer = null;
    }
  }

  function scheduleGapResync(reason) {
    if (gapResyncTimer !== null || gapResyncDelayMs === null) {
      return;
    }
    gapResyncTimer = setTimeout(() => {
      gapResyncTimer = null;
      if (messageQueue.length) {
        requestResync(reason);
      }
    }, gapResyncDelayMs);
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

  function payloadMatchesRenderWindow(payload) {
    return !rwId || String(getMessageRwId(payload)) === rwId;
  }

  function warnMismatchedRenderWindow(payload) {
    console.warn(
      `[pushSync] Message rwId ${getMessageRwId(payload)} does not match ` +
        `view ${rwId}`,
    );
  }

  function enqueueMessage(payload, { requestOnInvalidEnvelope = true } = {}) {
    const kind = getMessageKind(payload);
    if (!hasSupportedProtocolVersion(payload)) {
      warnUnsupportedProtocolVersion(payload, kind);
      if (requestOnInvalidEnvelope) {
        requestResync("message-version");
      }
      return false;
    }
    if (!hasSupportedMessageKind(payload)) {
      warnUnsupportedMessageKind(payload);
      if (requestOnInvalidEnvelope) {
        requestResync("message-kind");
      }
      return false;
    }
    if (!payloadMatchesRenderWindow(payload)) {
      warnMismatchedRenderWindow(payload);
      if (requestOnInvalidEnvelope) {
        requestResync("message-rw-id");
      }
      return false;
    }
    const wasEmpty = messageQueue.length === 0;

    // The server is authoritative: every hash referenced by `state` is either
    // already in the push cache or inlined in this payload. Capture inline
    // payloads now so consumers see a fully-populated cache.
    if (kind === "full") {
      extractInlineArrays(payload, pushCache, { stripInlineData: true });
    }

    if (kind === "patch" && messageQueue.length) {
      const previous = messageQueue[messageQueue.length - 1];
      if (canMergePatchMessages(previous.payload, payload)) {
        previous.payload = {
          ...previous.payload,
          seq: payload.seq,
          ops: mergePatchOps(previous.payload.ops, payload.ops),
          extra: mergePatchExtra(previous.payload.extra, payload.extra),
        };
        if (previous.payload.extra === undefined) {
          delete previous.payload.extra;
        }
        return true;
      }
    }

    const message = { kind, payload };
    messageQueue.push(message);

    if (wasEmpty || validateMessageEnvelope(message) === "ready") {
      onQueueReady?.();
    }

    if (kind === "full") {
      onStateReceived?.(payload);
    }
    return true;
  }

  function receiveBroadcast(payload) {
    if (!acceptBroadcasts) {
      if (bufferBroadcasts) {
        broadcastBuffer.push(payload);
      }
      return;
    }
    enqueueMessage(payload);
  }

  const wsSubscription = session.subscribe(
    "trame.vtk.delta",
    ([deltaState]) => {
      const messageRwId = getMessageRwId(deltaState);
      if (!rwId || String(messageRwId) === rwId) {
        receiveBroadcast(deltaState);
      } else if (messageRwId === undefined || messageRwId === null) {
        receiveBroadcast(deltaState);
      }
    },
  );

  const wsPartialUpdateSubscription = session.subscribe(
    "trame.vtk.array.partial",
    ([update]) => {
      if (!synchronizerContext) return;
      const messageRwId = getMessageRwId(update);
      if (messageRwId && String(messageRwId) !== rwId) return;

      receiveBroadcast(update);
    },
  );

  const wsPatchSubscription = session.subscribe(
    "trame.vtk.patch",
    ([patch]) => {
      if (!synchronizerContext) return;
      const messageRwId = getMessageRwId(patch);
      if (messageRwId && String(messageRwId) !== rwId) return;

      receiveBroadcast(patch);
    },
  );

  async function requestResync(reason = "client-request") {
    if (reason !== "initial") {
      console.warn(`[pushSync] Requesting full resync: ${reason}`);
    }
    clearGapResyncTimer();
    acceptBroadcasts = false;
    bufferBroadcasts = true;
    broadcastBuffer.length = 0;
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
      if (!hasSupportedProtocolVersion(state)) {
        warnUnsupportedProtocolVersion(state, "full");
        bufferBroadcasts = false;
        broadcastBuffer.length = 0;
        acceptBroadcasts = true;
        return false;
      }
      if (!hasSupportedMessageKind(state)) {
        warnUnsupportedMessageKind(state);
        bufferBroadcasts = false;
        broadcastBuffer.length = 0;
        acceptBroadcasts = true;
        return false;
      }
      if (!payloadMatchesRenderWindow(state)) {
        warnMismatchedRenderWindow(state);
        bufferBroadcasts = false;
        broadcastBuffer.length = 0;
        acceptBroadcasts = true;
        return false;
      }
      const buffered = broadcastBuffer.splice(0);
      bufferBroadcasts = false;
      enqueueMessage(state, { requestOnInvalidEnvelope: false });
      acceptBroadcasts = true;
      buffered.forEach((payload) => {
        enqueueMessage(payload);
      });
      return true;
    } catch (error) {
      if (version !== resyncVersion) {
        return false;
      }
      bufferBroadcasts = false;
      broadcastBuffer.length = 0;
      console.warn("[pushSync] Failed to request resync", error);
      acceptBroadcasts = true;
      return false;
    }
  }

  requestResync("initial");

  function validateMessageEnvelope(
    message,
    currentEpoch = clientEpoch,
    currentSeq = clientLastSeq,
  ) {
    const { kind, payload } = message;
    const { epoch, seq, baseSeq } = payload || {};

    if (!hasSupportedProtocolVersion(payload)) {
      return "resync";
    }

    if (epoch !== undefined && currentEpoch !== null && epoch < currentEpoch) {
      return "drop";
    }

    if (
      epoch !== undefined &&
      currentEpoch !== null &&
      epoch === currentEpoch &&
      seq !== undefined &&
      seq <= currentSeq
    ) {
      return "drop";
    }

    if (currentEpoch === null) {
      return kind === "full" ? "ready" : "resync";
    }

    if (epoch !== undefined && epoch !== currentEpoch) {
      return "resync";
    }

    if (kind === "full") {
      if (seq === undefined || seq === currentSeq + 1) {
        return "ready";
      }
      if (seq > currentSeq + 1) {
        return "blocked";
      }
      return "drop";
    }

    if (baseSeq === undefined) {
      return "resync";
    }

    if (baseSeq > currentSeq) {
      return "blocked";
    }

    if (baseSeq !== currentSeq) {
      return "resync";
    }

    return "ready";
  }

  function takeNextMessage() {
    for (let index = 0; index < messageQueue.length; ) {
      const message = messageQueue[index];
      const status = validateMessageEnvelope(message);
      if (status === "drop") {
        messageQueue.splice(index, 1);
        continue;
      }
      if (status === "resync") {
        clearGapResyncTimer();
        requestResync("message-envelope");
        return null;
      }
      if (status === "ready") {
        clearGapResyncTimer();
        return messageQueue.splice(index, 1)[0];
      }
      index += 1;
    }
    if (messageQueue.length) {
      scheduleGapResync("message-envelope-gap-timeout");
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
      requestResync("partial-old-hash-mismatch");
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

    if (kind === "patch") {
      collectStateArrayPathHashes(payload, arrayPathHashes);
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
    requestResync("message-apply-failed");
  }

  function drainReadyStates() {
    const readyStates = [];
    let currentEpoch = clientEpoch;
    let currentSeq = clientLastSeq;
    while (messageQueue.length && messageQueue[0].kind === "full") {
      const status = validateMessageEnvelope(
        messageQueue[0],
        currentEpoch,
        currentSeq,
      );
      if (status === "drop") {
        messageQueue.shift();
        continue;
      }
      if (status === "resync") {
        clearGapResyncTimer();
        requestResync("full-state-envelope");
        break;
      }
      if (status === "blocked") {
        scheduleGapResync("full-state-envelope-gap-timeout");
        break;
      }
      clearGapResyncTimer();
      const state = messageQueue.shift().payload;
      if (state?.epoch !== undefined) {
        currentEpoch = state.epoch;
      }
      if (state?.seq !== undefined) {
        currentSeq = state.seq;
      }
      readyStates.push(state);
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
        clearGapResyncTimer();
        requestResync("partial-envelope");
        break;
      }
      if (status === "blocked") {
        scheduleGapResync("partial-envelope-gap-timeout");
        break;
      }
      clearGapResyncTimer();
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
    try {
      session.call("vtkjs.push.dispose", [rwId])?.catch?.(() => {});
    } catch {
      // Best-effort cleanup only; local unsubscribe/cache cleanup still matters.
    }
    resyncVersion += 1;
    clearGapResyncTimer();
    messageQueue.length = 0;
    broadcastBuffer.length = 0;
    bufferBroadcasts = false;
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
