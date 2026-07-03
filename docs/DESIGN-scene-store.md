# Push sync v2: flat scene store, broadcast ops, stateless clients

Status: accepted, in progress. Replaces `PushSync`/`PartialArrayLedger` and the
client message-queue machinery wholesale. No backward compatibility with the
v1 wire protocol.

## Goals

1. **Small server-side change → small diff → cheap client apply**, including a
   small mutation inside a big array, *without* app code calling a special
   partial-update API.
2. **Python keeps authority.** The server is the sole author of scene state.
   Clients render, report input, and (where declared) own transient camera
   matrices — nothing else.
3. **Resilient to browser refresh, tab pause/freeze/discard, and reconnects.**
4. **Multiple clients see the same scene** at marginal server cost ≈ network
   fan-out only.
5. **Footgun-proof by construction:** a new kind of translated state cannot be
   forgotten by the diff layer, because the diff layer is schema-agnostic.
6. **Stock-VTK ergonomics:** mutate VTK objects, they sync. Explicit calls
   become batching/performance controls, not correctness requirements.

## Why v1 had to go (one paragraph)

v1 computed diffs by re-translating candidate objects and deep-comparing them
against per-client deep-copied ledgers, classifying changes through a
hand-maintained `_object_patch_signature`, with a separate partial-array
channel whose synthetic-hash ledger had to be choreographed against the object
path (retire-before-translate, promote-all-clients-to-full on any mismatch).
Every new node block (pickable, distanceToCamera, …) had to be registered in
the translator, the signature, and the client applier — miss one and state
went silently stale (the landmark pickable/re-drag bugs). Diff cost was
O(scene) per client per patch; a single lagging client degraded every client
to full pushes.

## Architecture

Two cleanly separated problems:

- **A. Translation** (VTK-specific, table-driven, pure): VTK object → flat
  *node* dict. Same knowledge as today's `vtkjs_translator`, new output shape.
- **B. Replication** (generic, VTK-free): a versioned flat store of nodes with
  a 3-op diff protocol, broadcast to all clients.

```
VTK scene ──observers──> DirtyTracker (candidate ids, false-positives OK)
                              │ publish tick (coalesced per event-loop tick)
                              ▼
                    translate(candidates) → nodes
                              ▼
   SceneStore.transact(): upserts + auto array-region patches
        │ generic diff, reachability GC, seq++
        ▼
   broadcast {baseSeq, seq, ops, blobs, commands}  ──►  every client
                                                          │
                                            mirror store + reconcile applier
                                                          ▼
                                                   vtk.js instances
```

### Node shape (flat; the wire format IS the store format)

```jsonc
"37": {
  "type": "vtkActor",
  "props":  { "visibility": true, "userMatrix": [ ... ] },
  "refs":   { "mapper": "12", "textures": ["7"] },          // structure as data
  "arrays": { },                                             // datasets/mappers only
  "blocks": { "pickable": { "tags": {...}, "ids": [...] } }  // opaque feature blocks
}
```

- `refs` replaces v1's nested `dependencies` + imperative `calls`. Ref-slot
  order is significant (render order). The client derives add/remove calls
  from refs diffs against its mirror.
- `arrays` entries carry a **ref** (cache key), not content:
  `{"ref": "c:<contentHash>", "dataType": "Float32Array", "size": N,
    "numberOfComponents": 3, ...}`. Ref namespaces:
  - `c:<hash>` content-addressed blob (vtkObjectManager hash / md5 for
    field arrays)
  - `c2:<connHash>:<offHash>` packed vtk.js cell array derived from two blobs
  - `v:<id>:<key>:<n>` monotonically versioned identity for arrays that
    receive in-place region patches (no rehash on the hot path)
- `blocks` is the open extension point. **The store diffs every key of every
  section generically** — adding a new block requires only a translator emit
  and a client handler; the replication layer cannot miss it.

### Ops (the whole protocol)

| op | payload | client action |
|---|---|---|
| `upsert` | `id`, full `node` | diff vs mirror node locally; apply only what changed (props → `instance.set`, refs → add/remove calls, array ref change → rebind from cache, blocks → registered handlers) |
| `remove` | `id` | tear down instance, unregister, drop from mirror |
| `patchArray` | `id`, `key`, `offset`, `data`, `dataType`, `ref` | in-place `typedArray.set(data, offset)` + `modified()`; rebind cache entry to `ref` |

The server never classifies changes. "Node X is now exactly this" is the only
statement it makes about objects; fine-grained minimization happens on the
client against its mirror, where the comparison is a cheap local dict walk.

### Sequencing and resilience (stateless per client)

- One global monotonic `seq` per render window. Each broadcast carries
  `baseSeq`/`seq`. There is **no server-side per-client state** — no ledgers,
  epochs, known-hash sets, or collection trackers.
- Client rule (the entire consistency state machine):
  - `seq <= mySeq` → drop (duplicate)
  - `baseSeq == mySeq` → apply, `mySeq = seq`
  - otherwise → resync
- **Resync**: `scene.resync(rw, knownRefs) → {seq, root, nodes, blobs}` where
  `blobs` inlines only refs the client didn't report. Ops broadcast while the
  resync is in flight are buffered and replayed by the seq rule afterwards.
- Browser refresh → empty `knownRefs`, full snapshot. Tab **paused/throttled**
  → WebSocket messages still deliver; the client applies ops on arrival and
  renders on rAF/visibility, so state stays current with O(1) memory and a
  hidden tab never accumulates a queue. Tab **frozen/discarded** or socket
  drop → reconnect → resync (cheap: surviving `pushCache` refs are reported).
- Snapshot is `store.snapshot()` — a read of already-translated dicts, not a
  re-translation of the scene. Full and patch paths share one source of truth
  by construction (v1's oracle invariant becomes structural).

### Blob lifecycle

- An ops message inlines content for every `c:`/`c2:` ref that the pre-state
  did not reference (a blob "enters the live set" exactly once per entry).
  `patchArray` data always rides its op.
- The client refcounts refs from its mirror and GCs its cache locally —
  no server evict lists, no evict-vs-queued-full interplay.
- The server unregisters object-manager blobs from the transaction's
  `refs_leaving` delta (targeted, O(changed), like today's
  `update_push_view_blob_hashes` but exact).

### Automatic array-region diffs (kills `mark_modified`/`flush`)

Requirement: `pts.SetPoint(i, …); pts.Modified()` on a million-point array
must reach the client as a ~24-byte region patch with no special app API.

- Dirty capture is unchanged: array/dataset `ModifiedEvent` observers mark the
  owning dataset (stock-VTK contract: if a render would notice, we notice).
- On publish, for a dirty dataset array the publisher consults a **retained
  last-sent copy** (kept only for arrays that have actually mutated in place;
  first mutation pays one full send and starts retention):
  - `np.equal` compare → changed index span(s) → `patchArray(offset, data)`
    with the next `v:` ref. Compare runs at memcmp speed (~1–2 ms for 1M
    points); no content hashing on the hot path.
  - Shape/dtype change or compare above a size budget → fall back to full
    array resend under a fresh `c:` ref (still just an `upsert`).
- `view.hint_region(obj, key, start, count)` survives as an *optional*
  performance hint that skips the compare — never required for correctness.

### Commands and camera authority

- `view.send_command(name, payload)` rides the next broadcast's `commands`
  field (minting a seq if there are no ops), ordered atomically with the scene
  changes it belongs to. Client handlers register by name. This replaces v1's
  unversioned `extra` side channel and app-level camera outboxes.
- Each view declares camera authority:
  - `"server"`: camera is a normal synced node; client interactor emits
    seq-stamped camera events upstream.
  - `"client"` (telesculptor's mode): camera nodes are excluded from
    translation entirely; the server drives the view via command entities
    (e.g. a MapLibre camera command) and the client pushes rendered matrices
    into vtk.js per frame (`setRenderedCamera`), reporting them only inside
    self-contained events.
- **Every upstream event (pointer, camera) carries the client's `mySeq`** and,
  for picks, the picked node id. Server-side staleness is then generic:
  `event.seq >= store.last_seq_touching(nodeId)`. This retires app-level
  revision counters (`target_revision`/`check_revision`) and the re-tag
  choreography — a pickable block change is just a node touch that bumps the
  node's last-touched seq.

### Multiple clients

The diff is computed once per tick and broadcast; a client is only a cursor it
keeps itself. N clients cost the server one extra socket write each. A slow or
resyncing client affects nobody else.

### Python API (target ergonomics)

```python
view = VtkJsSharedView(render_window, camera_authority="client")
# mutate VTK objects as usual; observers coalesce a publish per event-loop tick
with view.transaction():        # optional batching across many mutations
    ...
await view.settled()            # test/synchronization barrier
view.sync()                     # force a publish now (frame transactions)
view.send_command("mapCamera", payload)
view.on_event(handler)          # seq-stamped gesture/camera events
```

`update()`, `mark_modified()`, `flush()`, `request_resync()` and the
full-vs-partial decision logic in apps are deleted.

## What this deletes

- Server: `_object_patch_signature`, setProperties/updateObject
  classification, per-client ledgers/epochs/sequences/known-hashes/trackers,
  promote-all-to-full, `PartialArrayLedger` choreography, ledger deep-copies,
  structural full-fallbacks, flush-ordering rules.
- Client: patch merging, gap timers, evict lists and their queued-full
  interplay, three message kinds, `pruneCacheToLiveFulls`.
- Apps (after migration): push coalescers' full-vs-partial logic, pickable
  MTime/signature dances, `on_structure_changed → request_resync` wiring,
  camera outboxes, revision-freeze protocols.

## Implementation phases

1. **SceneStore + transaction differ** (pure Python, no VTK) with
   property-tested mirror round-trip. `src/trame_vtklocal/store.py`.
2. **Translator → flat nodes**: rework `vtkjs_translator` output (`refs`
   instead of nesting/calls), port the oracle harness to compare stores.
3. **Publisher**: DirtyTracker (kept from v1) + translate-candidates +
   `store.transact()` + broadcast; `scene.resync` RPC; blob lifecycle; retained
   hot-array copies + auto region diff; commands. Delete `push_sync.py`.
4. **Client engine**: mirror store, reconcile applier (descriptor-driven),
   apply-on-arrival / render-on-rAF, resync state machine, block handler
   registry (pickable, distanceToCamera, projectedTexture).
5. **Events v2**: seq stamps in gesture/camera payloads; `last_seq_touching`
   staleness helper; view API (`transaction`/`sync`/`settled`/`send_command`,
   camera authority).
6. **App migration** (telesculptor-web): delete coalescer force-full logic,
   revision protocol, camera outbox; adopt `transaction()`.

Testing: store unit + property tests (Phase 1); oracle harness asserting
`client mirror == server store` (Phase 2+); existing app e2e suite (Phase 6).
