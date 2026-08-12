from trame_client.utils.version import get_version

__version__ = get_version("trame-vtklocal")

__all__ = [
    "PointCloudSource",
    "StreamedSceneActor",
    "Tiles3DSource",
    "__version__",
]


def __getattr__(name):
    # Keep package import VTK-free for users that only consume the web assets;
    # the public actor API naturally requires the optional VTK dependency.
    if name in {"PointCloudSource", "StreamedSceneActor", "Tiles3DSource"}:
        from trame_vtklocal import streamed_scene

        return getattr(streamed_scene, name)
    raise AttributeError(name)
