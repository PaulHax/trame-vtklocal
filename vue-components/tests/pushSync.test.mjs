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

function createInlineState({ id = "rw", mtime = 0, hash, payload = [1, 2, 3] }) {
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
  return state;
}

function createEmptyState(mtime = 0) {
  return { id: "rw", mtime, properties: {} };
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
      { async synchronize() { return true; } },
      { /* synchronizerContext stub */ },
      "rw",
      pushCache,
    );

    await flushAsyncWork();
    sync.drainReadyStates(); // discard initial resync state

    emit("trame.vtk.delta", createInlineState({ mtime: 1, hash: "hash-a" }));
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
      { async synchronize() { return true; } },
      { /* synchronizerContext stub */ },
      "rw",
      pushCache,
    );

    await flushAsyncWork();
    sync.drainReadyStates();

    const stateA = createInlineState({ mtime: 1, hash: "hash-a" });
    const stateB = createInlineState({ mtime: 2, hash: "hash-b" });
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
      { async synchronize() { return true; } },
      { /* synchronizerContext stub */ },
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
      { async synchronize() { return true; } },
      { /* synchronizerContext stub */ },
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
    sync.drainReadyStates();

    const blockedState = createInlineState({ mtime: 1, hash: "hash-a" });
    const partialUpdate = {
      rwId: "rw",
      instanceId: "1",
      arrayPath: "points",
      offset: 0,
      data: new Uint8Array(0),
      dataType: "Float32Array",
    };

    emit("trame.vtk.delta", blockedState);
    emit("trame.vtk.array.partial", partialUpdate);
    await flushAsyncWork();

    // Partial buffered behind pending state
    assert.deepEqual(partialUpdateCalls, []);
    assert.deepEqual(sync.drainReadyPartialUpdates(), []);

    // Drain the state, then partial becomes ready
    assert.deepEqual(sync.drainReadyStates(), [blockedState]);
    assert.deepEqual(sync.drainReadyPartialUpdates(), [partialUpdate]);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});
