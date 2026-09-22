"""Push-view registration and shared object-manager blob retirement."""

from __future__ import annotations

import asyncio
from collections.abc import Iterable
from typing import TYPE_CHECKING

from trame_vtklocal.store import ref_manager_hashes

if TYPE_CHECKING:
    from vtkmodules.vtkSerializationManager import vtkObjectManager
    from trame_vtklocal.wire import PushView

BLOB_GC_DEBOUNCE_SECONDS = 2.0


class PushViewRegistry:
    """Shared blob ownership, independent of the legacy pull protocol."""

    vtk_object_manager: vtkObjectManager

    def _init_push_views(self) -> None:
        self._push_views: dict[int, PushView] = {}
        self._push_view_blob_hashes: dict[int, set[str]] = {}
        self._pending_stale_blob_hashes: set[str] = set()
        self._blob_gc_handle: asyncio.TimerHandle | None = None

    def register_push_view(self, rw_id: int | str, publisher: PushView) -> None:
        """Register the ScenePublisher serving one render window."""
        rw_id = int(rw_id)
        self._push_views[rw_id] = publisher
        self._push_view_blob_hashes.setdefault(rw_id, set())

    def unregister_push_view(self, rw_id: int | str) -> None:
        rw_id = int(rw_id)
        self._push_views.pop(rw_id, None)
        leaving = self._push_view_blob_hashes.pop(rw_id, set())
        self._pending_stale_blob_hashes.update(leaving)
        if leaving:
            self._schedule_blob_gc()

    def update_push_view_refs(
        self, rw_id: int | str, live_refs: Iterable[str], refs_leaving: Iterable[str]
    ) -> None:
        """Queue retirement of vtkObjectManager blobs behind refs that left.

        The publisher hands the store's live ref set plus the exact refs that
        left it this commit (including hot-array refs it minted but never
        adopted). Refs strip to raw manager hashes (``v:`` refs have none);
        the stale hashes are batched and retired by a debounced
        :meth:`flush_stale_blobs`.
        """
        rw_id = int(rw_id)
        current = ref_manager_hashes(live_refs)
        self._push_view_blob_hashes[rw_id] = current

        stale = ref_manager_hashes(refs_leaving) - current
        if not stale:
            return
        self._pending_stale_blob_hashes |= stale
        self._schedule_blob_gc()

    def _schedule_blob_gc(self) -> None:
        if self._blob_gc_handle is not None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No loop (sync tests, teardown): an explicit flush_stale_blobs()
            # or the next scheduling attempt under a loop flushes.
            return
        self._blob_gc_handle = loop.call_later(
            BLOB_GC_DEBOUNCE_SECONDS, self._run_scheduled_blob_gc
        )

    def _run_scheduled_blob_gc(self) -> None:
        self._blob_gc_handle = None
        self.flush_stale_blobs()

    def flush_stale_blobs(self) -> int:
        """UnRegister pending stale blobs not protected at flush time.

        Hashes still tracked by any push view or referenced by any live
        dependency of the shared object manager are kept — protection is
        computed here, not at queue time, so deferral can never retire a
        blob that came back alive. Dependency-protected hashes stay queued
        and are checked again by the next flush.
        """
        if self._blob_gc_handle is not None:
            self._blob_gc_handle.cancel()
            self._blob_gc_handle = None
        stale = self._pending_stale_blob_hashes
        self._pending_stale_blob_hashes = set()
        if not stale:
            return 0

        stale -= self._all_tracked_push_blob_hashes()
        if not stale:
            return 0

        # The object manager is shared with non-push subscriptions/widgets.
        # Protect the globally live dependency set before unregistering. A
        # dependency's state can keep naming a blob after the ref behind it
        # left (a hot-array patch leaves it until the next serialization), and
        # nothing queues the hash again when that state moves on, so it stays
        # queued for a later flush.
        protected = stale & self._active_object_blob_hashes()
        self._pending_stale_blob_hashes |= protected
        stale -= protected
        if not stale:
            return 0

        unregister = getattr(self.vtk_object_manager, "UnRegisterBlob", None)
        if unregister is None:
            return 0

        count = 0
        for hash_value in sorted(stale):
            try:
                if unregister(hash_value):
                    count += 1
            except (RuntimeError, TypeError, ValueError):
                pass
        return count

    def _all_tracked_push_blob_hashes(self) -> set[str]:
        hashes: set[str] = set()
        for live_hashes in self._push_view_blob_hashes.values():
            hashes.update(live_hashes)
        return hashes

    def _active_object_blob_hashes(self) -> set[str]:
        try:
            active_ids = list(self.vtk_object_manager.GetAllDependencies(0))
        except (RuntimeError, TypeError, ValueError):
            return set()
        try:
            return {
                str(value)
                for value in self.vtk_object_manager.GetBlobHashes(active_ids)
            }
        except (RuntimeError, TypeError, ValueError):
            return set()
