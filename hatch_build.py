"""Hatchling metadata hook that stamps the git short sha into the wheel version.

``project.version`` is declared ``dynamic`` in ``pyproject.toml`` so the version
is computed here at build time as a PEP 440 local version:

    <BASE_VERSION>+shared-context.<short-sha>

e.g. ``0.16.0+shared-context.5d9327a``. The local segment round-trips through
``importlib.metadata.version("trame-vtklocal")`` after install, so the wheel
carries proof of exactly which fork commit produced its embedded UMD bundle.

The short sha is taken from ``$TRAME_VTKLOCAL_SHA`` when set (release.sh and the
CI Action export it so the wheel version and the release tag agree), otherwise
from ``git rev-parse --short HEAD`` in the source tree. If neither is available
the plain ``BASE_VERSION`` is used so building from an unpacked sdist still works.
"""

from __future__ import annotations

import os
import subprocess

from hatchling.metadata.plugin.interface import MetadataHookInterface

# Sole source of truth for the base version now that ``project.version`` is
# declared dynamic. Bump this for a real version change.
BASE_VERSION = "0.16.0"

# Kept consistent with the release tag scheme ``v<BASE>-shared-context.<sha>``
# and the app's wheel-pin URL.
LOCAL_LABEL = "shared-context"


def _short_sha(root: str) -> str | None:
    sha = os.environ.get("TRAME_VTKLOCAL_SHA")
    if sha:
        return sha.strip()
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=root,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return out.decode().strip() or None


def _stamped_version(root: str) -> str:
    sha = _short_sha(root)
    if not sha:
        return BASE_VERSION
    return f"{BASE_VERSION}+{LOCAL_LABEL}.{sha}"


class ShaVersionMetadataHook(MetadataHookInterface):
    def update(self, metadata: dict) -> None:
        metadata["version"] = _stamped_version(self.root)
