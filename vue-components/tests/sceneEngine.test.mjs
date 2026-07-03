import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

// A wslink session stand-in: resync returns the canned snapshot, push()
// delivers a scene.ops broadcast to the engine's subscription handler.
function makeSession(snapshot) {
  const session = {
    handler: null,
    subscribe(_topic, callback) {
      session.handler = callback;
      return { unsubscribe: true };
    },
    unsubscribe() {},
    async call() {
      return snapshot;
    },
    push(message) {
      session.handler([message]);
    },
  };
  return session;
}

const noopReconciler = {
  applyMessage() {},
  applySnapshot() {},
  reset() {},
};
const noopMirror = { gcBlobCache() {}, size: () => 0 };

async function makeEngine(snapshot) {
  const { createSceneEngine } = await loadModule(
    "/src/components/engine/sceneEngine.js",
  );
  const session = makeSession(snapshot);
  const engine = createSceneEngine({
    client: { getConnection: () => ({ getSession: () => session }) },
    rwId: String(snapshot.rw),
    reconciler: noopReconciler,
    mirror: noopMirror,
    cache: new Map(),
  });
  return { engine, session };
}

test("getSeq tracks the applied cursor through snapshot and ops", async () => {
  const snapshot = { v: 2, rw: "1", seq: 5, root: "1", nodes: {}, blobs: {} };
  const { engine, session } = await makeEngine(snapshot);

  assert.equal(engine.getSeq(), -1); // nothing applied yet -> stale by design

  engine.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.getSeq(), 5);

  session.push({ v: 2, rw: "1", baseSeq: 5, seq: 6, ops: [], blobs: {} });
  assert.equal(engine.getSeq(), 6);

  // A duplicate delivery does not move the cursor.
  session.push({ v: 2, rw: "1", baseSeq: 5, seq: 6, ops: [], blobs: {} });
  assert.equal(engine.getSeq(), 6);

  engine.stop();
});
