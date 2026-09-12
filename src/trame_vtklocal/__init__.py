from __future__ import annotations

from typing import TYPE_CHECKING, Union

from trame_client.utils.version import get_version

if TYPE_CHECKING:
    from trame_vtklocal.streamed_scene import (
        PointCloudSource,
        StreamedSceneActor,
        Tiles3DSource,
    )

__version__: str = get_version("trame-vtklocal")

__all__ = [
    "PointCloudSource",
    "StreamedSceneActor",
    "Tiles3DSource",
    "__version__",
]


def __getattr__(
    name: str,
) -> type[Union[PointCloudSource, StreamedSceneActor, Tiles3DSource]]:
    # Keep package import VTK-free for users that only consume the web assets;
    # the public actor API naturally requires the optional VTK dependency.
    if name in {"PointCloudSource", "StreamedSceneActor", "Tiles3DSource"}:
        from trame_vtklocal import streamed_scene

        public_type: type[Union[PointCloudSource, StreamedSceneActor, Tiles3DSource]]
        public_type = getattr(streamed_scene, name)
        return public_type
    raise AttributeError(name)
