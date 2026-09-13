// Scene-ops client engine (push sync v2): subscribe-buffer-resync-drain
// lifecycle, the seq consistency rule, apply-on-arrival, blob-cache
// ownership, and command dispatch.
//
// Wire contract:
// - broadcast topic "scene.ops": { v: 2, rw, baseSeq, seq, ops, blobs?,
//   commands? } — every client gets every message.
// - RPC "scene.resync"(rw, knownRefs) -> { v: 2, rw, seq, root, nodes,
//   blobs } with blobs only for live refs the client did not report.
// - Consistency rule per ops message:
//     seq <= mySeq            -> drop (duplicate)
//     baseSeq == mySeq        -> apply, mySeq = seq
//     otherwise               -> resync(knownRefs = blob-cache keys)
//
// State applies IN the websocket handler (hidden tabs keep receiving
// messages); only rendering defers to the host's rAF/repaint callbacks, so a
// paused tab stays current with O(1) memory.
//
// A gate may hold an ops message whose resources (an external texture the
// message names) have not arrived. Held messages keep their order, so later
// messages wait behind them; each applies when the gate releases it, or at
// its deadline regardless, so a resource that never arrives cannot stall the
// view. Snapshots are never held.

import { base64ToArrayBuffer } from "../sync/base64";

const TOPIC = "scene.ops";
const RESYNC_RPC = "scene.resync";
const PROTOCOL_VERSION = 2;

function toUint8Copy(data) {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data.slice(0));
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    );
  }
  if (typeof data === "string") {
    return new Uint8Array(base64ToArrayBuffer(data));
  }
  throw new Error("unsupported blob payload");
}

export function createSceneEngine({
  client,
  rwId,
  reconciler,
  mirror,
  cache,
  callbacks = {},
  gate = null,
}) {
  const session = client.getConnection().getSession();
  const commandHandlers = new Map(); // name -> Set(callback)
  // The deadline bounds a resource that never arrives; a slow one must not
  // hit it, so it sits well above any delivery the caller would still wait
  // for (the caller asks for a resend long before this).
  const holdMs = gate?.holdMs ?? 3000;

  let mySeq = -1;
  // The seq of the last message routed in order (applied or held); the
  // consistency rule runs against it so messages behind a held one queue
  // instead of reading as a gap.
  let routedSeq = -1;
  let held = []; // { message, deadline }, in seq order
  let holdTimer = null;
  let live = false;
  let buffer = [];
  let subscription = null;
  let resyncVersion = 0;
  let resyncInFlight = false;
  let stopped = false;
  let lastAppliedOp = null;

  // Blobs ride broadcasts for every ref entering the live set (the message
  // is shared across clients), so a ref this client already holds — and may
  // have bound — is kept, not overwritten.
  function ingestBlobs(blobs) {
    for (const [ref, data] of Object.entries(blobs || {})) {
      if (!cache.has(ref)) {
        cache.set(ref, toUint8Copy(data));
      }
    }
  }

  function recordLastOp(ops) {
    if (ops && ops.length) {
      const last = ops[ops.length - 1];
      lastAppliedOp = { kind: last.op };
      if (last.id !== undefined) {
        lastAppliedOp.id = String(last.id);
      }
    }
  }

  function dispatchCommands(commands) {
    let renderRequested = false;
    for (const command of commands || []) {
      const name = command?.name;
      const handlers = commandHandlers.get(name);
      if (handlers) {
        for (const handler of [...handlers]) {
          try {
            handler(command.payload, name);
          } catch (error) {
            console.warn(
              `[sceneEngine] command handler ${name} failed:`,
              error,
            );
          }
        }
      }
      callbacks.onCommand?.(name, command?.payload);
      renderRequested = renderRequested || command?.render === true;
    }
    return renderRequested;
  }

  function applyOpsMessage(message) {
    ingestBlobs(message.blobs);
    const ops = message.ops || [];
    reconciler.applyMessage(ops, mirror, cache);
    // patchArray re-points its cache slot in place, so only upserts and
    // removes can strand a cached blob — skip the full live-ref walk for
    // the pure-patch messages a drag emits every move.
    if (ops.some((op) => op.op !== "patchArray")) {
      mirror.gcBlobCache(cache);
    }
    mySeq = message.seq;
    recordLastOp(ops);
    const renderRequested = dispatchCommands(message.commands);
    callbacks.onApplied?.(message);
    if (renderRequested) {
      callbacks.onRenderRequested?.(message);
    }
  }

  function applyRouted(message) {
    try {
      applyOpsMessage(message);
    } catch (error) {
      console.warn(`[sceneEngine] apply failed: ${error.message}`);
      resync("apply-failed", { reset: true });
    }
  }

  function shouldHold(message) {
    try {
      return gate?.hold?.(message) === true;
    } catch (error) {
      console.warn(`[sceneEngine] gate failed: ${error.message}`);
      return false;
    }
  }

  function clearHeld() {
    held = [];
    clearTimeout(holdTimer);
    holdTimer = null;
  }

  function armHoldTimer() {
    clearTimeout(holdTimer);
    holdTimer = null;
    if (!held.length) return;
    const delay = Math.max(0, held[0].deadline - Date.now());
    holdTimer = setTimeout(() => {
      holdTimer = null;
      drainHeld();
    }, delay);
  }

  // Apply held messages in order until one the gate still holds before its
  // deadline. A message past its deadline applies whatever the gate says.
  function drainHeld() {
    while (held.length && live && !stopped) {
      const { message, deadline } = held[0];
      if (Date.now() < deadline && shouldHold(message)) break;
      held.shift();
      applyRouted(message);
    }
    armHoldTimer();
  }

  function retryHeld() {
    if (held.length) drainHeld();
  }

  function routeMessage(message) {
    if (message.seq <= routedSeq) {
      return;
    }
    if (message.baseSeq !== routedSeq) {
      resync("seq-gap");
      return;
    }
    routedSeq = message.seq;
    if (held.length || shouldHold(message)) {
      held.push({ message, deadline: Date.now() + holdMs });
      if (held.length === 1) armHoldTimer();
      return;
    }
    applyRouted(message);
  }

  function handleMessage(message) {
    if (!message || String(message.rw) !== rwId) {
      return;
    }
    if (message.v !== PROTOCOL_VERSION) {
      console.warn(
        `[sceneEngine] unsupported protocol version ${message.v}; ` +
          `expected ${PROTOCOL_VERSION}`,
      );
      return;
    }
    if (!live) {
      // Not live and nothing in flight means an earlier resync failed;
      // an incoming op is the cue to try again.
      if (!resyncInFlight && !stopped) {
        resync("ops-before-live");
      }
      buffer.push(message);
      return;
    }
    routeMessage(message);
  }

  async function resync(reason = "client-request", { reset = false } = {}) {
    if (stopped) {
      return false;
    }
    if (reason !== "initial") {
      console.warn(`[sceneEngine] resync: ${reason}`);
    }
    const version = ++resyncVersion;
    resyncInFlight = true;
    live = false;
    buffer = [];
    clearHeld();
    try {
      if (reset) {
        // Instances and mirror may have diverged mid-message; rebuild from
        // scratch. The blob cache stays — its content refs are still valid.
        reconciler.reset(mirror);
      }
      const snapshot = await session.call(RESYNC_RPC, [
        rwId,
        [...cache.keys()],
      ]);
      if (version !== resyncVersion || stopped) {
        return false;
      }
      if (
        !snapshot ||
        snapshot.v !== PROTOCOL_VERSION ||
        String(snapshot.rw) !== rwId
      ) {
        console.warn("[sceneEngine] invalid resync snapshot", snapshot);
        return false;
      }

      callbacks.beforeSnapshot?.();
      let applied = false;
      try {
        ingestBlobs(snapshot.blobs);
        reconciler.applySnapshot(snapshot.nodes || {}, mirror, cache);
        mirror.gcBlobCache(cache);
        mySeq = snapshot.seq;
        routedSeq = mySeq;
        lastAppliedOp = { kind: "snapshot" };
        applied = true;
      } catch (error) {
        console.warn(`[sceneEngine] snapshot apply failed: ${error.message}`);
      } finally {
        callbacks.afterSnapshot?.(applied);
      }
      if (!applied) {
        return false;
      }

      callbacks.onSnapshotApplied?.(snapshot);
      // Retained commands describe client-owned state layered on top of the
      // snapshot, so dispatch only after the scene and cursor are current.
      if (dispatchCommands(snapshot.commands)) {
        callbacks.onRenderRequested?.(snapshot);
      }
      live = true;
      const pending = buffer;
      buffer = [];
      for (const message of pending) {
        routeMessage(message);
        if (!live) {
          // A drained message kicked off a fresh resync; the rest of this
          // batch is superseded by that resync's own buffer.
          break;
        }
      }
      return true;
    } catch (error) {
      if (version === resyncVersion && !stopped) {
        console.warn("[sceneEngine] resync call failed", error);
      }
      return false;
    } finally {
      if (version === resyncVersion) {
        resyncInFlight = false;
      }
    }
  }

  function start() {
    subscription = session.subscribe(TOPIC, ([message]) => {
      handleMessage(message);
    });
    resync("initial");
  }

  function stop() {
    stopped = true;
    resyncVersion += 1;
    resyncInFlight = false;
    live = false;
    buffer = [];
    clearHeld();
    if (subscription) {
      session.unsubscribe(subscription);
      subscription = null;
    }
  }

  function onCommand(name, callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    let handlers = commandHandlers.get(name);
    if (!handlers) {
      handlers = new Set();
      commandHandlers.set(name, handlers);
    }
    handlers.add(callback);
    return () => {
      handlers.delete(callback);
      if (!handlers.size) {
        commandHandlers.delete(name);
      }
    };
  }

  // The client's applied seq. Stamped onto every upstream event (gesture,
  // camera) so the server can run the generic staleness check
  // `event.seq >= store.last_seq_touching(nodeId)`.
  function getSeq() {
    return mySeq;
  }

  function getDiagnostics() {
    return {
      mySeq,
      live,
      cacheSize: cache.size,
      mirrorSize: mirror.size(),
      lastAppliedOp,
      bufferLength: buffer.length,
      heldLength: held.length,
    };
  }

  return {
    start,
    stop,
    resync,
    onCommand,
    retryHeld,
    getSeq,
    getDiagnostics,
  };
}
