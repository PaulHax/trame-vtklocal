from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING

from trame_vtklocal.module.protocol import ObjectManagerHelper

if TYPE_CHECKING:
    from trame_vtklocal.module.protocol import (
        ModuleHostServer,
        NamedServer,
        ProtocolHostServer,
    )

# trame's enable_module() reads serve/scripts/styles/vue_use/setup off this
# module by name, so every one of them is load-bearing despite having no
# in-tree caller.
__all__ = [
    "serve",
    "scripts",
    "styles",
    "vue_use",
    "setup",
    "get_helper",
    "setup_wasm",
]

serve_root = Path(__file__).with_name("serve").resolve()
serve_path = str(serve_root)


def _versioned_asset(asset_name: str) -> str:
    asset_path = serve_root / "js" / asset_name
    version = int(asset_path.stat().st_mtime)
    return f"__trame_vtklocal/js/{asset_name}?v={version}"


serve = {"__trame_vtklocal": serve_path}
scripts = [_versioned_asset("trame_vtklocal.umd.js")]
styles = [_versioned_asset("trame_vtklocal.css")]
vue_use = ["trame_vtklocal"]

# -----------------------------------------------------------------------------
# Module advanced initialization
# -----------------------------------------------------------------------------

HELPERS_PER_SERVER: dict[str, ObjectManagerHelper] = {}
WASM_REGISTERED: set[str] = set()


def get_helper(server: NamedServer) -> ObjectManagerHelper | None:
    return HELPERS_PER_SERVER.get(server.name)


def setup(
    trame_server: ProtocolHostServer,
    *,
    addon_serdes_registrars: Sequence[object] = (),
    **kwargs: object,
) -> None:
    global HELPERS_PER_SERVER
    # Pop wasm-specific kwargs so they don't interfere, but ignore them here.
    # WASM registration is deferred to setup_wasm() and only runs when
    # a WASM-based widget (LocalView) is actually used.
    kwargs.pop("wasm_url", None)
    kwargs.pop("wasm_dir", None)
    kwargs.pop("wasm_base_name", None)
    HELPERS_PER_SERVER[trame_server.name] = ObjectManagerHelper(
        trame_server, addon_serdes_registrars=addon_serdes_registrars
    )


def setup_wasm(trame_server: ModuleHostServer, **kwargs: object) -> None:
    """Register VTK WASM files. Only called when LocalView is used."""
    if trame_server.name in WASM_REGISTERED:
        return
    WASM_REGISTERED.add(trame_server.name)
    from trame_vtklocal.module.wasm import register_wasm

    trame_server.enable_module(register_wasm(serve_path, **kwargs))
