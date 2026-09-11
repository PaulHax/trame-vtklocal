import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeModuleLoader, loadModule } from "./loadModule.mjs";
after(closeModuleLoader);

function message(baseSeq, seq, frame) {
  return {
    v: 2,
    rw: "1",
    baseSeq,
    seq,
    ops: [{ op: "patchArray", id: String(seq) }],
    commands: [{ name: "frame", payload: frame, render: true }],
  };
}

async function fixture(snapshotFrame = null) {
  const { createSceneEngine } = await loadModule(
    "/src/components/engine/sceneEngine.js",
  );
  const ready = new Set(),
    operations = [],
    paints = [];
  let staged = null;
  const snapshot = {
    v: 2,
    rw: "1",
    seq: 0,
    nodes: {},
    commands:
      snapshotFrame == null ? [] : [{ name: "frame", payload: snapshotFrame }],
  };
  const session = {
    subscribe(_, handler) {
      this.handler = handler;
      return {};
    },
    unsubscribe() {},
    async call() {
      return snapshot;
    },
    push(value) {
      this.handler([value]);
    },
  };
  const engine = createSceneEngine({
    client: { getConnection: () => ({ getSession: () => session }) },
    rwId: "1",
    reconciler: {
      applySnapshot() {},
      reset() {},
      applyMessage(ops) {
        operations.push(...ops.map((op) => op.id));
      },
    },
    mirror: { gcBlobCache() {}, size: () => 0 },
    cache: new Map(),
    callbacks: {
      onApplied(value) {
        paints.push([value.seq, staged]);
      },
      onSnapshotApplied(value) {
        paints.push([value.seq, staged]);
      },
    },
    prepareAdmission(commands) {
      const frame = commands.get("frame");
      if (frame != null && !ready.has(frame)) return null;
      return () => {
        staged = frame ?? null;
      };
    },
  });
  engine.start();
  await new Promise((resolve) => setImmediate(resolve));
  return { engine, session, ready, operations, paints, snapshot };
}

test("holds applied cursor until pixels arrive", async () => {
  const { engine, session, ready, operations, paints } = await fixture();
  session.push(message(0, 1, "a"));
  assert.equal(engine.getSeq(), 0);
  assert.equal(engine.getDiagnostics().receivedSeq, 1);
  assert.deepEqual(operations, []);
  ready.add("a");
  engine.flushAdmission();
  assert.equal(engine.getSeq(), 1);
  assert.deepEqual(paints.at(-1), [1, "a"]);
  engine.stop();
});

test("skips missing intermediate pixels while preserving all scene deltas", async () => {
  const { engine, session, ready, operations, paints } = await fixture();
  session.push(message(0, 1, "missing"));
  session.push(message(1, 2, "ready"));
  session.push(message(2, 3, "future"));
  ready.add("ready");
  engine.flushAdmission();
  assert.deepEqual(operations, ["1", "2"]);
  assert.deepEqual(paints, [
    [0, null],
    [2, "ready"],
  ]);
  assert.equal(engine.getDiagnostics().admissionLength, 1);
  ready.add("future");
  engine.flushAdmission();
  assert.deepEqual(paints.at(-1), [3, "future"]);
  engine.stop();
});

test("image-first arrivals wait for geometry", async () => {
  const { engine, session, ready, paints } = await fixture();
  ready.add("a");
  engine.flushAdmission();
  assert.deepEqual(paints, [[0, null]]);
  session.push(message(0, 1, "a"));
  assert.deepEqual(paints.at(-1), [1, "a"]);
  engine.stop();
});

test("a blocked snapshot advances through a ready later prefix", async () => {
  const { engine, session, ready, paints } = await fixture("missing");
  assert.equal(engine.getSeq(), -1);
  assert.deepEqual(paints, []);
  session.push(message(0, 1, "a"));
  ready.add("a");
  engine.flushAdmission();
  assert.deepEqual(paints, [[1, "a"]]);
  engine.stop();
});

test("removal releases a blocked prefix and disposal discards queued work", async () => {
  const { engine, session, paints } = await fixture();
  session.push(message(0, 1, "missing"));
  session.push(message(1, 2, null));
  assert.deepEqual(paints.at(-1), [2, null]);
  session.push(message(2, 3, "missing"));
  engine.stop();
  engine.flushAdmission();
  assert.equal(engine.getDiagnostics().admissionLength, 0);
  assert.equal(engine.getSeq(), 2);
});

test("resync replaces blocked operations with an authoritative snapshot", async () => {
  const { engine, session, ready, operations, snapshot, paints } =
    await fixture();
  session.push(message(0, 1, "missing"));
  snapshot.seq = 3;
  snapshot.commands = [{ name: "frame", payload: "new" }];
  await engine.resync();
  assert.equal(engine.getSeq(), 0);
  ready.add("new");
  engine.flushAdmission();
  assert.equal(engine.getSeq(), 3);
  assert.deepEqual(operations, []);
  assert.deepEqual(paints.at(-1), [3, "new"]);
  engine.stop();
});

test("queue overflow recovers through one current snapshot", async () => {
  const { engine, session, ready, snapshot, paints, operations } =
    await fixture();
  snapshot.seq = 130;
  snapshot.commands = [{ name: "frame", payload: "latest" }];
  for (let seq = 1; seq <= 129; seq += 1)
    session.push(message(seq - 1, seq, "missing"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.getDiagnostics().admissionLength, 1);
  assert.ok(engine.getDiagnostics().admissionBytes > 0);
  ready.add("latest");
  engine.flushAdmission();
  assert.deepEqual(paints.at(-1), [130, "latest"]);
  assert.deepEqual(operations, []);
  assert.equal(engine.getDiagnostics().admissionBytes, 0);
  engine.stop();
});

test("resync bounds messages while its RPC is outstanding and coalesces recovery", async () => {
  const { engine, session, snapshot } = await fixture();
  let finish;
  let calls = 0;
  session.call = () => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const resync = engine.resync();
  for (let seq = 1; seq <= 500; seq++)
    session.push(message(seq - 1, seq, "missing"));
  assert.equal(calls, 1);
  assert.equal(engine.getDiagnostics().bufferLength, 0);
  assert.equal(engine.getDiagnostics().bufferBytes, 0);
  assert.equal(engine.getDiagnostics().bufferOverflow, true);
  finish(snapshot);
  await resync;
  assert.equal(
    calls,
    2,
    "one replacement RPC after the incomplete buffer is discarded",
  );
  snapshot.seq = 500;
  finish(snapshot);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.getSeq(), 500);
  engine.stop();
});

test("oversized waiting snapshots release memory and preserve the old scene", async () => {
  const { createSceneEngine } = await loadModule(
    "/src/components/engine/sceneEngine.js",
  );
  let snapshot = { v: 2, rw: "1", seq: 0, nodes: {} };
  let resets = 0,
    applied = 0;
  const session = {
    subscribe() {},
    unsubscribe() {},
    async call() {
      return snapshot;
    },
  };
  const engine = createSceneEngine({
    client: { getConnection: () => ({ getSession: () => session }) },
    rwId: "1",
    mirror: { size: () => 0, gcBlobCache() {} },
    cache: new Map(),
    reconciler: {
      applySnapshot() {
        applied++;
      },
      reset() {
        resets++;
      },
    },
    prepareAdmission: () => (snapshot.seq === 0 ? () => {} : null),
    limits: { snapshotBytes: 100 },
  });
  engine.start();
  await new Promise((resolve) => setImmediate(resolve));
  snapshot = { ...snapshot, seq: 1, blobs: { huge: new Uint8Array(1024) } };
  await engine.resync("test", { reset: true });
  assert.equal(engine.getDiagnostics().syncFailure, "snapshot-too-large");
  assert.equal(engine.getDiagnostics().admissionBytes, 0);
  assert.equal(engine.getDiagnostics().admissionLength, 0);
  assert.equal(engine.getSeq(), 0);
  assert.equal(applied, 1);
  assert.equal(
    resets,
    0,
    "reset must wait until the replacement can be admitted",
  );
  engine.stop();
});

test("failed resync retries are finite and stop cancels scheduled recovery", async () => {
  const { engine, session } = await fixture();
  const originalSet = globalThis.setTimeout,
    originalClear = globalThis.clearTimeout;
  let nextId = 0,
    calls = 0;
  const timers = new Map();
  globalThis.setTimeout = (callback) => {
    timers.set(++nextId, callback);
    return nextId;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  session.call = async () => {
    calls++;
    throw Error("disconnected");
  };
  try {
    await engine.resync();
    await new Promise((resolve) => setImmediate(resolve));
    while (timers.size) {
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(calls, 4, "one explicit request and three automatic attempts");
    assert.equal(engine.getDiagnostics().syncFailure, "resync-incomplete");
    session.push(message(0, 1, "ignored"));
    assert.equal(engine.getDiagnostics().bufferLength, 0);
    await engine.resync();
    await new Promise((resolve) => setImmediate(resolve));
    engine.stop();
    assert.equal(timers.size, 0);
  } finally {
    engine.stop();
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});

test("snapshot application failure cannot mark the discarded snapshot live", async () => {
  const { createSceneEngine } = await loadModule(
    "/src/components/engine/sceneEngine.js",
  );
  let applies = 0,
    calls = 0,
    resets = 0;
  const snapshot = { v: 2, rw: "1", seq: 0, nodes: {} };
  const session = {
    subscribe() {},
    unsubscribe() {},
    async call() {
      calls++;
      return snapshot;
    },
  };
  const engine = createSceneEngine({
    client: { getConnection: () => ({ getSession: () => session }) },
    rwId: "1",
    mirror: { size: () => 0, gcBlobCache() {} },
    cache: new Map(),
    reconciler: {
      applySnapshot() {
        if (++applies === 1) throw Error("bad first snapshot");
      },
      reset() {
        resets++;
      },
    },
  });
  engine.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(applies, 2);
  assert.equal(resets, 1);
  assert.equal(engine.getSeq(), 0);
  assert.equal(engine.getDiagnostics().live, true);
  assert.equal(engine.getDiagnostics().bufferOverflow, false);
  engine.stop();
});

test("advancing snapshots cannot reset retry allowance when completion keeps failing", async () => {
  const { createSceneEngine } = await loadModule(
    "/src/components/engine/sceneEngine.js",
  );
  const originalSet = globalThis.setTimeout,
    originalClear = globalThis.clearTimeout;
  const timers = new Map();
  let nextId = 0,
    calls = 0;
  globalThis.setTimeout = (callback) => {
    timers.set(++nextId, callback);
    return nextId;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  const session = {
    subscribe() {},
    unsubscribe() {},
    async call() {
      return { v: 2, rw: "1", seq: ++calls, nodes: {} };
    },
  };
  const engine = createSceneEngine({
    client: { getConnection: () => ({ getSession: () => session }) },
    rwId: "1",
    mirror: { size: () => 0, gcBlobCache() {} },
    cache: new Map(),
    reconciler: { applySnapshot() {}, reset() {} },
    callbacks: {
      onSnapshotApplied() {
        throw Error("completion failure");
      },
    },
  });
  try {
    engine.start();
    await new Promise((resolve) => setImmediate(resolve));
    while (timers.size) {
      assert.ok(calls <= 4);
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(calls, 4);
    assert.equal(engine.getDiagnostics().admissionWork.batches, 0);
    assert.ok(engine.getDiagnostics().syncFailure);
    assert.equal(engine.getDiagnostics().live, false);
  } finally {
    engine.stop();
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});
