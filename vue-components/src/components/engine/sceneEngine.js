// Scene-ops client engine (push sync v2): subscribe-buffer-resync-drain
// lifecycle, the seq consistency rule, apply-on-arrival, blob-cache
// ownership, and command dispatch.
//
// Wire contract (see docs/DESIGN-scene-store.md):
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
}) {
  const session = client.getConnection().getSession();
  const commandHandlers = new Map(); // name -> Set(callback)

  let mySeq = -1;
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
    }
  }

  function applyOpsMessage(message) {
    ingestBlobs(message.blobs);
    reconciler.applyMessage(message.ops || [], mirror, cache);
    mirror.gcBlobCache(cache);
    mySeq = message.seq;
    recordLastOp(message.ops);
    dispatchCommands(message.commands);
    callbacks.onApplied?.(message);
  }

  function routeMessage(message) {
    if (message.seq <= mySeq) {
      return;
    }
    if (message.baseSeq !== mySeq) {
      resync("seq-gap");
      return;
    }
    try {
      applyOpsMessage(message);
    } catch (error) {
      console.warn(`[sceneEngine] apply failed: ${error.message}`);
      resync("apply-failed", { reset: true });
    }
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
    try {
      if (reset) {
        // Instances and mirror may have diverged mid-message; rebuild from
        // scratch. The blob cache stays — its content refs are still valid.
        reconciler.reset(mirror);
      }
      const snapshot = await session.call(RESYNC_RPC, [rwId, [...cache.keys()]]);
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

  function getDiagnostics() {
    return {
      mySeq,
      live,
      cacheSize: cache.size,
      mirrorSize: mirror.size(),
      lastAppliedOp,
      bufferLength: buffer.length,
    };
  }

  return {
    start,
    stop,
    resync,
    onCommand,
    getDiagnostics,
  };
}
