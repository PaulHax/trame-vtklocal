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
// Admission holds ordered messages until external resources are ready.
// Receipt and application use separate cursors; presentation callbacks
// observe only complete admitted prefixes.

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
  prepareAdmission = () => () => {},
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
  let receivedSeq = -1;
  let pending = [];
  let pendingBytes = 0;
  let appliedCommands = new Map();
  let flushing = false;

  function commandsAfter(commands, message) {
    const next = new Map(commands);
    for (const { name, payload } of message.commands || []) {
      if (payload == null) next.delete(name);
      else next.set(name, payload);
    }
    return next;
  }

  function messageBytes(value) {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
      return value.byteLength;
    if (typeof value === "string") return value.length * 2;
    if (value && typeof value === "object") {
      return Object.entries(value).reduce(
        (sum, [key, item]) => sum + key.length * 2 + messageBytes(item),
        0,
      );
    }
    return 8;
  }

  function enqueue(message, snapshot = false) {
    const bytes = messageBytes(message);
    pending.push({ message, snapshot, bytes });
    pendingBytes += bytes;
    receivedSeq = message.seq;
    flushAdmission();
    // Never discard individual deltas: recover through an authoritative snapshot.
    if (
      !snapshot &&
      (pending.length > 128 || pendingBytes > 64 * 1024 * 1024)
    ) {
      resync("admission-overflow");
    }
  }

  function flushAdmission() {
    if (flushing || stopped || !pending.length) return;
    flushing = true;
    try {
      let candidateCommands = appliedCommands;
      let admitted = null;
      for (let index = 0; index < pending.length; index += 1) {
        const entry = pending[index];
        candidateCommands = commandsAfter(
          entry.snapshot ? new Map() : candidateCommands,
          entry.message,
        );
        const commit = prepareAdmission(candidateCommands);
        if (commit) admitted = { index, commit, commands: candidateCommands };
      }
      if (!admitted) return;
      const batch = pending.splice(0, admitted.index + 1);
      for (const entry of batch) pendingBytes -= entry.bytes;
      // No asynchronous work between staging pixels and applying the full prefix.
      admitted.commit();
      let renderRequested = false;
      let snapshotApplied = false;
      for (const { message, snapshot } of batch) {
        if (snapshot) {
          callbacks.beforeSnapshot?.();
          let applied = false;
          try {
            ingestBlobs(message.blobs);
            reconciler.applySnapshot(message.nodes || {}, mirror, cache);
            mirror.gcBlobCache(cache);
            mySeq = message.seq;
            lastAppliedOp = { kind: "snapshot" };
            applied = true;
            snapshotApplied = true;
          } finally {
            callbacks.afterSnapshot?.(applied);
          }
          renderRequested =
            dispatchCommands(message.commands) || renderRequested;
        } else {
          renderRequested = applyOpsMessage(message) || renderRequested;
        }
      }
      appliedCommands = admitted.commands;
      const last = batch.at(-1).message;
      if (snapshotApplied) callbacks.onSnapshotApplied?.(last);
      else
        callbacks.onApplied?.({
          ...last,
          ops: batch.flatMap(({ message }) => message.ops || []),
        });
      if (renderRequested) callbacks.onRenderRequested?.(last);
    } catch (error) {
      console.warn(`[sceneEngine] admission apply failed: ${error.message}`);
      resync("apply-failed", { reset: true });
    } finally {
      flushing = false;
    }
  }

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
    return renderRequested;
  }

  function routeMessage(message) {
    if (message.seq <= receivedSeq) {
      return;
    }
    if (message.baseSeq !== receivedSeq) {
      resync("seq-gap");
      return;
    }
    try {
      enqueue(message);
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
    pending = [];
    pendingBytes = 0;
    receivedSeq = mySeq;
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

      enqueue(snapshot, true);
      if (version !== resyncVersion || stopped) return false;
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
    pending = [];
    pendingBytes = 0;
    appliedCommands.clear();
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
      receivedSeq,
      admissionLength: pending.length,
      admissionBytes: pendingBytes,
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
    flushAdmission,
    getSeq,
    getDiagnostics,
  };
}
