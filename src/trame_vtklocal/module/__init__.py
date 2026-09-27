from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from trame_vtklocal.module.protocol import ObjectManagerHelper

if TYPE_CHECKING:
    from trame_vtklocal.host_types import NamedServer, ProtocolHostServer

# trame's enable_module() reads serve/scripts/vue_use/setup off this module by
# name, so every one of them is load-bearing despite having no in-tree caller.
__all__ = [
    "serve",
    "scripts",
    "vue_use",
    "setup",
    "get_helper",
]

serve_root = Path(__file__).with_name("serve").resolve()
serve_path = str(serve_root)


def _versioned_asset(asset_name: str) -> str:
    asset_path = serve_root / "js" / asset_name
    version = int(asset_path.stat().st_mtime)
    return f"__trame_vtklocal/js/{asset_name}?v={version}"


serve = {"__trame_vtklocal": serve_path}
scripts = [_versioned_asset("trame_vtklocal.umd.js")]
vue_use = ["trame_vtklocal"]

# -----------------------------------------------------------------------------
# Module advanced initialization
# -----------------------------------------------------------------------------

HELPERS_PER_SERVER: dict[str, ObjectManagerHelper] = {}


def get_helper(server: NamedServer) -> ObjectManagerHelper | None:
    return HELPERS_PER_SERVER.get(server.name)


def setup(trame_server: ProtocolHostServer, **kwargs: object) -> None:
    HELPERS_PER_SERVER[trame_server.name] = ObjectManagerHelper(trame_server)
