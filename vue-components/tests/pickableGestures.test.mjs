import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

async function loadGestures() {
  return loadModule("/src/components/pickableGestures.js");
}

// A minimal window stand-in: records capture-phase listeners so a test can
// dispatch to them, and gives manual control over the rAF queue.
function makeWindow() {
  const listeners = new Map();
  const rafQueue = [];
  return {
    devicePixelRatio: 1,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type, handler) {
      if (listeners.get(type) === handler) listeners.delete(type);
    },
    requestAnimationFrame(cb) {
      rafQueue.push(cb);
      return rafQueue.length; // 1-based handle
    },
    cancelAnimationFrame(handle) {
      if (handle >= 1) rafQueue[handle - 1] = null;
    },
    dispatch(type, event) {
      const handler = listeners.get(type);
      if (handler) handler(event);
    },
    flushRaf() {
      const pending = rafQueue.splice(0);
      pending.forEach((cb) => cb && cb());
    },
    hasListener(type) {
      return listeners.has(type);
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

function makeCanvas(rect = { left: 0, top: 0, width: 800, height: 400 }) {
  const captured = [];
  const released = [];
  const listeners = new Map();
  return {
    style: { cursor: "" },
    getBoundingClientRect: () => rect,
    setPointerCapture: (id) => captured.push(id),
    releasePointerCapture: (id) => released.push(id),
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener(type, handler) {
      if (listeners.get(type) === handler) listeners.delete(type);
    },
    dispatch(type, event) {
      listeners.get(type)?.(event);
    },
    captured,
    released,
  };
}

function pointerEvent(clientX, clientY, pointerId = 7) {
  return {
    clientX,
    clientY,
    pointerId,
    preventedDefault: false,
    stoppedImmediate: false,
    preventDefault() {
      this.preventedDefault = true;
    },
    stopImmediatePropagation() {
      this.stoppedImmediate = true;
    },
  };
}

const CAMERA = {
  viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  projectionMatrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
};
const VIEWPORT = { width: 800, height: 400, dpr: 1 };

function makeHarness(overrides = {}) {
  const windowRef = makeWindow();
  const canvas = makeCanvas(overrides.rect);
  const events = [];
  const pickResult = overrides.pickResult ?? {
    nodeId: "m",
    pointIndex: 0,
    pointId: "landmark-0",
    tags: { owner_id: "landmarks" },
    distancePx: 4,
    world: [1, 2, 3],
    grabOffset: { x: 5, y: -3 },
  };
  return { windowRef, canvas, events, pickResult, seq: { value: 7 } };
}

async function createGestures(harness, overrides = {}) {
  const { createPickableGestures } = await loadGestures();
  return createPickableGestures({
    pick: overrides.pick ?? (() => harness.pickResult),
    readCamera: () => CAMERA,
    readViewport: () => VIEWPORT,
    readSeq: () => harness.seq.value,
    getCanvas: () => harness.canvas,
    emit: (payload) => harness.events.push(payload),
    windowRef: harness.windowRef,
    ...overrides.factory,
  });
}

test("startTargetDrag runs the full lifecycle in order with a self-contained payload", async () => {
  const h = makeHarness();
  const g = await createGestures(h);

  const started = g.startTargetDrag(pointerEvent(100, 50));
  assert.equal(started, true);
  assert.deepEqual(h.canvas.captured, [7]);
  assert.equal(h.canvas.style.cursor, "grabbing");
  assert.ok(h.windowRef.hasListener("pointermove"));
  assert.ok(h.windowRef.hasListener("pointerup"));
  assert.ok(h.windowRef.hasListener("pointercancel"));

  const start = h.events[0];
  assert.equal(start.type, "target.drag.start");
  // Grab offset is applied to the pointer on drags: (100 + 5, 50 - 3).
  assert.deepEqual(start.pointer, { x: 105, y: 47 });
  assert.deepEqual(start.camera, CAMERA);
  assert.deepEqual(start.viewport, VIEWPORT);
  assert.equal(start.seq, 7);
  assert.deepEqual(start.pick, h.pickResult);

  // A move is rAF-coalesced: nothing emits until the frame runs.
  h.windowRef.dispatch("pointermove", pointerEvent(120, 60));
  assert.equal(h.events.length, 1);
  h.windowRef.flushRaf();
  assert.equal(h.events.length, 2);
  const move = h.events[1];
  assert.equal(move.type, "target.drag.move");
  assert.deepEqual(move.pointer, { x: 125, y: 57 });
  // The pick is frozen through the drag (same target identity/revision).
  assert.deepEqual(move.pick, h.pickResult);

  h.windowRef.dispatch("pointerup", pointerEvent(140, 70));
  const end = h.events[2];
  assert.equal(end.type, "target.drag.end");
  assert.deepEqual(end.pointer, { x: 145, y: 67 });
  assert.equal(end.cancelled, undefined);
  assert.equal(end.unresolved, undefined);
  assert.deepEqual(h.canvas.released, [7]);
  assert.equal(h.canvas.style.cursor, "");
  // Listeners are detached after the terminal end.
  assert.equal(h.windowRef.hasListener("pointermove"), false);
  assert.equal(h.windowRef.hasListener("pointerup"), false);
  assert.equal(h.windowRef.hasListener("pointercancel"), false);
});

test("shouldGrab can decline a hit so the press falls through to pan", async () => {
  const h = makeHarness();
  const g = await createGestures(h);
  const seen = [];
  // App policy: only grab while the Alt modifier is held.
  g.setShouldGrab((pick, event) => {
    seen.push({ pick, altKey: !!event.altKey });
    return !!event.altKey;
  });

  // No modifier: the pick is found but declined, so no drag starts, nothing is
  // captured, and no event is emitted — the press is free to pan.
  const plain = pointerEvent(100, 50);
  assert.equal(g.startTargetDrag(plain), false);
  assert.deepEqual(h.canvas.captured, []);
  assert.equal(h.events.length, 0);
  assert.equal(h.windowRef.hasListener("pointermove"), false);
  // The policy saw the real pick and the raw event.
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].pick, h.pickResult);
  assert.equal(seen[0].altKey, false);

  // Modifier held: the same press now grabs.
  const withAlt = pointerEvent(100, 50);
  withAlt.altKey = true;
  assert.equal(g.startTargetDrag(withAlt), true);
  assert.deepEqual(h.canvas.captured, [7]);
  assert.equal(h.events[0].type, "target.drag.start");
});

test("setShouldGrab installs and clears the grab policy at runtime", async () => {
  const h = makeHarness();
  const g = await createGestures(h);

  // Default policy: any hit grabs.
  assert.equal(g.startTargetDrag(pointerEvent(10, 10)), true);
  h.windowRef.dispatch("pointerup", pointerEvent(10, 10)); // end the drag cleanly

  // Deny-all policy: the same hit no longer grabs.
  g.setShouldGrab(() => false);
  assert.equal(g.startTargetDrag(pointerEvent(20, 20)), false);

  // A non-function restores the default (any hit grabs).
  g.setShouldGrab(null);
  assert.equal(g.startTargetDrag(pointerEvent(30, 30)), true);
});

test("a pending move is force-flushed before the terminal end", async () => {
  const h = makeHarness();
  const g = await createGestures(h);
  g.startTargetDrag(pointerEvent(100, 50));

  // Move queued but the frame has NOT run yet; pointerup arrives first.
  h.windowRef.dispatch("pointermove", pointerEvent(130, 80));
  assert.equal(h.events.length, 1);
  h.windowRef.dispatch("pointerup", pointerEvent(150, 90));

  const types = h.events.map((e) => e.type);
  assert.deepEqual(types, [
    "target.drag.start",
    "target.drag.move",
    "target.drag.end",
  ]);
  // The flushed move carries its own (pre-terminal) position.
  assert.deepEqual(h.events[1].pointer, { x: 135, y: 77 });
  // A late frame must not emit a second move after the drag ended.
  h.windowRef.flushRaf();
  assert.equal(h.events.length, 3);
});

test("many moves within one frame collapse to a single move (last wins)", async () => {
  const h = makeHarness();
  const g = await createGestures(h);
  g.startTargetDrag(pointerEvent(0, 0));

  for (let i = 1; i <= 5; i += 1) {
    h.windowRef.dispatch("pointermove", pointerEvent(i * 10, i));
  }
  assert.equal(h.events.length, 1); // still only drag.start
  h.windowRef.flushRaf();
  const moves = h.events.filter((e) => e.type === "target.drag.move");
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0].pointer, { x: 55, y: 2 }); // last move (50,5)+offset
});

test("pointercancel always emits a terminal end flagged cancelled", async () => {
  const h = makeHarness();
  const g = await createGestures(h);
  g.startTargetDrag(pointerEvent(100, 50));

  h.windowRef.dispatch("pointercancel", pointerEvent(110, 55));
  const end = h.events.at(-1);
  assert.equal(end.type, "target.drag.end");
  assert.equal(end.cancelled, true);
  assert.equal(h.windowRef.hasListener("pointermove"), false);
});

test("teardown force-ends a drag with an unresolved terminal end", async () => {
  const h = makeHarness();
  const g = await createGestures(h);
  g.startTargetDrag(pointerEvent(100, 50));

  g.teardown();
  const end = h.events.at(-1);
  assert.equal(end.type, "target.drag.end");
  assert.equal(end.cancelled, true);
  assert.equal(end.unresolved, true);
  assert.equal(end.pointer, null);
  assert.equal(h.windowRef.listenerCount(), 0);
});

test("startTargetDrag on a miss returns false and takes no capture", async () => {
  const h = makeHarness();
  const g = await createGestures(h, { pick: () => null });

  const started = g.startTargetDrag(pointerEvent(100, 50));
  assert.equal(started, false);
  assert.deepEqual(h.canvas.captured, []);
  assert.equal(h.canvas.style.cursor, "");
  assert.equal(h.windowRef.listenerCount(), 0);
  assert.equal(h.events.length, 0);
});

test("emitTargetClick emits target.click on a hit (raw pointer, no grab offset)", async () => {
  const h = makeHarness();
  const g = await createGestures(h);

  const handled = g.emitTargetClick(pointerEvent(200, 120));
  assert.equal(handled, true);
  assert.equal(h.events.length, 1);
  const click = h.events[0];
  assert.equal(click.type, "target.click");
  // Clicks report the raw pointer (offset only anchors drags).
  assert.deepEqual(click.pointer, { x: 200, y: 120 });
  assert.deepEqual(click.pick, h.pickResult);
  // No pointer capture / listeners for a click.
  assert.equal(h.windowRef.listenerCount(), 0);
});

test("emitTargetClick emits background.click on a miss, and can be disabled", async () => {
  const h = makeHarness();
  const g = await createGestures(h, { pick: () => null });

  assert.equal(g.emitTargetClick(pointerEvent(10, 10)), true);
  assert.equal(h.events[0].type, "background.click");
  assert.equal(h.events[0].pick, null);

  g.setEmitBackgroundClick(false);
  assert.equal(g.emitTargetClick(pointerEvent(10, 10)), false);
  assert.equal(h.events.length, 1); // nothing new emitted
});

test("every gesture payload carries the seq read at event build time", async () => {
  const h = makeHarness();
  const g = await createGestures(h);

  g.startTargetDrag(pointerEvent(100, 50)); // built at seq 7
  h.seq.value = 8;
  h.windowRef.dispatch("pointermove", pointerEvent(120, 60)); // built at 8
  h.seq.value = 9; // the rAF flush must not rebuild the queued payload
  h.windowRef.flushRaf();
  h.windowRef.dispatch("pointerup", pointerEvent(140, 70)); // built at 9

  h.seq.value = 10;
  g.emitTargetClick(pointerEvent(200, 100)); // built at 10

  assert.deepEqual(
    h.events.map((e) => [e.type, e.seq]),
    [
      ["target.drag.start", 7],
      ["target.drag.move", 8],
      ["target.drag.end", 9],
      ["target.click", 10],
    ],
  );
});

test("background.click carries seq too; the default readSeq yields null", async () => {
  const h = makeHarness();
  h.seq.value = 42;
  const g = await createGestures(h, { pick: () => null });
  g.emitTargetClick(pointerEvent(10, 10));
  assert.equal(h.events[0].type, "background.click");
  assert.equal(h.events[0].seq, 42);

  const bare = makeHarness();
  const withoutReadSeq = await createGestures(bare, {
    pick: () => null,
    factory: { readSeq: undefined },
  });
  withoutReadSeq.emitTargetClick(pointerEvent(10, 10));
  assert.equal(bare.events[0].seq, null);
});

test("the pointer context blob round-trips verbatim on every event", async () => {
  const h = makeHarness();
  const g = await createGestures(h);
  const blob = {
    frame_id: "f9",
    frame_seq: 42,
    surface: "ground",
    nested: [1, 2],
  };
  g.setPointerContext(blob);

  g.startTargetDrag(pointerEvent(100, 50));
  h.windowRef.dispatch("pointermove", pointerEvent(120, 60));
  h.windowRef.flushRaf();
  h.windowRef.dispatch("pointerup", pointerEvent(140, 70));
  g.emitTargetClick(pointerEvent(200, 100));

  assert.ok(h.events.length >= 4);
  for (const event of h.events) {
    assert.deepEqual(event.context, blob);
  }
});

test("hover emits enter/leave once, disables cleanly, and pauses during drag", async () => {
  const h = makeHarness();
  const pick = (x) => {
    if (x < 100) return { ...h.pickResult, nodeId: "a" };
    if (x < 200) return { ...h.pickResult, nodeId: "b" };
    return null;
  };
  const g = await createGestures(h, { pick });
  g.setHoverEnabled(true);

  h.canvas.dispatch("pointermove", pointerEvent(50, 20));
  h.windowRef.flushRaf();
  h.canvas.dispatch("pointermove", pointerEvent(150, 20));
  h.windowRef.flushRaf();
  assert.deepEqual(
    h.events.map((event) => [event.type, event.pick?.nodeId]),
    [
      ["target.enter", "a"],
      ["target.leave", "a"],
      ["target.enter", "b"],
    ],
  );

  g.setHoverEnabled(false);
  h.canvas.dispatch("pointermove", pointerEvent(250, 20));
  h.windowRef.flushRaf();
  assert.equal(h.events.length, 3);

  g.setHoverEnabled(true);
  assert.equal(g.startTargetDrag(pointerEvent(150, 20)), true);
  const countAfterStart = h.events.length;
  h.canvas.dispatch("pointermove", pointerEvent(50, 20));
  h.windowRef.flushRaf();
  assert.equal(h.events.length, countAfterStart);
});

test("removing the active target emits a terminal cancelled drag end", async () => {
  const h = makeHarness();
  const g = await createGestures(h);
  g.startTargetDrag(pointerEvent(10, 10));

  assert.equal(g.cancelForNode("m"), true);
  const terminal = h.events.at(-1);
  assert.equal(terminal.type, "target.drag.end");
  assert.equal(terminal.cancelled, true);
  assert.equal(terminal.unresolved, true);
  assert.equal(g.getActivePick(), null);
});
