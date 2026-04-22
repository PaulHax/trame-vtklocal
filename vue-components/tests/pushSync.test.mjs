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
