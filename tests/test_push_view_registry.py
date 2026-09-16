"""Blob retirement on view teardown, including shared and pull consumers."""

from trame_vtklocal.module.push_views import PushViewRegistry


class Manager:
    def __init__(self):
        self.protected = set()
        self.removed = []

    def GetAllDependencies(self, _root):
        return [1]

    def GetBlobHashes(self, _ids):
        return self.protected

    def UnRegisterBlob(self, value):
        self.removed.append(value)
        return True


def registry():
    api = PushViewRegistry()
    api.vtk_object_manager = Manager()
    api._init_push_views()
    return api


def test_unregister_retires_view_only_hashes():
    api = registry()
    api.update_push_view_refs(1, ["c:unique", "c:shared"], [])
    api.update_push_view_refs(2, ["c:shared"], [])
    api.unregister_push_view(1)
    assert api.flush_stale_blobs() == 1
    assert api.vtk_object_manager.removed == ["unique"]
    api.unregister_push_view(2)
    assert api.flush_stale_blobs() == 1
    assert api.vtk_object_manager.removed == ["unique", "shared"]


def test_unregister_does_not_retire_live_pull_dependency():
    api = registry()
    api.update_push_view_refs(1, ["c:pull"], [])
    api.vtk_object_manager.protected.add("pull")
    api.unregister_push_view(1)
    assert api.flush_stale_blobs() == 0
