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
    dispatchEvent(type) {
      listeners.get(type)?.();
    },
    listenerCount(type) {
      return listeners.has(type) ? 1 : 0;
    },
  };
}

function withFullEnvelope(state, { epoch = 1, seq = 0 } = {}) {
  return {
    ...state,
    version: 1,
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

function createNestedInlineState({
  id = "rw",
  mtime = 0,
  hash = "nested-hash",
  payload = [1, 2, 3],
  epoch = 1,
  seq = 0,
} = {}) {
  return withFullEnvelope(
    {
      id,
      mtime,
      properties: {
        custom: {
          arbitrary: {
            payload: {
              hash,
              dataType: "Float32Array",
              numberOfComponents: 3,
              size: payload.length,
              name: "NestedPoints",
              content: new Uint8Array(new Float32Array(payload).buffer),
            },
          },
        },
      },
    },
    { epoch, seq },
  );
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
    version: 1,
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

function createClientHarness({ onCall, onDispose }) {
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
      if (method === "vtkjs.push.dispose") {
        return onDispose ? onDispose(args) : Promise.resolve(true);
      }
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

test("createPushSync cleanup disposes server-side push state", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = createDocumentStub();

  try {
    const { createPushSync } = await loadModule("/src/components/pushSync.js");

    const disposeCalls = [];
    const { client } = createClientHarness({
      onCall(method, [arg]) {
        if (method === "vtkjs.push.resync") {
          assert.equal(arg, "rw");
          return Promise.resolve(createEmptyState());
        }
        throw new Error(`Unexpected RPC: ${method}`);
      },
      onDispose(args) {
        disposeCalls.push(args);
        return Promise.resolve(true);
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
    sync.cleanup();

    assert.deepEqual(disposeCalls, [["rw"]]);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("createPushSync retains nested inlined payloads after states are applied", async () => {
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

    const state = createNestedInlineState({
      mtime: 1,
      hash: "nested-hash",
      seq: 1,
    });
    emit("trame.vtk.delta", state);
    await flushAsyncWork();

    const states = sync.drainReadyStates();
    assert.equal(states.length, 1);
    assert.ok(pushCache.has("nested-hash"));
    assert.equal(
      states[0].properties.custom.arbitrary.payload.content,
      undefined,
    );

    sync.markStatesApplied(states);
    assert.ok(pushCache.has("nested-hash"));

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

test("createPushSync retains full-state payloads after states are marked applied", async () => {
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
    assert.equal(pushCache.has("hash-a"), true);
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

test("createPushSync buffers broadcasts while resync is pending", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = createDocumentStub();

  try {
    const { createPushSync } = await loadModule("/src/components/pushSync.js");

    let resolveResync;
    const resyncPromise = new Promise((resolve) => {
      resolveResync = resolve;
    });
    const { client, emit } = createClientHarness({
      onCall(method, [arg]) {
        if (method === "vtkjs.push.resync") {
          assert.equal(arg, "rw");
          return resyncPromise;
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

    const deltaState = createInlineState({
      mtime: 1,
      hash: "hash-a",
      seq: 1,
    });
    emit("trame.vtk.delta", deltaState);
    await flushAsyncWork();

    assert.equal(sync.getQueueLength(), 0);
    assert.equal(pushCache.has("hash-a"), false);

    resolveResync(createEmptyState(0, { seq: 0 }));
    await flushAsyncWork();

    const states = sync.drainReadyStates();
    assert.deepEqual(
      states.map((state) => state.seq),
      [0, 1],
    );
    assert.equal(pushCache.has("hash-a"), true);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

test("createPushSync does not request resync on visibility changes", async () => {
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
    );

    await flushAsyncWork();
    assert.equal(resyncCalls, 1);
    assert.equal(globalThis.document.listenerCount("visibilitychange"), 0);

    globalThis.document.dispatchEvent("visibilitychange");
    await flushAsyncWork();

    assert.equal(resyncCalls, 1);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

test("createPushSync requests resync for missing message protocol version", async () => {
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
        getInstance() {
          return null;
        },
      },
      "rw",
      new Map(),
    );

    await flushAsyncWork();
    sync.markMessageApplied(sync.takeNextMessage());

    const patch = createPatchMessage({ baseSeq: 0, seq: 1 });
    delete patch.version;
    emit("trame.vtk.patch", patch);

    await flushAsyncWork();
    assert.equal(resyncCalls, 2);
    assert.equal(sync.getQueueLength(), 1);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

test("createPushSync requests resync for missing arrayPartial protocol version", async () => {
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
      baseSeq: 0,
      seq: 1,
      updates: [],
    });

    await flushAsyncWork();
    assert.equal(resyncCalls, 2);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

test("createPushSync requests resync for missing message kind", async () => {
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
        getInstance() {
          return null;
        },
      },
      "rw",
      new Map(),
    );

    await flushAsyncWork();
    sync.markMessageApplied(sync.takeNextMessage());

    const patch = createPatchMessage({ baseSeq: 0, seq: 1 });
    delete patch.kind;
    emit("trame.vtk.patch", patch);

    await flushAsyncWork();
    assert.equal(resyncCalls, 2);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

test("createPushSync requests resync for missing render-window id", async () => {
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
        getInstance() {
          return null;
        },
      },
      "rw",
      new Map(),
    );

    await flushAsyncWork();
    sync.markMessageApplied(sync.takeNextMessage());

    const patch = createPatchMessage({ baseSeq: 0, seq: 1 });
    delete patch.rwId;
    emit("trame.vtk.patch", patch);

    await flushAsyncWork();
    assert.equal(resyncCalls, 2);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

test("createPushSync rejects unsupported resync protocol version", async () => {
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
          return Promise.resolve({
            ...createEmptyState(),
            version: 999,
          });
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
    assert.equal(resyncCalls, 1);
    assert.equal(sync.getQueueLength(), 0);

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
      version: 1,
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
      version: 1,
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

test("createPushSync waits for missing full-state sequence before applying newer states", async () => {
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
      {
        gapResyncDelayMs: null,
      },
    );

    await flushAsyncWork();
    sync.markMessageApplied(sync.takeNextMessage());

    const stateA = createEmptyState(1, { seq: 1 });
    emit("trame.vtk.delta", stateA);
    sync.markMessageApplied(sync.takeNextMessage());

    const stateB = createInlineState({
      mtime: 2,
      hash: "hash-a",
      seq: 2,
    });
    const stateC = createInlineState({
      mtime: 3,
      hash: "hash-a",
      seq: 3,
    });
    delete stateC.properties.points.content;

    emit("trame.vtk.delta", stateC);
    assert.equal(sync.takeNextMessage(), null);
    assert.equal(pushCache.has("hash-a"), false);

    emit("trame.vtk.delta", stateB);
    assert.equal(pushCache.has("hash-a"), true);

    let message = sync.takeNextMessage();
    assert.equal(message.payload.seq, 2);
    sync.markMessageApplied(message);

    message = sync.takeNextMessage();
    assert.equal(message.payload.seq, 3);
    sync.markMessageApplied(message);

    assert.equal(sync.takeNextMessage(), null);
    assert.equal(resyncCalls, 1);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

test("createPushSync avoids waking the queue for blocked future states", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = createDocumentStub();

  try {
    const { createPushSync } = await loadModule("/src/components/pushSync.js");

    let resyncCalls = 0;
    let queueReadyCalls = 0;
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
      {
        gapResyncDelayMs: null,
        onQueueReady() {
          queueReadyCalls += 1;
        },
      },
    );

    await flushAsyncWork();
    sync.markMessageApplied(sync.takeNextMessage());

    emit("trame.vtk.delta", createEmptyState(1, { seq: 1 }));
    sync.markMessageApplied(sync.takeNextMessage());
    queueReadyCalls = 0;

    emit("trame.vtk.delta", createEmptyState(3, { seq: 3 }));
    assert.equal(queueReadyCalls, 1);
    assert.equal(sync.takeNextMessage(), null);

    emit("trame.vtk.delta", createEmptyState(4, { seq: 4 }));
    assert.equal(queueReadyCalls, 1);

    emit("trame.vtk.delta", createEmptyState(2, { seq: 2 }));
    assert.equal(queueReadyCalls, 2);

    for (const expectedSeq of [2, 3, 4]) {
      const message = sync.takeNextMessage();
      assert.equal(message.payload.seq, expectedSeq);
      sync.markMessageApplied(message);
    }

    assert.equal(sync.takeNextMessage(), null);
    assert.equal(resyncCalls, 1);

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

test("createPushSync coalesces consecutive property patches before apply", async () => {
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

    let partialCount = 0;
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
      {
        onPartialUpdate() {
          partialCount += 1;
          return true;
        },
      },
    );

    await flushAsyncWork();
    sync.markMessageApplied(sync.takeNextMessage());

    emit(
      "trame.vtk.patch",
      createPatchMessage({
        baseSeq: 0,
        seq: 1,
        ops: [
          {
            op: "setProperties",
            id: "actor",
            properties: { opacity: 0.1 },
          },
        ],
      }),
    );
    emit(
      "trame.vtk.patch",
      createPatchMessage({
        baseSeq: 1,
        seq: 2,
        ops: [
          {
            op: "setProperties",
            id: "actor",
            properties: { opacity: 0.2 },
          },
        ],
      }),
    );
    emit(
      "trame.vtk.patch",
      createPatchMessage({
        baseSeq: 2,
        seq: 3,
        ops: [
          {
            op: "setProperties",
            id: "actor",
            properties: { visibility: false },
          },
        ],
      }),
    );

    assert.equal(sync.getQueueLength(), 1);
    assert.equal(await sync.applyQueuedState(), true);
    assert.deepEqual(instance.applied, [{ opacity: 0.2, visibility: false }]);
    assert.equal(instance.modifiedCount, 1);
    assert.equal(sync.getQueueLength(), 0);

    emit("trame.vtk.array.partial", {
      version: 1,
      rwId: "rw",
      kind: "arrayPartial",
      epoch: 1,
      baseSeq: 3,
      seq: 4,
      updates: [
        {
          instanceId: "polydata",
          arrayPath: "points",
          offset: 0,
          data: new Float32Array([1, 2, 3]),
          dataType: "Float32Array",
          newHash: "hash-b",
        },
      ],
    });

    assert.equal(await sync.applyQueuedState(), true);
    assert.equal(partialCount, 1);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

test("createPushSync does not coalesce patches with unsupported ops", async () => {
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
        getInstance() {
          return null;
        },
      },
      "rw",
      new Map(),
    );

    await flushAsyncWork();
    sync.markMessageApplied(sync.takeNextMessage());

    emit(
      "trame.vtk.patch",
      createPatchMessage({
        baseSeq: 0,
        seq: 1,
        ops: [{ op: "removeObject", id: "actor" }],
      }),
    );
    emit(
      "trame.vtk.patch",
      createPatchMessage({
        baseSeq: 1,
        seq: 2,
        ops: [
          {
            op: "setProperties",
            id: "actor",
            properties: { visibility: false },
          },
        ],
      }),
    );

    assert.equal(sync.getQueueLength(), 2);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

test("createPushSync coalesces patch extras with latest values", async () => {
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
        getInstance() {
          return null;
        },
      },
      "rw",
      new Map(),
    );

    await flushAsyncWork();
    sync.markMessageApplied(sync.takeNextMessage());

    emit(
      "trame.vtk.patch",
      createPatchMessage({
        baseSeq: 0,
        seq: 1,
        extra: { mapCamera: { zoom: 10 }, keep: true },
      }),
    );
    emit(
      "trame.vtk.patch",
      createPatchMessage({
        baseSeq: 1,
        seq: 2,
        extra: { mapCamera: { zoom: 11 } },
      }),
    );

    assert.equal(sync.getQueueLength(), 1);
    const message = sync.takeNextMessage();
    assert.equal(message.payload.baseSeq, 0);
    assert.equal(message.payload.seq, 2);
    assert.deepEqual(message.payload.extra, {
      mapCamera: { zoom: 11 },
      keep: true,
    });

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

test("applyPatchUpdate applies object-state patches and caches inline payloads", async () => {
  const { applyPatchUpdate } = await loadModule("/src/components/pushSync.js");

  const payload = new Uint8Array(new Float32Array([1, 2, 3]).buffer);
  const applied = [];
  const instance = {
    modifiedCount: 0,
    set(properties) {
      applied.push(properties);
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
  const pushCache = new Map();

  const ok = applyPatchUpdate(
    {
      ops: [
        {
          op: "updateObject",
          id: "actor",
          state: {
            id: "actor",
            type: "vtkActor",
            properties: {
              visibility: false,
              customPayload: {
                hash: "payload-hash",
                dataType: "Float32Array",
                content: payload,
              },
            },
          },
        },
      ],
    },
    synchronizerContext,
    null,
    pushCache,
  );

  assert.equal(ok, true);
  assert.equal(instance.modifiedCount, 1);
  assert.deepEqual(applied, [
    {
      visibility: false,
      customPayload: {
        hash: "payload-hash",
        dataType: "Float32Array",
      },
    },
  ]);
  assert.deepEqual(Array.from(pushCache.get("payload-hash")), [1, 2, 3]);
});

test("applyPatchUpdate applies ops in declaration order", async () => {
  const { applyPatchUpdate } = await loadModule("/src/components/pushSync.js");

  const order = [];
  const actor = {
    set(properties) {
      order.push(["actor", properties]);
    },
    modified() {
      order.push(["actor", "modified"]);
    },
  };
  const mapper = {
    set(properties) {
      order.push(["mapper", properties]);
    },
    modified() {
      order.push(["mapper", "modified"]);
    },
  };
  const synchronizerContext = {
    getInstance(id) {
      return { actor, mapper }[id] || null;
    },
  };

  const ok = applyPatchUpdate(
    {
      ops: [
        {
          op: "setProperties",
          id: "actor",
          properties: { opacity: 0.5 },
        },
        {
          op: "updateObject",
          id: "mapper",
          state: {
            id: "mapper",
            type: "vtkMapper",
            properties: { scalarVisibility: false },
          },
        },
        {
          op: "setProperties",
          id: "actor",
          properties: { visibility: false },
        },
      ],
    },
    synchronizerContext,
    null,
    new Map(),
  );

  assert.equal(ok, true);
  assert.deepEqual(order, [
    ["actor", { opacity: 0.5 }],
    ["actor", "modified"],
    ["mapper", { scalarVisibility: false }],
    ["mapper", "modified"],
    ["actor", { visibility: false }],
    ["actor", "modified"],
  ]);
});

test("applyPatchUpdate applies vtkPolyData object patches with arrays", async () => {
  const { applyPatchUpdate } = await loadModule("/src/components/pushSync.js");
  const vtkPolyData = (
    await loadModule("@kitware/vtk.js/Common/DataModel/PolyData")
  ).default;

  const polydata = vtkPolyData.newInstance();
  const pushCache = new Map();
  const synchronizerContext = {
    getInstance(id) {
      return id === "polydata" ? polydata : null;
    },
  };

  const pointValues = new Float32Array([0, 0, 0, 1, 0, 0]);
  const lineValues = new Uint32Array([2, 0, 1]);
  const tcoordValues = new Float32Array([0, 0, 1, 0]);

  const ok = applyPatchUpdate(
    {
      ops: [
        {
          op: "updateObject",
          id: "polydata",
          state: {
            id: "polydata",
            type: "vtkPolyData",
            properties: {
              points: {
                hash: "points-hash",
                dataType: "Float32Array",
                numberOfComponents: 3,
                size: pointValues.length,
                name: "Points",
                vtkClass: "vtkPoints",
                content: new Uint8Array(pointValues.buffer),
              },
              lines: {
                hash: "lines-hash",
                dataType: "Uint32Array",
                numberOfComponents: 1,
                size: lineValues.length,
                name: "lines",
                vtkClass: "vtkCellArray",
                content: new Uint8Array(lineValues.buffer),
              },
              fields: [
                {
                  hash: "tcoords-hash",
                  dataType: "Float32Array",
                  numberOfComponents: 2,
                  size: tcoordValues.length,
                  name: "TextureCoordinates",
                  location: "pointData",
                  registration: "setTCoords",
                  content: new Uint8Array(tcoordValues.buffer),
                },
              ],
            },
            dependencies: [],
            calls: [],
          },
        },
      ],
    },
    synchronizerContext,
    null,
    pushCache,
  );

  assert.equal(ok, true);
  assert.deepEqual(
    Array.from(polydata.getPoints().getData()),
    [0, 0, 0, 1, 0, 0],
  );
  assert.deepEqual(Array.from(polydata.getLines().getData()), [2, 0, 1]);
  assert.deepEqual(
    Array.from(polydata.getPointData().getTCoords().getData()),
    [0, 0, 1, 0],
  );
  assert.deepEqual(
    Array.from(pushCache.get("points-hash")),
    Array.from(pointValues),
  );
  assert.deepEqual(
    Array.from(pushCache.get("lines-hash")),
    Array.from(lineValues),
  );
  assert.deepEqual(
    Array.from(pushCache.get("tcoords-hash")),
    Array.from(tcoordValues),
  );
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
      {
        gapResyncDelayMs: 0,
      },
    );

    await flushAsyncWork();
    sync.markMessageApplied(sync.takeNextMessage());

    emit("trame.vtk.array.partial", {
      version: 1,
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

test("createPushSync updates partial hash baseline after object patches", async () => {
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

    emit(
      "trame.vtk.patch",
      createPatchMessage({
        baseSeq: 0,
        seq: 1,
        ops: [
          {
            op: "updateObject",
            id: "1",
            state: {
              id: "1",
              type: "vtkPolyData",
              properties: {
                points: {
                  hash: "hash-b",
                  dataType: "Float32Array",
                  numberOfComponents: 3,
                  size: 3,
                  name: "Points",
                },
              },
            },
          },
        ],
      }),
    );
    sync.markMessageApplied(sync.takeNextMessage());

    const update = {
      instanceId: "1",
      arrayPath: "points",
      offset: 0,
      data: new Uint8Array(0),
      dataType: "Float32Array",
      oldHash: "hash-b",
      newHash: "hash-c",
    };

    assert.equal(sync.validatePartialUpdate(update), true);
    await flushAsyncWork();
    assert.equal(resyncCalls, 1);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});
