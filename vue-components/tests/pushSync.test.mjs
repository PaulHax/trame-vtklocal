import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

function createDocumentStub() {
  const listeners = new Map();

  return {
    visibilityState: "visible",
    addEventListener(type, callback) {
      listeners.set(type, callback);
    },
    removeEventListener(type, callback) {
      if (listeners.get(type) === callback) {
        listeners.delete(type);
      }
    },
  };
}

function withFullEnvelope(state, { epoch = 1, seq = 0 } = {}) {
  return {
    ...state,
    rwId: state.rwId ?? state.id,
    kind: "full",
    epoch,
    seq,
  };
}

function createInlineState({
  id = "rw",
  mtime = 0,
  hash,
  payload = [1, 2, 3],
  epoch = 1,
  seq = 0,
}) {
  const state = {
    id,
    mtime,
    properties: {},
  };
  if (hash) {
    state.properties.points = {
      hash,
      dataType: "Float32Array",
      numberOfComponents: 3,
      size: payload.length,
      name: "Points",
      content: new Uint8Array(new Float32Array(payload).buffer),
    };
  }
  return withFullEnvelope(state, { epoch, seq });
}

function createEmptyState(mtime = 0, { epoch = 1, seq = 0 } = {}) {
  return withFullEnvelope({ id: "rw", mtime, properties: {} }, { epoch, seq });
}

function createDatasetState({
  instanceId = "1",
  hash = "hash-a",
  epoch = 1,
  seq = 0,
} = {}) {
  return withFullEnvelope(
    {
      id: "rw",
      properties: {},
      dependencies: [
        {
          id: instanceId,
          properties: {
            points: {
              hash,
              dataType: "Float32Array",
              numberOfComponents: 3,
              size: 3,
              name: "Points",
              content: new Uint8Array(new Float32Array([1, 2, 3]).buffer),
            },
          },
        },
      ],
    },
    { epoch, seq },
  );
}

function createPatchMessage({
  rwId = "rw",
  epoch = 1,
  baseSeq = 0,
  seq = 1,
  ops = [],
  extra,
} = {}) {
  const message = {
    rwId,
    kind: "patch",
    epoch,
    baseSeq,
    seq,
    ops,
  };
  if (extra !== undefined) {
    message.extra = extra;
  }
  return message;
}

function createClientHarness({ onCall }) {
  const subscriptions = new Map();

  const session = {
    subscribe(topic, callback) {
      subscriptions.set(topic, callback);
      return { topic, callback };
    },
    unsubscribe(subscription) {
      subscriptions.delete(subscription.topic);
    },
    call(method, args) {
      return onCall(method, args);
    },
  };

  return {
    client: {
      getConnection() {
        return {
          getSession() {
            return session;
          },
        };
      },
    },
    emit(topic, payload) {
      const callback = subscriptions.get(topic);
      if (callback) {
        callback([payload]);
      }
    },
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("createPushSync captures inlined payloads from delta states", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = createDocumentStub();

  try {
    const { createPushSync } = await loadModule("/src/components/pushSync.js");

    const { client, emit } = createClientHarness({
      onCall(method, [arg]) {
        if (method === "vtkjs.push.resync") {
          assert.equal(arg, "rw");
          return Promise.resolve(createEmptyState());
        }
        throw new Error(`Unexpected RPC: ${method}`);
      },
    });

    const pushCache = new Map();
    const sync = createPushSync(
      client,
      {
        async synchronize() {
          return true;
        },
      },
      {
        /* synchronizerContext stub */
      },
      "rw",
      pushCache,
    );

    await flushAsyncWork();
    sync.markStatesApplied(sync.drainReadyStates()); // discard initial resync state

    emit(
      "trame.vtk.delta",
      createInlineState({ mtime: 1, hash: "hash-a", seq: 1 }),
    );
    await flushAsyncWork();

    const states = sync.drainReadyStates();
    assert.equal(states.length, 1);
    assert.ok(pushCache.has("hash-a"));
    assert.equal(pushCache.get("hash-a").length, 3);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

test("createPushSync retains queued state payloads until states are marked applied", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = createDocumentStub();

  try {
    const { createPushSync } = await loadModule("/src/components/pushSync.js");

    const { client, emit } = createClientHarness({
      onCall(method, [arg]) {
        if (method === "vtkjs.push.resync") {
          assert.equal(arg, "rw");
          return Promise.resolve(createEmptyState());
        }
        throw new Error(`Unexpected RPC: ${method}`);
      },
    });

    const pushCache = new Map();
    const sync = createPushSync(
      client,
      {
        async synchronize() {
          return true;
        },
      },
      {
        /* synchronizerContext stub */
      },
      "rw",
      pushCache,
    );

    await flushAsyncWork();
    sync.markStatesApplied(sync.drainReadyStates());

    const stateA = createInlineState({ mtime: 1, hash: "hash-a", seq: 1 });
    const stateB = createInlineState({ mtime: 2, hash: "hash-b", seq: 2 });
    emit("trame.vtk.delta", stateA);
    emit("trame.vtk.delta", stateB);
    await flushAsyncWork();

    const states = sync.drainReadyStates();
    assert.deepEqual(states, [stateA, stateB]);
    assert.ok(pushCache.has("hash-a"));
    assert.ok(pushCache.has("hash-b"));

    sync.markStatesApplied(states);
    assert.equal(pushCache.has("hash-a"), false);
    assert.equal(pushCache.has("hash-b"), true);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

test("createPushSync keeps accepting delta states after a failed resync", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = createDocumentStub();

  try {
    const { createPushSync } = await loadModule("/src/components/pushSync.js");

    let resyncCalls = 0;
    const receivedStates = [];
    const { client, emit } = createClientHarness({
      onCall(method, [arg]) {
        if (method === "vtkjs.push.resync") {
          resyncCalls += 1;
          assert.equal(arg, "rw");
          return Promise.reject(new Error("resync failed"));
        }
        throw new Error(`Unexpected RPC: ${method}`);
      },
    });

    const sync = createPushSync(
      client,
      {
        async synchronize() {
          return true;
        },
      },
      {
        /* synchronizerContext stub */
      },
      "rw",
      new Map(),
      {
        onStateReceived(state) {
          receivedStates.push(state);
        },
      },
    );

    await flushAsyncWork();
    assert.equal(resyncCalls, 1);
    assert.equal(sync.getQueueLength(), 0);

    const deltaState = createEmptyState(1);
    emit("trame.vtk.delta", deltaState);

    assert.equal(sync.getQueueLength(), 1);
    assert.deepEqual(receivedStates, [deltaState]);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

test("createPushSync buffers partial updates until queued states drain", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = createDocumentStub();

  try {
    const { createPushSync } = await loadModule("/src/components/pushSync.js");

    const partialUpdateCalls = [];
    const { client, emit } = createClientHarness({
      onCall(method, [arg]) {
        if (method === "vtkjs.push.resync") {
          assert.equal(arg, "rw");
          return Promise.resolve(createEmptyState());
        }
        throw new Error(`Unexpected RPC: ${method}`);
      },
    });

    const sync = createPushSync(
      client,
      {
        async synchronize() {
          return true;
        },
      },
      {
        /* synchronizerContext stub */
      },
      "rw",
      new Map(),
      {
        onPartialUpdate(update, ctx) {
          partialUpdateCalls.push({ update, ctx });
        },
      },
    );

    await flushAsyncWork();
    // drain initial resync state so the queue is empty
    sync.markStatesApplied(sync.drainReadyStates());

    const blockedState = createInlineState({
      mtime: 1,
      hash: "hash-a",
      seq: 1,
    });
    const partialUpdate = {
      instanceId: "1",
      arrayPath: "points",
      offset: 0,
      data: new Uint8Array(0),
      dataType: "Float32Array",
    };
    const partialMessage = {
      rwId: "rw",
      kind: "arrayPartial",
      epoch: 1,
      baseSeq: 1,
      seq: 2,
      updates: [partialUpdate],
    };

    emit("trame.vtk.delta", blockedState);
    emit("trame.vtk.array.partial", partialMessage);
    await flushAsyncWork();

    // Partial buffered behind pending state
    assert.deepEqual(partialUpdateCalls, []);
    assert.deepEqual(sync.drainReadyPartialUpdates(), []);

    // Drain the state, then partial becomes ready
    assert.deepEqual(sync.drainReadyStates(), [blockedState]);
    sync.markStatesApplied([blockedState]);
    assert.deepEqual(sync.drainReadyPartialUpdates(), [partialUpdate]);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

test("createPushSync preserves full, partial, full stream order", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = createDocumentStub();

  try {
    const { createPushSync } = await loadModule("/src/components/pushSync.js");

    const { client, emit } = createClientHarness({
      onCall(method, [arg]) {
        if (method === "vtkjs.push.resync") {
          assert.equal(arg, "rw");
          return Promise.resolve(createEmptyState(0, { seq: 0 }));
        }
        throw new Error(`Unexpected RPC: ${method}`);
      },
    });

    const sync = createPushSync(
      client,
      {
        async synchronize() {
          return true;
        },
      },
      {
        /* synchronizerContext stub */
      },
      "rw",
      new Map(),
    );

    await flushAsyncWork();
    const initial = sync.takeNextMessage();
    sync.markMessageApplied(initial);

    const stateA = createEmptyState(1, { seq: 1 });
    const partial = {
      rwId: "rw",
      kind: "arrayPartial",
      epoch: 1,
      baseSeq: 1,
      seq: 2,
      updates: [
        {
          instanceId: "1",
          arrayPath: "points",
          offset: 0,
          data: new Uint8Array(0),
          dataType: "Float32Array",
        },
      ],
    };
    const stateC = createEmptyState(3, { seq: 3 });

    emit("trame.vtk.delta", stateA);
    emit("trame.vtk.array.partial", partial);
    emit("trame.vtk.delta", stateC);

    const order = [];
    let message = sync.takeNextMessage();
    order.push(message.payload.mtime);
    sync.markMessageApplied(message);

    message = sync.takeNextMessage();
    order.push(message.kind);
    sync.markMessageApplied(message);

    message = sync.takeNextMessage();
    order.push(message.payload.mtime);
    sync.markMessageApplied(message);

    assert.deepEqual(order, [1, "arrayPartial", 3]);
    assert.equal(sync.takeNextMessage(), null);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

test("createPushSync applies property patch messages through the ordered queue", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = createDocumentStub();

  try {
    const { createPushSync } = await loadModule("/src/components/pushSync.js");

    const instance = {
      applied: [],
      modifiedCount: 0,
      set(properties) {
        this.applied.push(properties);
      },
      modified() {
        this.modifiedCount += 1;
      },
    };
    const synchronizerContext = {
      getInstance(id) {
        return id === "actor" ? instance : null;
      },
    };

    const { client, emit } = createClientHarness({
      onCall(method, [arg]) {
        if (method === "vtkjs.push.resync") {
          assert.equal(arg, "rw");
          return Promise.resolve(createEmptyState(0, { seq: 0 }));
        }
        throw new Error(`Unexpected RPC: ${method}`);
      },
    });

    const sync = createPushSync(
      client,
      {
        async synchronize() {
          return true;
        },
      },
      synchronizerContext,
      "rw",
      new Map(),
    );

    await flushAsyncWork();
    sync.markMessageApplied(sync.takeNextMessage());

    emit(
      "trame.vtk.patch",
      createPatchMessage({
        ops: [
          {
            op: "setProperties",
            id: "actor",
            properties: { visibility: false },
          },
        ],
      }),
    );

    assert.equal(await sync.applyQueuedState(), true);
    assert.deepEqual(instance.applied, [{ visibility: false }]);
    assert.equal(instance.modifiedCount, 1);
    assert.equal(sync.getQueueLength(), 0);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

test("createPushSync requests resync on sequence gaps", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = createDocumentStub();

  try {
    const { createPushSync } = await loadModule("/src/components/pushSync.js");

    let resyncCalls = 0;
    const { client, emit } = createClientHarness({
      onCall(method, [arg]) {
        if (method === "vtkjs.push.resync") {
          resyncCalls += 1;
          assert.equal(arg, "rw");
          return Promise.resolve(createEmptyState(0, { seq: 0 }));
        }
        throw new Error(`Unexpected RPC: ${method}`);
      },
    });

    const sync = createPushSync(
      client,
      {
        async synchronize() {
          return true;
        },
      },
      {
        /* synchronizerContext stub */
      },
      "rw",
      new Map(),
    );

    await flushAsyncWork();
    sync.markMessageApplied(sync.takeNextMessage());

    emit("trame.vtk.array.partial", {
      rwId: "rw",
      kind: "arrayPartial",
      epoch: 1,
      baseSeq: 2,
      seq: 3,
      updates: [],
    });

    assert.equal(sync.takeNextMessage(), null);
    await flushAsyncWork();
    assert.equal(resyncCalls, 2);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

test("createPushSync requests resync on partial oldHash mismatch", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = createDocumentStub();

  try {
    const { createPushSync } = await loadModule("/src/components/pushSync.js");

    let resyncCalls = 0;
    const { client } = createClientHarness({
      onCall(method, [arg]) {
        if (method === "vtkjs.push.resync") {
          resyncCalls += 1;
          assert.equal(arg, "rw");
          return Promise.resolve(createDatasetState({ hash: "hash-a" }));
        }
        throw new Error(`Unexpected RPC: ${method}`);
      },
    });

    const sync = createPushSync(
      client,
      {
        async synchronize() {
          return true;
        },
      },
      {
        /* synchronizerContext stub */
      },
      "rw",
      new Map(),
    );

    await flushAsyncWork();
    sync.markMessageApplied(sync.takeNextMessage());

    const update = {
      instanceId: "1",
      arrayPath: "points",
      offset: 0,
      data: new Uint8Array(0),
      dataType: "Float32Array",
      oldHash: "wrong-hash",
      newHash: "hash-b",
    };

    assert.equal(sync.validatePartialUpdate(update), false);
    await flushAsyncWork();
    assert.equal(resyncCalls, 2);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});
