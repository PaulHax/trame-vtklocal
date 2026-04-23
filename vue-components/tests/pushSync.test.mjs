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

function createState(hash, mtime) {
  return {
    id: "rw",
    mtime,
    properties: {
      points: {
        hash,
        dataType: "Float32Array",
        numberOfComponents: 3,
        size: 3,
        name: "Points",
      },
    },
  };
}

function createEmptyState(mtime = 0) {
  return {
    id: "rw",
    mtime,
    properties: {},
  };
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

test("createPushSync refetches hashes pruned from the queued-state cache", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = createDocumentStub();

  try {
    const { createPushSync } = await loadModule("/src/components/pushSync.js");

    const synchronizerCache = new Map();
    const fetchedHashes = [];
    const { client, emit } = createClientHarness({
      onCall(method, [arg]) {
        if (method === "vtkjs.push.resync") {
          assert.equal(arg, "rw");
          return Promise.resolve(createEmptyState());
        }

        if (method === "vtkjs.get.arrays") {
          fetchedHashes.push([...arg]);
          return Promise.resolve(
            arg.map((hash) => ({
              hash,
              content: new Uint8Array(new Float32Array([1, 2, 3]).buffer),
            })),
          );
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
        cacheArray(hash, values) {
          synchronizerCache.set(hash, values);
        },
        getCachedArray(hash) {
          return synchronizerCache.get(hash) || null;
        },
      },
      "rw",
    );

    await flushAsyncWork();
    await sync.applyQueuedState();

    emit("trame.vtk.delta", createState("hash-a", 1));
    await flushAsyncWork();
    await sync.applyQueuedState();

    emit("trame.vtk.delta", createState("hash-b", 2));
    await flushAsyncWork();
    await sync.applyQueuedState();

    synchronizerCache.clear();

    emit("trame.vtk.delta", createState("hash-a", 3));
    await flushAsyncWork();

    assert.deepEqual(fetchedHashes, [["hash-a"], ["hash-b"], ["hash-a"]]);

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
        cacheArray() {},
        getCachedArray() {
          return null;
        },
      },
      "rw",
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

test("createPushSync buffers partial updates until queued states are ready", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = createDocumentStub();

  try {
    const { createPushSync } = await loadModule("/src/components/pushSync.js");

    let resolveArrayFetch = null;
    const arrayFetchPromise = new Promise((resolve) => {
      resolveArrayFetch = resolve;
    });

    const partialUpdateCalls = [];
    const { client, emit } = createClientHarness({
      onCall(method, [arg]) {
        if (method === "vtkjs.push.resync") {
          assert.equal(arg, "rw");
          return Promise.resolve(createEmptyState());
        }

        if (method === "vtkjs.get.arrays") {
          assert.deepEqual(arg, ["hash-a"]);
          return arrayFetchPromise;
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
        cacheArray() {},
        getCachedArray() {
          return null;
        },
      },
      "rw",
      {
        onPartialUpdate(update, ctx) {
          partialUpdateCalls.push({ update, ctx });
        },
      },
    );

    await flushAsyncWork();
    await sync.applyQueuedState();

    const blockedState = createState("hash-a", 1);
    const partialUpdate = {
      rwId: "rw",
      instanceId: "1",
      arrayPath: "points",
      offset: 0,
      data: new Uint8Array(0),
      dataType: "Float32Array",
    };

    emit("trame.vtk.delta", blockedState);
    await Promise.resolve();
    emit("trame.vtk.array.partial", partialUpdate);
    await flushAsyncWork();

    assert.deepEqual(sync.drainReadyStates(), []);
    assert.deepEqual(sync.drainReadyPartialUpdates(), []);
    assert.deepEqual(partialUpdateCalls, []);

    resolveArrayFetch([
      {
        hash: "hash-a",
        content: new Uint8Array(new Float32Array([1, 2, 3]).buffer),
      },
    ]);
    await flushAsyncWork();

    assert.deepEqual(sync.drainReadyStates(), [blockedState]);
    assert.deepEqual(sync.drainReadyPartialUpdates(), [partialUpdate]);
    assert.deepEqual(partialUpdateCalls, []);

    sync.cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});
