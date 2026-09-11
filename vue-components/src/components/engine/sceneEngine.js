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

import { textureGraphAfter, requiredTextures } from "./textureRequirements";

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
  limits = {},
}) {
  const maxMessages = limits.messages ?? 128;
  const maxBytes = limits.bytes ?? 64 * 1024 * 1024;
  const maxSnapshotBytes = limits.snapshotBytes ?? 256 * 1024 * 1024;
  const session = client.getConnection().getSession();
  const commandHandlers = new Map(); // name -> Set(callback)

  let mySeq = -1;
  let live = false;
  let buffer = [];
  let bufferBytes = 0;
  let bufferOverflow = false;
  let recoveryAttempts = 0;
  let recoveryTimer = null;
  let syncFailure = null;
  let needsReset = false;
  let subscription = null;
  let resyncVersion = 0;
  let resyncInFlight = false;
  let stopped = false;
  let lastAppliedOp = null;
  let receivedSeq = -1;
  let pending = [];
  let pendingBytes = 0;
  let appliedCommands = new Map();
  let appliedTextureGraph = new Map();
  let flushing = false;
  const admissionWork = { batches: 0, messages: 0, totalMs: 0, maxMs: 0 };

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

  function enqueue(message, snapshot = false, reset = false) {
    const entry = { message, snapshot, reset, bytes: 0 };
    pending.push(entry);
    receivedSeq = message.seq;
    flushAdmission();
    // Only walk payloads that actually wait. Unconditionally sizing a large
    // immediately admissible scene would add work to the normal render path.
    if (pending.at(-1) === entry) {
      entry.bytes = messageBytes(message);
      pendingBytes += entry.bytes;
    }
    // Never discard individual deltas: recover through an authoritative snapshot.
    if (snapshot && pendingBytes > maxSnapshotBytes) {
      pending = [];
      pendingBytes = 0;
      live = false;
      syncFailure = "snapshot-too-large";
      console.error(
        "[sceneEngine] waiting snapshot exceeds admission memory limit",
      );
    } else if (
      !snapshot &&
      (pending.length > maxMessages ||
        pendingBytes - (pending[0]?.snapshot ? pending[0].bytes : 0) > maxBytes)
    ) {
      recover("admission-overflow");
    }
  }

  function flushAdmission() {
    if (flushing || stopped || !pending.length) return;
    flushing = true;
    try {
      let candidateCommands = appliedCommands;
      let candidateGraph = appliedTextureGraph;
      let admitted = null;
      for (let index = 0; index < pending.length; index += 1) {
        const entry = pending[index];
        candidateCommands = commandsAfter(
          entry.snapshot ? new Map() : candidateCommands,
          entry.message,
        );
        candidateGraph = textureGraphAfter(
          candidateGraph,
          entry.message,
          entry.snapshot,
        );
        const commit = prepareAdmission(
          candidateCommands,
          requiredTextures(candidateGraph, rwId),
        );
        if (commit)
          admitted = {
            index,
            commit,
            commands: candidateCommands,
            graph: candidateGraph,
          };
      }
      if (!admitted) return;
      const batch = pending.splice(0, admitted.index + 1);
      for (const entry of batch) pendingBytes -= entry.bytes;
      // Includes staging, reconciliation and completion callbacks, not the
      // time spent waiting for images or the later GPU upload and paint.
      const previousSeq = mySeq;
      const applyStarted = performance.now();
      // No asynchronous work between staging pixels and applying the full prefix.
      admitted.commit();
      let renderRequested = false;
      let snapshotApplied = false;
      for (const { message, snapshot, reset } of batch) {
        if (snapshot) {
          callbacks.beforeSnapshot?.();
          let applied = false;
          try {
            if (reset) reconciler.reset(mirror);
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
      appliedTextureGraph = admitted.graph;
      const last = batch.at(-1).message;
      if (snapshotApplied) callbacks.onSnapshotApplied?.(last);
      else
        callbacks.onApplied?.(
          batch.length === 1
            ? last
            : {
                ...last,
                ops: batch.flatMap(({ message }) => message.ops || []),
              },
        );
      if (renderRequested) callbacks.onRenderRequested?.(last);
      needsReset = false;
      if (mySeq > previousSeq) recoveryAttempts = 0;
      syncFailure = null;
      const elapsed = performance.now() - applyStarted;
      admissionWork.batches += 1;
      admissionWork.messages += batch.length;
      admissionWork.totalMs += elapsed;
      admissionWork.maxMs = Math.max(admissionWork.maxMs, elapsed);
    } catch (error) {
      console.warn(`[sceneEngine] admission apply failed: ${error.message}`);
      recover("apply-failed", { reset: true });
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
      recover("seq-gap");
      return;
    }
    try {
      enqueue(message);
    } catch (error) {
      console.warn(`[sceneEngine] apply failed: ${error.message}`);
      recover("apply-failed", { reset: true });
    }
  }

  function handleMessage(message) {
    if (stopped || syncFailure) return;
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
        recover("ops-before-live");
      }
      if (!bufferOverflow) {
        const bytes = messageBytes(message);
        if (buffer.length >= maxMessages || bufferBytes + bytes > maxBytes) {
          buffer = [];
          bufferBytes = 0;
          bufferOverflow = true;
        } else {
          buffer.push(message);
          bufferBytes += bytes;
        }
      }
      return;
    }
    routeMessage(message);
  }

  function recover(reason, options = {}) {
    needsReset = needsReset || options.reset === true;
    if (stopped || syncFailure || recoveryTimer !== null) return;
    live = false;
    pending = [];
    pendingBytes = 0;
    if (resyncInFlight) {
      bufferOverflow = true;
      return;
    }
    if (recoveryAttempts >= 3) {
      syncFailure = reason;
      pending = [];
      pendingBytes = 0;
      buffer = [];
      bufferBytes = 0;
      console.error(`[sceneEngine] automatic resync exhausted: ${reason}`);
      return;
    }
    const delay =
      recoveryAttempts === 0 ? 0 : 1000 * 2 ** (recoveryAttempts - 1);
    recoveryAttempts++;
    if (!delay) {
      resync(reason, { ...options, automatic: true });
    } else {
      recoveryTimer = setTimeout(() => {
        recoveryTimer = null;
        resync(reason, { ...options, automatic: true });
      }, delay);
    }
  }

  async function resync(
    reason = "client-request",
    { reset = false, automatic = false } = {},
  ) {
    if (stopped) {
      return false;
    }
    if (reason !== "initial") {
      console.warn(`[sceneEngine] resync: ${reason}`);
    }
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
    if (!automatic) {
      recoveryAttempts = 0;
      syncFailure = null;
    }
    const version = ++resyncVersion;
    resyncInFlight = true;
    live = false;
    buffer = [];
    bufferBytes = 0;
    bufferOverflow = false;
    pending = [];
    pendingBytes = 0;
    receivedSeq = mySeq;
    try {
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

      if (bufferOverflow) return false;
      enqueue(snapshot, true, reset || needsReset);
      if (version !== resyncVersion || stopped || syncFailure || bufferOverflow)
        return false;
      live = true;
      const pending = buffer;
      buffer = [];
      bufferBytes = 0;
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
        if (!live && !stopped && !syncFailure)
          recover("resync-incomplete", { reset });
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
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
    bufferBytes = 0;
    resyncVersion += 1;
    resyncInFlight = false;
    live = false;
    buffer = [];
    pending = [];
    pendingBytes = 0;
    appliedCommands.clear();
    appliedTextureGraph.clear();
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
      admissionWork: { ...admissionWork },
      requiredTextures: [...requiredTextures(appliedTextureGraph, rwId)],
      live,
      cacheSize: cache.size,
      mirrorSize: mirror.size(),
      lastAppliedOp,
      bufferLength: buffer.length,
      bufferBytes,
      bufferOverflow,
      syncFailure,
      recoveryAttempts,
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
