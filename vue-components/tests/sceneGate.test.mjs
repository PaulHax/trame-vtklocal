import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

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

async function makeEngine(hold, { holdMs } = {}) {
  const { createSceneEngine } = await loadModule(
    "/src/components/engine/sceneEngine.js",
  );
  const snapshot = { v: 2, rw: "1", seq: 5, root: "1", nodes: {}, blobs: {} };
  const session = makeSession(snapshot);
  const applied = [];
  const engine = createSceneEngine({
    client: { getConnection: () => ({ getSession: () => session }) },
    rwId: "1",
    reconciler: noopReconciler,
    mirror: noopMirror,
    cache: new Map(),
    gate: { hold, holdMs },
    callbacks: { onApplied: (message) => applied.push(message.seq) },
  });
  engine.start();
  await new Promise((resolve) => setImmediate(resolve));
  return { engine, session, applied };
}

const ops = (seq, name = null) => ({
  v: 2,
  rw: "1",
  baseSeq: seq - 1,
  seq,
  ops: [],
  blobs: {},
  commands: name ? [{ name, payload: { seq } }] : [],
});

test("a held message and everything behind it apply in order on retry", async () => {
  const missing = new Set(["video.frame.a"]);
  const { engine, session, applied } = await makeEngine((message) =>
    message.commands.some((command) => missing.has(command.name)),
  );

  session.push(ops(6));
  session.push(ops(7, "video.frame.a"));
  session.push(ops(8));
  assert.deepEqual(applied, [6]);
  assert.equal(engine.getSeq(), 6);
  assert.equal(engine.getDiagnostics().heldLength, 2);

  // Retrying while the resource is still missing changes nothing.
  engine.retryHeld();
  assert.deepEqual(applied, [6]);

  missing.clear();
  engine.retryHeld();
  assert.deepEqual(applied, [6, 7, 8]);
  assert.equal(engine.getSeq(), 8);
  assert.equal(engine.getDiagnostics().heldLength, 0);

  engine.stop();
});

test("messages behind a hold are not read as a sequence gap", async () => {
  const resyncs = [];
  const { engine, session, applied } = await makeEngine(
    (message) => message.seq === 6,
  );
  const warn = console.warn;
  console.warn = (text) => resyncs.push(text);
  try {
    session.push(ops(6));
    session.push(ops(7));
    // A duplicate of a held message is dropped like any duplicate.
    session.push(ops(7));
    assert.deepEqual(resyncs, []);
    assert.equal(engine.getDiagnostics().heldLength, 2);
    engine.retryHeld();
    assert.equal(engine.getDiagnostics().heldLength, 2);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(applied, []);
  engine.stop();
});

test("a held message applies at its deadline whatever the gate says", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const { engine, session, applied } = await makeEngine(() => true, {
      holdMs: 250,
    });
    session.push(ops(6));
    mock.timers.tick(100);
    session.push(ops(7));
    assert.deepEqual(applied, []);

    mock.timers.tick(149);
    assert.deepEqual(applied, []);
    mock.timers.tick(1);
    // Only the message past its deadline applies; the next one waits its own.
    assert.deepEqual(applied, [6]);
    mock.timers.tick(100);
    assert.deepEqual(applied, [6, 7]);
    engine.stop();
  } finally {
    mock.timers.reset();
  }
});

test("a resync drops held messages and continues from the snapshot", async () => {
  const { engine, session, applied } = await makeEngine(() => true);
  session.push(ops(6));
  assert.equal(engine.getDiagnostics().heldLength, 1);

  await engine.resync("client-request");
  assert.equal(engine.getDiagnostics().heldLength, 0);
  assert.equal(engine.getSeq(), 5);
  assert.deepEqual(applied, []);
  engine.stop();
});

test("stopping the engine releases its hold timer", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const { engine, session, applied } = await makeEngine(() => true);
    session.push(ops(6));
    engine.stop();
    mock.timers.tick(1000);
    assert.deepEqual(applied, []);
  } finally {
    mock.timers.reset();
  }
});
