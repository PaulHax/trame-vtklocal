// Drives a real scene (engine, mirror, reconciler and instance registry)
// through a stand-in wslink session: the engine subscribes to scene.ops and
// asks scene.resync for snapshots, and the test answers both.
import { loadModule } from "./loadModule.mjs";

export const RENDER_WINDOW_ID = "1";

// `initial` is the first resync's answer: seq, nodes, blobs, commands.
export function createSession(initial = {}) {
  const subscribers = new Set();
  let snapshot = { seq: 0, nodes: {}, ...initial };
  const { seq } = snapshot;
  // The seq the engine routed last, so each broadcast follows it in order.
  let routed = seq;
  const session = {
    subscribe(_topic, handler) {
      subscribers.add(handler);
      return handler;
    },
    unsubscribe(handler) {
      subscribers.delete(handler);
    },
    async call() {
      routed = snapshot.seq;
      return {
        v: 2,
        rw: RENDER_WINDOW_ID,
        root: RENDER_WINDOW_ID,
        blobs: {},
        ...snapshot,
      };
    },
  };
  function deliver(message) {
    for (const handler of [...subscribers]) handler([message]);
  }
  return {
    client: { getConnection: () => ({ getSession: () => session }) },
    // What the next scene.resync answers.
    setSnapshot(next) {
      snapshot = { seq: routed, nodes: {}, ...next };
    },
    // The next in-order scene.ops broadcast.
    broadcast(message = {}) {
      deliver({
        v: 2,
        rw: RENDER_WINDOW_ID,
        baseSeq: routed,
        seq: routed + 1,
        ops: [],
        blobs: {},
        ...message,
      });
      routed += 1;
    },
    // A broadcast past a gap: the engine drops it and resyncs.
    skipAhead() {
      deliver({
        v: 2,
        rw: RENDER_WINDOW_ID,
        baseSeq: routed + 1,
        seq: routed + 2,
        ops: [],
      });
    },
  };
}

// A resync is a promise; let it land.
export function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function mountScene(options = {}, seam = undefined) {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");
  const {
    session = createSession(),
    onRenderNeeded,
    ...sceneOptions
  } = options;
  const scene = useSceneSync(
    {
      client: session.client,
      emit() {},
      getRenderWindow: () => null,
      getOpenGLRenderWindow: () => null,
      ...sceneOptions,
    },
    seam,
  );
  scene.initialize({
    renderWindowId: Number(RENDER_WINDOW_ID),
    onRenderNeeded,
  });
  await settle();
  return { scene, session };
}
