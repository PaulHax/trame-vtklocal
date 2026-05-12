"""Architectural invariants enforced as pytest cases.

These rules describe the *shape* of the codebase — what may depend on
what — rather than runtime behavior. They run in the normal pytest pass
with no extra tooling. Each rule names the PR or commit whose lesson it
encodes, so failures point future readers (or agents) at the why.
"""

from __future__ import annotations

import ast
from pathlib import Path


SRC_ROOT = Path(__file__).resolve().parent.parent / "src" / "trame_vtklocal"


def _iter_python_files(directory: Path):
    return sorted(p for p in directory.rglob("*.py") if "__pycache__" not in p.parts)


def _imported_modules(source_path: Path):
    """Yield (lineno, module_dotted_name) for every import in a file.

    Handles both ``import a.b.c`` and ``from a.b import c``. For relative
    imports the resolved absolute name is yielded.
    """
    tree = ast.parse(source_path.read_text())
    package_parts = source_path.relative_to(SRC_ROOT.parent).with_suffix("").parts
    # parent package of this file, for resolving relative imports
    parent_pkg = ".".join(package_parts[:-1])

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield node.lineno, alias.name
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                # relative import — resolve against parent_pkg
                base = parent_pkg.split(".")
                if node.level > len(base):
                    continue
                ancestor = base[: len(base) - (node.level - 1)] if node.level > 1 else base
                resolved = ".".join(ancestor + ([node.module] if node.module else []))
                yield node.lineno, resolved
            else:
                yield node.lineno, node.module or ""


def test_module_subpackage_does_not_import_widgets():
    """Layer direction: module/ may not import from widgets/.

    Encodes PR #6 / commit 3f7f9122. Protocol constants were extracted to
    ``trame_vtklocal._protocol_constants`` precisely because importing them
    from ``widgets.push_sync`` made ``module/__init__.py`` (eagerly
    importing ``vtkSerializationManager``) reachable from a leaf path that
    is supposed to work without VTK installed. Locking the direction
    prevents that regression class from reappearing.
    """
    bad = []
    for path in _iter_python_files(SRC_ROOT / "module"):
        for lineno, name in _imported_modules(path):
            if name.startswith("trame_vtklocal.widgets"):
                bad.append(f"{path.relative_to(SRC_ROOT.parent)}:{lineno}: {name}")

    assert not bad, (
        "module/ must not import from widgets/. See PR #6 / commit 3f7f9122. "
        "Violations:\n  " + "\n  ".join(bad)
    )


def test_protocol_constants_stays_a_leaf():
    """``_protocol_constants.py`` may not depend on any other in-package module.

    The whole reason the file exists is to be a no-dependency leaf that
    both ``module/`` and ``widgets/`` can safely import. Letting it reach
    back into either subpackage would reintroduce the import cycle that
    3f7f9122 broke.
    """
    path = SRC_ROOT / "_protocol_constants.py"
    bad = [
        f"{path.name}:{lineno}: {name}"
        for lineno, name in _imported_modules(path)
        if name.startswith("trame_vtklocal.")
        and name != "trame_vtklocal._protocol_constants"
    ]
    assert not bad, (
        "_protocol_constants.py must remain a leaf (no in-package imports). "
        "See PR #6 / commit 3f7f9122. Violations:\n  " + "\n  ".join(bad)
    )
