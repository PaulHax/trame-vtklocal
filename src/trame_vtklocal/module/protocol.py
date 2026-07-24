import asyncio
import zipfile
import json
import logging
from contextlib import ExitStack
from pathlib import Path
from wslink import register as export_rpc
from wslink.websocket import LinkProtocol

# from vtkmodules.vtkCommonCore import vtkLogger
from vtkmodules.vtkSerializationManager import vtkObjectManager
from vtkmodules.vtkCommonCore import vtkVersion

from trame_vtklocal.module import distance_to_camera as dtc
from trame_vtklocal.store import ref_manager_hashes

try:
    import zlib  # noqa

    ZIP_COMPRESSION = zipfile.ZIP_DEFLATED
except ImportError:
    ZIP_COMPRESSION = zipfile.ZIP_STORED

VTK_VERSION = vtkVersion()
logger = logging.getLogger(__name__)
# Stale blobs are retired in batches: verifying a hash is truly dead walks the
# whole shared object manager (GetAllDependencies(0) + GetBlobHashes), so a
# per-commit sweep would pay a full-scene walk on every landmark-drag move.
# Deferring only delays memory reclamation; protection is re-derived at flush
# time, so a hash that came back alive meanwhile is simply kept.
BLOB_GC_DEBOUNCE_SECONDS = 2.0
API_NO_IDS_UPDATE = (
    VTK_VERSION.GetVTKMajorVersion() <= 9
    and VTK_VERSION.GetVTKMinorVersion() <= 4
    and VTK_VERSION.GetVTKBuildVersion() < 20250509
)  # mr90034


def map_id_mtime(object_manager, vtk_id):
    vtk_obj = object_manager.GetObjectAtId(vtk_id)
    if vtk_obj is None:
        return (vtk_id, 0)
    return (vtk_id, vtk_obj.GetMTime())


def object_for_id(object_manager, obj_id):
    try:
        return object_manager.GetObjectAtId(int(obj_id))
    except (RuntimeError, TypeError, ValueError):
        return None


class ObjectManagerAPI(LinkProtocol):
    def __init__(self, *args, **kwargs):
        addon_serdes_registrars = kwargs.pop("addon_serdes_registrars", [])
        super().__init__(*args, **kwargs)
        self.vtk_object_manager = vtkObjectManager()
        self.vtk_object_manager.Initialize()
        for registrar in addon_serdes_registrars:
            self.vtk_object_manager.InitializeExtensionModuleHandler(registrar)
        self._subscriptions = {}
        self._widgets = {}
        self._last_publish_states = {}
        self._last_publish_hash = set()
        self._push_camera = False
        self._push_views = {}
        self._push_view_blob_hashes = {}
        self._pending_stale_blob_hashes = set()
        self._blob_gc_handle = None
        self._warned_missing_client_id = False

        self._debug_state = False
        self._debug_state_counter = 1

        # Debug - adjust verbosity
        # self.vtk_object_manager.SetObjectManagerLogVerbosity(
        #     vtkLogger.VERBOSITY_WARNING
        # )
        # self.vtk_object_manager.serializer.SetSerializerLogVerbosity(
        #     vtkLogger.VERBOSITY_WARNING
        # )

    def register_push_view(self, rw_id, publisher):
        """Register the ScenePublisher serving one render window."""
        rw_id = int(rw_id)
        self._push_views[rw_id] = publisher
        self._push_view_blob_hashes.setdefault(rw_id, set())

    def unregister_push_view(self, rw_id):
        rw_id = int(rw_id)
        self._push_views.pop(rw_id, None)
        self._push_view_blob_hashes.pop(rw_id, None)

    def update_push_view_refs(self, rw_id, live_refs, refs_leaving):
        """Queue retirement of vtkObjectManager blobs behind refs that left.

        The publisher hands the store's live ref set plus the exact refs that
        left it this commit (including hot-array refs it minted but never
        adopted). Refs strip to raw manager hashes (``v:`` refs have none);
        the stale hashes are batched and retired by a debounced
        :meth:`flush_stale_blobs`. This replaces per-frame
        ``PruneUnusedBlobs()``, whose sweep cost grows with the historical
        blob table.
        """
        rw_id = int(rw_id)
        current = ref_manager_hashes(live_refs)
        self._push_view_blob_hashes[rw_id] = current

        stale = ref_manager_hashes(refs_leaving) - current
        if not stale:
            return
        self._pending_stale_blob_hashes |= stale
        self._schedule_blob_gc()

    def _schedule_blob_gc(self):
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

    def _run_scheduled_blob_gc(self):
        self._blob_gc_handle = None
        self.flush_stale_blobs()

    def flush_stale_blobs(self):
        """UnRegister pending stale blobs not protected at flush time.

        Hashes still tracked by any push view or referenced by any live
        dependency of the shared object manager are kept — protection is
        computed here, not at queue time, so deferral can never retire a
        blob that came back alive.
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
        # Protect the globally live dependency set before unregistering.
        stale -= self._active_object_blob_hashes()
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

    def _all_tracked_push_blob_hashes(self):
        hashes = set()
        for live_hashes in self._push_view_blob_hashes.values():
            hashes.update(live_hashes)
        return hashes

    def _active_object_blob_hashes(self):
        with self._bypass_distance_to_camera_for_push_views():
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

    def _bypass_distance_to_camera_for_push_views(self):
        stack = ExitStack()
        try:
            for push_view in self._push_views.values():
                render_window = getattr(push_view, "_render_window", None)
                if render_window is not None:
                    stack.enter_context(
                        dtc.bypass_distance_to_camera_for_serialization(render_window)
                    )
            return stack
        except Exception:
            stack.close()
            raise

    def get_active_client_id(self):
        core_server = getattr(self, "coreServer", None)
        trame_server = getattr(core_server, "server", None)
        ws_server = getattr(trame_server, "_server", None)
        if ws_server is None or not hasattr(ws_server, "last_active_client_id"):
            if not self._warned_missing_client_id:
                logger.warning("Unable to resolve active wslink client id")
                self._warned_missing_client_id = True
            return None
        return ws_server.last_active_client_id

    def register_widget(self, root_obj, dep_obj):
        self.vtk_object_manager.RegisterObject(dep_obj)
        root_id = self.vtk_object_manager.GetId(root_obj)
        dep_id = self.vtk_object_manager.GetId(dep_obj)
        if root_id not in self._widgets:
            self._widgets[root_id] = set()

        self._widgets[root_id].add(dep_id)

    def unregister_widget(self, root_obj, dep_obj):
        self.vtk_object_manager.UnRegisterObject(dep_obj)
        root_id = self.vtk_object_manager.GetId(root_obj)
        dep_id = self.vtk_object_manager.GetId(dep_obj)
        if root_id in self._widgets:
            self._widgets[root_id].discard(dep_id)

    def get_all_ids(self, root_id):
        if root_id in self._widgets:
            return [root_id, *self._widgets[root_id]]
        return [root_id]

    def update(self, push_camera=False, obj_to_update=None, **_):
        self._push_camera = push_camera

        with self._bypass_distance_to_camera_for_push_views():
            if API_NO_IDS_UPDATE:  # <= 9.4.2
                self.vtk_object_manager.UpdateStatesFromObjects()
            else:  # > 9.4.2
                if obj_to_update is None:
                    self.vtk_object_manager.UpdateStatesFromObjects()
                else:
                    ids = [
                        self.vtk_object_manager.GetId(vtk_obj)
                        for vtk_obj in obj_to_update
                    ]
                    self.vtk_object_manager.UpdateStatesFromObjects(ids)

        if self._debug_state:
            self.vtk_object_manager.Export(f"snapshot-{self._debug_state_counter}")
            self._debug_state_counter += 1

        # Handle subscription push
        remove_from_subscriptions = []
        for obj_id, count in self._subscriptions.items():
            if count == 0:
                remove_from_subscriptions.append(obj_id)
            elif count > 0:
                status = self.get_status(obj_id)
                for state_id, mtime in status.get("ids", []):
                    if mtime > self._last_publish_states.get(state_id, 0):
                        self._last_publish_states[state_id] = mtime
                        self.publish(
                            "vtklocal.subscriptions",
                            dict(
                                type="state",
                                id=state_id,
                                mtime=mtime,
                                content=self.get_state(state_id),
                            ),
                        )
                for hash in status.get("hashes", []):
                    if hash not in self._last_publish_hash:
                        self._last_publish_hash.add(hash)
                        self.publish(
                            "vtklocal.subscriptions",
                            dict(type="blob", hash=hash, content=self.get_hash(hash)),
                        )

        for id_to_gc in remove_from_subscriptions:
            self._subscriptions.pop(id_to_gc)

    @property
    def active_ids(self):
        with self._bypass_distance_to_camera_for_push_views():
            return self.vtk_object_manager.GetAllDependencies(0)

    @export_rpc("vtklocal.subscribe.update")
    def update_subscription(self, obj_id, delta):
        if obj_id in self._subscriptions:
            self._subscriptions[obj_id] += delta
        elif delta > 0:
            self._subscriptions[obj_id] = delta

        if delta > 0:
            self._last_publish_states.clear()
            self._last_publish_hash.clear()

        # Keep track of widgets as well
        if obj_id in self._widgets:
            for w_id in self._widgets[obj_id]:
                self.update_subscription(w_id, delta)

    @export_rpc("vtklocal.get.state")
    def get_state(self, obj_id):
        return self.vtk_object_manager.GetState(obj_id)

    @export_rpc("vtklocal.get.hash")
    def get_hash(self, hash):
        return self.addAttachment(memoryview(self.vtk_object_manager.GetBlob(hash)))

    @export_rpc("scene.resync")
    def scene_resync(self, rw_id, known_refs=None):
        """Full scene snapshot for the requesting client (push sync v2).

        Returns ``{"v": 2, "rw", "seq", "root", "nodes", "blobs"}`` where
        ``blobs`` inlines content only for live refs missing from the
        client-reported ``known_refs``. The server keeps no per-client state:
        the snapshot is a read of the publisher's scene store.
        """
        rw_id = int(rw_id)
        publisher = self._push_views.get(rw_id)
        if publisher is None:
            raise RuntimeError(f"No registered publisher for render window {rw_id}")
        return publisher.resync(known_refs, client_id=self.get_active_client_id())

    @export_rpc("vtklocal.get.status")
    def get_status(self, obj_id):
        root_object = object_for_id(self.vtk_object_manager, obj_id)
        with dtc.bypass_distance_to_camera_for_serialization(root_object):
            ids = self.vtk_object_manager.GetAllDependencies(obj_id)

            # Add widgets ids without duplicate
            ids_width_deps = list(ids)
            if obj_id in self._widgets:
                for dep_id in self._widgets[obj_id]:
                    ids_width_deps += list(
                        self.vtk_object_manager.GetAllDependencies(dep_id)
                    )
            ids = list(set(ids_width_deps))

            hashes = self.vtk_object_manager.GetBlobHashes(ids)
        renderWindow = self.vtk_object_manager.GetObjectAtId(obj_id)
        ids_mtime = [map_id_mtime(self.vtk_object_manager, v) for v in ids]
        ignore_ids = []
        cameras = []
        force_push = []
        if renderWindow:
            interactor = self.vtk_object_manager.GetId(renderWindow.interactor)
            renderers = renderWindow.GetRenderers()
            for renderer in renderers:
                activeCamera = renderer.GetActiveCamera()
                cid = self.vtk_object_manager.GetId(activeCamera)
                if not self._push_camera:
                    ignore_ids.append(cid)
                else:
                    force_push.append(cid)
                cameras.append(cid)
        return dict(
            ids=ids_mtime,
            hashes=hashes,
            ignore_ids=ignore_ids,
            cameras=cameras,
            force_push=force_push,
            interactor=interactor,
        )

    def dump_data(self, output_file, wasm_ids):
        """
        Create file (zip) with WASM data
        """
        output_file = Path(output_file)
        output_file.parent.mkdir(parents=True, exist_ok=True)

        # Extract ids to save
        all_ids = set()
        for vtk_id in wasm_ids:
            all_ids.update(self.vtk_object_manager.GetAllDependencies(vtk_id))

        # Extract hash to save
        hashes = self.vtk_object_manager.GetBlobHashes(list(all_ids))

        with zipfile.ZipFile(output_file, "w", ZIP_COMPRESSION) as zipf:
            # Write info
            zipf.writestr(
                "vtk-wasm.json",
                json.dumps(
                    {
                        "vtk": VTK_VERSION.GetVTKVersion(),
                        "ids": wasm_ids,
                    }
                ),
            )
            # Write states
            zipf.mkdir("states")
            for vtk_id in all_ids:
                zipf.writestr(
                    f"states/{vtk_id}",
                    self.vtk_object_manager.GetState(vtk_id),
                )

            # Write blobs
            zipf.mkdir("blobs")
            for hash in hashes:
                zipf.writestr(
                    f"blobs/{hash}",
                    memoryview(self.vtk_object_manager.GetBlob(hash)),
                )


class ObjectManagerHelper:
    def __init__(self, trame_server, addon_serdes_registrars=None):
        self.trame_server = trame_server
        self.root_protocol = None
        self.api = ObjectManagerAPI(addon_serdes_registrars=addon_serdes_registrars)
        self.trame_server.add_protocol_to_configure(self.configure_protocol)

    def configure_protocol(self, protocol):
        self.root_protocol = protocol
        self.root_protocol.registerLinkProtocol(self.api)
