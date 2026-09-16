"""Scene publisher for push sync v2: dirty candidates → nodes → broadcast.

``ScenePublisher`` owns the authoritative :class:`~trame_vtklocal.store.SceneStore`
for one render window. A publish tick consumes dirty candidates from the
:class:`~trame_vtklocal.widgets.dirty_tracker.DirtyTracker`, refreshes those
objects' object-manager states, translates them into flat nodes, applies the
hot-array auto region diff, commits through ``store.transact()``, and
broadcasts one ``scene.ops`` message to every client (wslink publish, no
per-client state, no client targeting).

Wire protocol v2:

- broadcast topic ``scene.ops``:
  ``{"v": 2, "rw", "baseSeq", "seq", "ops", "blobs", "commands"?}``
- RPC ``scene.resync(rw_id, known_refs)`` →
  ``{"v": 2, "rw", "seq", "root", "nodes", "blobs"}`` where ``blobs`` inlines
  only live refs the client did not report.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterable, Iterator, Mapping
from contextlib import contextmanager
from typing import TYPE_CHECKING

from trame_vtklocal.module.node_translator import (
    node_ref_ids,
    scene_reader,
    translate_object,
    translate_scene,
)
from trame_vtklocal.module.node_arrays import restore_dataset_blobs
from trame_vtklocal.module.state_cache import ParsedStateCache
from trame_vtklocal.store import REF_CELLS_PREFIX, SceneStore
from trame_vtklocal.widgets.blob_payloads import (
    attach_binary,
    nodes_reference_missing_blob,
    pack_cell_array_payload,
    resolve_ref_payload,
)
from trame_vtklocal.widgets.dirty_tracker import DirtyTracker
from trame_vtklocal.widgets.hot_arrays import (
    DEFAULT_HOT_ARRAY_KEYS,
    HotArrayDiffer,
    commit_hot_array_batch,
    live_dataset_array,
)

if TYPE_CHECKING:
    from vtkmodules.vtkCommonExecutionModel import vtkAlgorithm
    from vtkmodules.vtkRenderingCore import vtkRenderWindow
    from vtkmodules.vtkSerializationManager import vtkObjectManager

    from trame_vtklocal.store import (
        CommitResult,
        SceneNode,
        SceneOp,
        WirePayload,
    )
    from trame_vtklocal.widgets.blob_payloads import NumericArray
    from trame_vtklocal.widgets.dirty_batch import DirtyBatch
    from trame_vtklocal.wire import (
        OpsMessage,
        OpsPublisher,
        PushViewHost,
        ResyncPayload,
        SceneCommand,
    )

WIRE_VERSION = 2
OPS_TOPIC = "scene.ops"


def event_is_current(
    store: SceneStore, event: object, node_id: str | int | None, strict: bool = True
) -> bool:
    """Whether a seq-stamped client event is current for one scene node.

    The event's ``seq`` (the client's applied cursor when it built the event)
    must be an int at or above the node's last touch — array patches count,
    they move the points a pick measures (``strict=False`` skips them, for
    mid-gesture events whose own confirmations ride this channel).

    The node is always named by the caller: a client gesture reports the whole
    list of nodes its measurement depended on, and each is checked in turn.
    An unknown or removed node is stale.
    """
    if not isinstance(event, Mapping):
        return False
    seq = event.get("seq")
    if isinstance(seq, bool) or not isinstance(seq, int):
        return False
    if node_id is None:
        return False
    last_seq = store.last_seq_touching(node_id, strict=strict)
    if last_seq is None:
        return False
    return seq >= last_seq


_REQUIRED_MANAGER_METHODS = (
    "UpdateStateFromObject",
    "UpdateStatesFromObjects",
    "GetAllDependencies",
    "GetState",
    "GetObjectAtId",
    "GetBlob",
)


class ScenePublisher:
    """Server-authoritative broadcast publisher for one render window."""

    def __init__(
        self,
        server: object,
        object_manager_api: PushViewHost,
        render_window: vtkRenderWindow,
        rw_id: int | str,
        hot_array_keys: Iterable[str] | None = None,
    ) -> None:
        self._server = server
        self._api: PushViewHost | None = object_manager_api
        self._render_window = render_window
        self._rw_id = int(rw_id)
        self._rw_str = str(rw_id)
        self._store = SceneStore(self._rw_str)
        self._state_cache = ParsedStateCache()
        self._class_names: dict[str, str] = {}
        # A c2: ref names its two content hashes, so its packed bytes never
        # change while the ref is live; entries leave with the ref.
        self._packed_cells: dict[str, bytes] = {}

        self._hot_arrays = HotArrayDiffer(
            self._live_hot_array,
            hot_keys=(
                DEFAULT_HOT_ARRAY_KEYS if hot_array_keys is None else hot_array_keys
            ),
        )
        self._pending_commands: list[SceneCommand] = []
        self._retained_commands: dict[str, SceneCommand] = {}
        self._transaction_depth = 0
        self._publish_scheduled = False
        self._disposed = False
        self._loop: asyncio.AbstractEventLoop | None
        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None

        object_manager = self._object_manager
        for name in _REQUIRED_MANAGER_METHODS:
            if not hasattr(object_manager, name):
                raise RuntimeError(f"Push sync requires vtkObjectManager.{name}")

        self._tracker = DirtyTracker(
            object_manager, self._rw_id, on_dirty=self._schedule_publish
        )

        object_manager_api.register_push_view(self._rw_id, self)

        # Populate the store eagerly so resync is a snapshot read, never a
        # fresh translation. Blob prune once at construction so stale blobs
        # from pre-publisher serialization don't hide from targeted GC.
        self._prune_object_manager(include_blobs=True)
        self._refresh_window_states()
        self._tracker.sync_observers()
        self._refresh_translation_cache_index()
        self._store.transact().upsert_nodes(self._translate_full_scene()).commit()
        self._notify_blob_registry(frozenset())

    def sync(self) -> None:
        """Force a publish now (includes an mtime sweep healing missed marks)."""
        if self._disposed or self._transaction_depth:
            return
        self._tracker.sweep()
        self._publish_tick()

    @contextmanager
    def transaction(self) -> Iterator[ScenePublisher]:
        """Batch mutations (and commands) into a single commit + broadcast."""
        self._transaction_depth += 1
        try:
            yield self
        finally:
            self._transaction_depth -= 1
            if self._transaction_depth == 0 and not self._disposed:
                self._tracker.sweep()
                self._publish_tick()

    def send_command(
        self,
        name: str,
        payload: object = None,
        *,
        retain: bool = False,
        render: bool = True,
    ) -> None:
        """Queue a command to ride the next broadcast, ordered with scene ops.

        If nothing else is pending, the next tick mints a seq and sends an
        empty-ops message; ``render=False`` skips the client repaint.
        """
        command: SceneCommand = {"name": str(name), "payload": payload}
        if render:
            command["render"] = True
        self._pending_commands.append(command)
        if retain:
            if payload is None:
                self._retained_commands.pop(command["name"], None)
            else:
                self._retained_commands[command["name"]] = command.copy()
        self._schedule_publish()

    def clear_retained_command(self, name: str) -> None:
        self._retained_commands.pop(str(name), None)

    def resync(self, known_refs: Iterable[str] | None = None) -> ResyncPayload:
        """Full snapshot for one client; blobs omit the client's known refs."""
        self.sync()
        snapshot = self._store.snapshot()
        known = {str(ref) for ref in (known_refs or ())}
        blobs: dict[str, WirePayload] = {
            ref: self._resolve_ref_payload(ref)
            for ref in sorted(self._store.live_refs() - known)
        }
        payload: ResyncPayload = {
            "v": WIRE_VERSION,
            "rw": self._rw_str,
            "seq": snapshot["seq"],
            "root": snapshot["root"],
            "nodes": snapshot["nodes"],
            "blobs": blobs,
        }
        if self._retained_commands:
            payload["commands"] = list(self._retained_commands.values())
        self._attach_binary(payload)
        return payload

    def last_seq_touching(self, node_id: str | int, strict: bool = True) -> int | None:
        return self._store.last_seq_touching(node_id, strict=strict)

    def event_is_current(
        self, event: object, node_id: str | int | None, strict: bool = True
    ) -> bool:
        """Whether a seq-stamped client event is current (see module helper)."""
        return event_is_current(self._store, event, node_id, strict=strict)

    @property
    def store(self) -> SceneStore:
        return self._store

    def cleanup(self) -> None:
        if self._disposed:
            return
        self._disposed = True
        self._tracker.cleanup()
        if self._api is not None:
            self._api.unregister_push_view(self._rw_id)
        self._api = None
        self._hot_arrays.clear()
        self._pending_commands.clear()
        self._retained_commands.clear()
        self._state_cache.clear()
        self._class_names.clear()
        self._packed_cells.clear()

    def _schedule_publish(self) -> None:
        if self._disposed or self._publish_scheduled:
            return
        loop = self._loop
        if loop is None or loop.is_closed():
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                # No loop: a later sync()/resync() flushes.
                return
            self._loop = loop
        self._publish_scheduled = True
        loop.call_soon_threadsafe(self._run_scheduled_publish)

    def _run_scheduled_publish(self) -> None:
        self._publish_scheduled = False
        if not self._disposed:
            self._publish_tick()

    def _publish_tick(self) -> None:
        if self._disposed or self._transaction_depth:
            return
        self._publish_scheduled = False
        batch = self._tracker.consume()
        commands = self._pending_commands
        self._pending_commands = []
        if not batch and not commands:
            return

        result = self._commit_batch(batch) if batch else None
        try:
            self._broadcast(result, commands)
        finally:  # the store committed; release its refs even if this raised
            self._after_publish(batch, result)

    def _commit_batch(self, batch: DirtyBatch) -> CommitResult:
        # The fast path only reads VTK (GetObjectAtId/GetPoints/GetData), but
        # it is still VTK work done on our behalf: suppressing makes that a
        # contract instead of a property nobody re-checks.
        with self._tracker.suppress():
            fast_result = commit_hot_array_batch(
                batch, self._object_manager, self._store, self._hot_arrays
            )
        if fast_result is not None:
            return fast_result
        # Every VTK touch below is serialization work.
        with self._tracker.suppress():
            self._update_pipeline_producers(batch.producers)
            self._refresh_object_states(batch.refresh_ids)
            if batch.structural:
                # Translation reads class names from the live dependency set,
                # so rebuild it before translating added objects.
                self._tracker.sync_observers()
                self._refresh_translation_cache_index()
            nodes = self._translate_candidates(batch.candidates)
        tx = self._store.transact()
        for node_id, node in nodes.items():
            self._hot_arrays.apply(node_id, node, self._store.get(node_id), tx)
        tx.upsert_nodes(nodes)
        return tx.commit()

    def _broadcast(
        self, result: CommitResult | None, commands: list[SceneCommand]
    ) -> None:
        protocol: OpsPublisher | None = getattr(self._server, "protocol", None)
        if protocol is None:
            return
        ops: list[SceneOp]
        blobs: dict[str, WirePayload]
        if result is not None and result["ops"]:
            base_seq, seq = result["base_seq"], result["seq"]
            ops = result["ops"]
            blobs = {
                ref: self._resolve_ref_payload(ref)
                for ref in sorted(result["blob_refs_entering"])
            }
        elif commands:
            base_seq, seq = self._store.advance()
            ops, blobs = [], {}
        else:
            return

        message: OpsMessage = {
            "v": WIRE_VERSION,
            "rw": self._rw_str,
            "baseSeq": base_seq,
            "seq": seq,
            "ops": ops,
            "blobs": blobs,
        }
        if commands:
            message["commands"] = list(commands)
        self._attach_binary(message)
        protocol.publish(OPS_TOPIC, message)

    def _after_publish(self, batch: DirtyBatch, result: CommitResult | None) -> None:
        if result is not None:
            for op in result["ops"]:
                if op["op"] == "remove":
                    self._hot_arrays.drop(op["id"])
                    self._state_cache.drop(op["id"])
        leaving = self._hot_arrays.take_released_refs()
        if result is not None:
            leaving |= result["refs_leaving"]
        for ref in leaving:
            self._packed_cells.pop(ref, None)
        self._notify_blob_registry(leaving)
        # A structural batch already rebuilt the observer graph and both index
        # caches in _commit_batch, before translation; nothing between there
        # and here touches VTK, so repeating that O(scene) pass is pure waste.
        if batch and not batch.structural:
            self._tracker.refresh_dataset_children(batch.candidates)

    # ------------------------------------------------------------------
    # Object-manager choreography
    # ------------------------------------------------------------------

    @property
    def _object_manager(self) -> vtkObjectManager:
        api = self._api
        if api is None:
            raise RuntimeError("scene publisher is disposed")
        return api.vtk_object_manager

    def _prune_object_manager(self, include_blobs: bool = False) -> None:
        # vtkObjectManager retains every state/blob it has ever seen; dead
        # objects and states are pruned per tick, blobs only at construction
        # (a per-frame PruneUnusedBlobs sweep grows with uptime — the blob
        # registry retires them with targeted UnRegisterBlob instead).
        methods: tuple[str, ...] = ("PruneUnusedObjects", "PruneUnusedStates")
        if include_blobs:
            methods = (*methods, "PruneUnusedBlobs")
        for name in methods:
            prune = getattr(self._object_manager, name, None)
            if prune is not None:
                prune()

    def _refresh_window_states(self) -> None:
        """Render + refresh the whole window's serialized states (eager init)."""
        object_manager = self._object_manager
        with self._tracker.suppress():
            if hasattr(self._render_window, "Render"):
                self._render_window.Render()
            object_manager.UpdateStatesFromObjects([self._rw_id])
        self._prune_object_manager()

    def _refresh_object_states(self, refresh_ids: Iterable[str]) -> None:
        """Refresh serialized states (caller holds the serialization scope).

        UpdateStateFromObject can fire ModifiedEvent on observed objects —
        the commit-wide suppression swallows those re-entrant marks.
        Refreshing a state re-serializes its dependencies, which registers
        structurally-added objects with the object manager.
        """
        object_manager = self._object_manager
        manager_ids: set[int] = set()
        object_id: str | int
        for object_id in refresh_ids:
            try:
                manager_ids.add(int(str(object_id)))
            except (TypeError, ValueError):
                continue
        for object_id in sorted(manager_ids):
            object_manager.UpdateStateFromObject(object_id)
            self._state_cache.drop(object_id)
        self._prune_object_manager()

    def _update_pipeline_producers(self, producers: Mapping[int, vtkAlgorithm]) -> None:
        # producer.Update() can fire ModifiedEvent downstream; the
        # commit-wide suppression keeps those out of the next tick.
        for producer in producers.values():
            update = getattr(producer, "Update", None)
            if update is not None:
                update()

    # ------------------------------------------------------------------
    # Translation
    # ------------------------------------------------------------------

    def _translate_full_scene(self) -> dict[str, SceneNode]:
        with self._tracker.suppress():
            return translate_scene(
                self._object_manager,
                self._rw_id,
                state_cache=self._state_cache,
                class_names=self._class_names,
            )

    def _translate_candidates(
        self, candidate_ids: Iterable[str]
    ) -> dict[str, SceneNode]:
        """Candidates plus transitively referenced ids missing from the store
        (caller holds the serialization scope)."""
        object_manager = self._object_manager
        known = self._store.node_ids()
        nodes: dict[str, SceneNode] = {}
        pending = [str(object_id) for object_id in candidate_ids]
        reader = scene_reader(
            object_manager,
            state_cache=self._state_cache,
            class_names=self._class_names,
        )
        while pending:
            node_id = pending.pop()
            if node_id in nodes:
                continue
            if object_manager.GetObjectAtId(int(node_id)) is None:
                continue
            node = translate_object(object_manager, int(node_id), reader=reader)
            if node is None:
                continue
            nodes[node_id] = node
            pending.extend(
                ref_id
                for ref_id in node_ref_ids(node)
                if ref_id not in nodes and ref_id not in known
            )
        # Only nodes new to the store can cite a dropped blob: a node
        # still in the store keeps its refs live, so its blobs are never
        # UnRegisterBlob'd. A module-singleton glyph source that left on
        # a landmark clear and re-enters on the rebuild returns with an
        # unchanged VTK MTime, so the object manager serves a cached,
        # blob-less state and never re-registers its content blob (a
        # per-object UpdateStateFromObject is a no-op). A full-window
        # re-serialize is the only call that re-registers it; the
        # content-addressed refs are unchanged, so the built nodes stay
        # valid — only the payloads they cite are repopulated.
        new_nodes = {
            node_id: node for node_id, node in nodes.items() if node_id not in known
        }
        if new_nodes and nodes_reference_missing_blob(
            object_manager, new_nodes.values()
        ):
            object_manager.UpdateStatesFromObjects([self._rw_id])
            if nodes_reference_missing_blob(object_manager, new_nodes.values()):
                for node_id, node in new_nodes.items():
                    restore_dataset_blobs(object_manager, node_id, node)
        return nodes

    def _refresh_translation_cache_index(self) -> None:
        self._class_names.clear()
        self._class_names.update(self._tracker.classes())
        self._state_cache.retain(self._class_names)

    def _live_hot_array(self, node_id: str, key: str) -> NumericArray | None:
        return live_dataset_array(self._object_manager, node_id, key)

    # ------------------------------------------------------------------
    # Blob payloads (see widgets/blob_payloads.py)
    # ------------------------------------------------------------------

    def _resolve_ref_payload(self, ref: str) -> bytes:
        if not ref.startswith(REF_CELLS_PREFIX):
            return resolve_ref_payload(self._object_manager, ref, self._live_hot_array)
        packed = self._packed_cells.get(ref)
        if packed is None:
            packed = pack_cell_array_payload(self._object_manager, ref)
            self._packed_cells[ref] = packed
        return packed

    def _attach_binary(self, message: OpsMessage | ResyncPayload) -> None:
        attach_binary(self._api, message)

    def _notify_blob_registry(self, refs_leaving: Iterable[str]) -> None:
        update = getattr(self._api, "update_push_view_refs", None)
        if update is not None:
            update(self._rw_id, self._store.live_refs(), refs_leaving)
