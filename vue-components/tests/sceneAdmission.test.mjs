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
