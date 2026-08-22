"""Architectural invariants enforced as pytest cases.

These rules describe the *shape* of the codebase — what may depend on
what — rather than runtime behavior. They run in the normal pytest pass
with no extra tooling.
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
                ancestor = (
                    base[: len(base) - (node.level - 1)] if node.level > 1 else base
                )
                resolved = ".".join(ancestor + ([node.module] if node.module else []))
                yield node.lineno, resolved
            else:
                yield node.lineno, node.module or ""


def test_module_subpackage_does_not_import_widgets():
    """Layer direction: module/ may not import from widgets/.

    ``module/__init__.py`` eagerly imports ``vtkSerializationManager``, so any
    widgets/ import from module/ drags VTK into leaf paths that must work
    without it. The shared leaf both sides may import is ``store.py``.
    """
    bad = []
    for path in _iter_python_files(SRC_ROOT / "module"):
        for lineno, name in _imported_modules(path):
            if name.startswith("trame_vtklocal.widgets"):
                bad.append(f"{path.relative_to(SRC_ROOT.parent)}:{lineno}: {name}")

    assert not bad, (
        "module/ must not import from widgets/. Violations:\n  " + "\n  ".join(bad)
    )


DEFAULT_LINE_BUDGET = 400

# Files currently over the default. Each entry names why and what brings
# it down. Lower the value as work lands; never raise without a named
# reason in the same commit. New files are expected to live under the
# default — if a new addition needs an entry here, the right move is
# almost always to split it.
SIZE_BUDGETS = {
    # one translator for every node kind, plus the shared-reader seam
    "module/node_translator.py": 415,
    # wslink RPC surface + push-view blob registry with debounced GC
    "module/protocol.py": 450,
    # one concern (dirty candidates) but three observer graphs: objects,
    # dataset children, pipeline producers — plus the dtc rewire-noise filter
    "widgets/dirty_tracker.py": 510,
    # publish tick + wire encoding + resync + dropped-blob re-entry guard
    # Raised at the streamed-scene merge: the blob-restore path and the
    # streamed publisher additions landed independently, each under budget.
    # Raised again for the hot-array fast-path dispatch in _commit_batch:
    # the file sat exactly at 550, so no arrangement of the dispatch (which
    # needs the guard call plus the suppress() scope it runs under) fits.
    # Next reduction: event_is_current() is a VTK-free, store-only predicate
    # with one in-module caller and belongs beside the store, not here.
    "widgets/publisher.py": 557,
}


def test_source_files_under_line_budget():
    """Every .py file under src/trame_vtklocal/ stays under its line budget.

    Default budget is DEFAULT_LINE_BUDGET. SIZE_BUDGETS lists per-file
    exceptions for files currently over the default — each is a named
    commitment to bring the file down over time.

    Single test reports all violations at once so a CI failure shows the
    whole picture, not just the first file to trip.
    """
    violations = []
    for path in _iter_python_files(SRC_ROOT):
        rel = path.relative_to(SRC_ROOT).as_posix()
        budget = SIZE_BUDGETS.get(rel, DEFAULT_LINE_BUDGET)
        line_count = len(path.read_text().splitlines())
        if line_count > budget:
            violations.append(f"  {rel}: {line_count} lines (budget: {budget})")

    assert not violations, (
        f"File size budget violations (default: {DEFAULT_LINE_BUDGET}):\n"
        + "\n".join(violations)
        + "\n\nDefault remediation: extract a concern into its own module. "
        "If raising the budget is the right call, add or update the entry "
        "in SIZE_BUDGETS (tests/test_architecture.py) with a one-line "
        "reason in the same commit."
    )


def test_store_stays_a_vtk_free_leaf():
    """``store.py`` may not depend on VTK or any other in-package module.

    The scene store is the replication seam both ``module/`` and ``widgets/``
    import (node shapes, ref namespaces, ``ref_manager_hashes``). Reaching
    back into either subpackage — or importing VTK — reintroduces an import
    cycle and breaks VTK-free unit testing.
    """
    path = SRC_ROOT / "store.py"
    bad = [
        f"{path.name}:{lineno}: {name}"
        for lineno, name in _imported_modules(path)
        if name.startswith(("trame_vtklocal.", "vtk"))
        and name != "trame_vtklocal.store"
    ]
    assert not bad, (
        "store.py must remain a VTK-free leaf (no in-package imports). "
        "Violations:\n  " + "\n  ".join(bad)
    )
