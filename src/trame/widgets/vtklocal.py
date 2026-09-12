from __future__ import annotations

from typing import TYPE_CHECKING

from trame_vtklocal.widgets.vtklocal import *  # noqa F403
from trame_vtklocal.widgets.vtkjs_view import *  # noqa F403
from trame_vtklocal.widgets.vtkjs_shared_view import *  # noqa F403

if TYPE_CHECKING:
    from trame_vtklocal.module.protocol import ModuleHostServer


def initialize(server: ModuleHostServer) -> None:
    from trame_vtklocal import module

    server.enable_module(module)
