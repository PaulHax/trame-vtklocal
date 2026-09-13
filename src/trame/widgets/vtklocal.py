from trame_vtklocal.widgets.vtklocal import *  # noqa F403
from trame_vtklocal.widgets.vtkjs_view import *  # noqa F403
from trame_vtklocal.widgets.vtkjs_shared_view import *  # noqa F403
from trame_vtklocal import host_types as _host_types


def initialize(server: "_host_types.ModuleHostServer") -> None:
    from trame_vtklocal import module

    server.enable_module(module)
