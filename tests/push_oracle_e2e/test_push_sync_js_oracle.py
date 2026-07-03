"""Push-sync v2 JS-oracle: compare client-applied state to the server store.

Each fixture is parametrized over ``view in {"shared", "local"}`` and walks a
sequence of ``(scene, step)`` mutations. After each step the test:

1. waits for the client to apply through the real wslink broadcast path,
2. dumps the JS-side reconstructed state via ``getAppliedSceneState(rwId)``,
3. compares against a fresh server shadow (``store.snapshot()`` plus blob
   bytes) using the ``tests/push_oracle/normalize.py`` comparator.

Steps that pin ``expect_op`` additionally assert the wire path: e.g. an
in-place point nudge must arrive as a ``patchArray`` region op, so a
regression that silently degrades the hot-array differ to full resends
fails loudly even though the final state still converges.

Marked ``@pytest.mark.js_oracle`` so dev runs include these browser-backed
checks by default and can skip them explicitly via ``-m 'not js_oracle'``.
"""

from __future__ import annotations

import pytest

from tests.push_oracle.steps import lookup_step
from tests.push_oracle_e2e.runner import JsOracle


pytestmark = pytest.mark.js_oracle


def _walk(oracle: JsOracle, scene: str, steps: list[str]):
    oracle.reset(scene)
    for step_name in steps:
        step = lookup_step(scene, step_name)
        oracle.run_step(step_name)
        if step.expect_op:
            last = (oracle.diagnostics() or {}).get("lastAppliedOp") or {}
            assert last.get("kind") == step.expect_op, (
                f"{scene}/{step_name}: expected last applied op "
                f"{step.expect_op!r}, got {last!r}"
            )
        oracle.compare(step_name=step_name)


PROPS_FIXTURES = [
    ("basic", ["hide-actor", "show-actor", "set-pickable"]),
]

ARRAY_FIXTURES = [
    ("quad", ["set-color", "change-tcoords", "change-homography"]),
    ("scalars", ["change-point-data", "change-cell-data"]),
]

STRUCTURAL_FIXTURES = [
    ("tsw_like", ["frame-0", "frame-1", "frame-2"]),
]

POLYLINE_FIXTURES = [
    ("polyline", ["move-points"]),
]

# Exercises the automatic hot-array region diff: ``move-points`` pays the
# one full send that starts retention, then ``nudge-one-point`` must ride
# the wire as a ``patchArray`` op (asserted via ``expect_op``).
PATCH_ARRAY_FIXTURES = [
    ("polyline", ["move-points", "nudge-one-point"]),
]


@pytest.mark.parametrize("scene,steps", PROPS_FIXTURES)
def test_props_matrix_local(oracle_local: JsOracle, scene, steps):
    _walk(oracle_local, scene, steps)


@pytest.mark.parametrize("scene,steps", PROPS_FIXTURES)
def test_props_matrix_shared(oracle_shared: JsOracle, scene, steps):
    _walk(oracle_shared, scene, steps)


@pytest.mark.parametrize("scene,steps", ARRAY_FIXTURES)
def test_array_matrix_local(oracle_local: JsOracle, scene, steps):
    _walk(oracle_local, scene, steps)


@pytest.mark.parametrize("scene,steps", ARRAY_FIXTURES)
def test_array_matrix_shared(oracle_shared: JsOracle, scene, steps):
    _walk(oracle_shared, scene, steps)


@pytest.mark.parametrize("scene,steps", STRUCTURAL_FIXTURES)
def test_structural_matrix_local(oracle_local: JsOracle, scene, steps):
    _walk(oracle_local, scene, steps)


@pytest.mark.parametrize("scene,steps", STRUCTURAL_FIXTURES)
def test_structural_matrix_shared(oracle_shared: JsOracle, scene, steps):
    _walk(oracle_shared, scene, steps)


@pytest.mark.parametrize("scene,steps", POLYLINE_FIXTURES)
def test_polyline_matrix_local(oracle_local: JsOracle, scene, steps):
    _walk(oracle_local, scene, steps)


@pytest.mark.parametrize("scene,steps", PATCH_ARRAY_FIXTURES)
def test_patch_array_matrix_local(oracle_local: JsOracle, scene, steps):
    _walk(oracle_local, scene, steps)


@pytest.mark.parametrize("scene,steps", PATCH_ARRAY_FIXTURES)
def test_patch_array_matrix_shared(oracle_shared: JsOracle, scene, steps):
    _walk(oracle_shared, scene, steps)
