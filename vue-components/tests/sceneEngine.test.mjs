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

async function makeEngine(snapshot, callbacks = {}) {
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
    callbacks,
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

test("retained snapshot commands dispatch once after snapshot application", async () => {
  const order = [];
  const snapshot = {
    v: 2,
    rw: "1",
    seq: 3,
    root: "1",
    nodes: {},
    blobs: {},
    commands: [
      {
        name: "camera.set",
        payload: { parallelScale: 5 },
        render: true,
      },
    ],
  };
  const { engine } = await makeEngine(snapshot, {
    onSnapshotApplied: () => order.push("snapshot"),
    onRenderRequested: () => order.push("render"),
  });
  engine.onCommand("camera.set", (payload) => {
    order.push(`camera:${payload.parallelScale}`);
  });

  engine.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(order, ["snapshot", "camera:5", "render"]);
  engine.stop();
});

test("only render-marked command-only messages request a render", async () => {
  let renders = 0;
  const snapshot = { v: 2, rw: "1", seq: 1, root: "1", nodes: {}, blobs: {} };
  const { engine, session } = await makeEngine(snapshot, {
    onRenderRequested: () => {
      renders += 1;
    },
  });
  engine.start();
  await new Promise((resolve) => setImmediate(resolve));

  session.push({
    v: 2,
    rw: "1",
    baseSeq: 1,
    seq: 2,
    ops: [],
    blobs: {},
    commands: [{ name: "quiet", payload: null }],
  });
  assert.equal(renders, 0);

  session.push({
    v: 2,
    rw: "1",
    baseSeq: 2,
    seq: 3,
    ops: [],
    blobs: {},
    commands: [{ name: "camera.set", payload: {}, render: true }],
  });
  assert.equal(renders, 1);
  engine.stop();
});
