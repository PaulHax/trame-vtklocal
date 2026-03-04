export const TYPED_ARRAY_CONSTRUCTORS = {
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
      newData = new TypedArrayCtor(data.buffer, data.byteOffset, data.byteLength / TypedArrayCtor.BYTES_PER_ELEMENT);
    } else {
      newData = new TypedArrayCtor(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
  } else {
    newData = new TypedArrayCtor(data);
  }

  const TargetCtor = values.constructor;
  if (TypedArrayCtor !== TargetCtor) {
    newData = new TargetCtor(newData);
  }

  if (offset + newData.length > values.length) {
    console.warn(
      `[pushSync] Partial update out of bounds: offset=${offset}, ` +
      `newData.length=${newData.length}, values.length=${values.length}`
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
  const { onStateReceived, onPartialUpdate } = callbacks;

  let stateQueue = [];
  let visibilityHandler = null;
  let acceptBroadcasts = false;

  const session = client.getConnection().getSession();

  const wsSubscription = session.subscribe("trame.vtk.delta", ([deltaState]) => {
    if (!acceptBroadcasts) return;
    if (!rwId || deltaState.id === rwId) {
      stateQueue.push(deltaState);
      if (onStateReceived) {
        onStateReceived(deltaState);
      }
    }
  });

  const wsPartialUpdateSubscription = session.subscribe("trame.vtk.array.partial", async ([update]) => {
    if (!acceptBroadcasts || !synchronizerContext) return;

    if (onPartialUpdate) {
      onPartialUpdate(update, synchronizerContext);
    } else {
      applyPartialArrayUpdate(update, synchronizerContext);
    }
  });

  async function requestResync() {
    acceptBroadcasts = false;
    const state = await session.call("vtkjs.push.resync", [rwId]);
    stateQueue.length = 0;
    stateQueue.push(state);
    acceptBroadcasts = true;
    if (onStateReceived) {
      onStateReceived(state);
    }
  }

  visibilityHandler = () => {
    if (document.visibilityState === "visible") {
      requestResync();
    }
  };
  document.addEventListener("visibilitychange", visibilityHandler);

  requestResync();

  async function applyQueuedState() {
    if (!stateQueue.length || !syncRenderWindow) return false;

    while (stateQueue.length) {
      const state = stateQueue.shift();
      await syncRenderWindow.synchronize(state);
    }
    return true;
  }

  function cleanup() {
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
    const states = stateQueue.splice(0);
    return states;
  }

  return { applyQueuedState, cleanup, getQueueLength, drainQueue, requestResync };
}
