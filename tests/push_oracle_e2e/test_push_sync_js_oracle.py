"""Push-sync JS-oracle: compare client-applied state to server shadow.

Each fixture is parametrized over ``view in {"shared", "local"}`` and walks a
sequence of ``(scene, step)`` mutations. After each step the test:

1. waits for the client to apply through the real wslink path,
2. dumps the JS-side reconstructed state via ``getAppliedSceneState(rwId)``,
3. compares against a fresh server shadow snapshot using the existing
   ``tests/push_oracle/normalize.py`` flatten + first-difference reporter.

Mark ``@pytest.mark.js_oracle`` so dev runs default to the fast Python oracle
and explicitly opt into e2e via ``-m js_oracle``.
"""

from __future__ import annotations

import pytest

from tests.push_oracle_e2e.runner import JsOracle


pytestmark = pytest.mark.js_oracle


def _walk(oracle: JsOracle, scene: str, steps: list[tuple[str, str]]):
    oracle.reset(scene)
    for step_name, publish in steps:
        oracle.run_step(step_name, publish=publish)
        oracle.compare(step_name=step_name)


SETPROPERTIES_FIXTURES = [
    ("basic", [("hide-actor", "update"), ("show-actor", "update"),
               ("set-pickable", "update")]),
]

UPDATEOBJECT_FIXTURES = [
    ("quad", [("set-color", "update"), ("change-tcoords", "update"),
              ("change-homography", "update")]),
    ("scalars", [("change-point-data", "update"),
                 ("change-cell-data", "update")]),
]

STRUCTURAL_FIXTURES = [
    ("tsw_like", [("frame-0", "update"), ("frame-1", "update"),
                  ("frame-2", "update")]),
]

POLYLINE_FIXTURES = [
    ("polyline", [("move-points", "update")]),
]


@pytest.mark.parametrize("scene,steps", SETPROPERTIES_FIXTURES)
def test_setproperties_matrix_local(oracle_local: JsOracle, scene, steps):
    _walk(oracle_local, scene, steps)


@pytest.mark.parametrize("scene,steps", SETPROPERTIES_FIXTURES)
def test_setproperties_matrix_shared(oracle_shared: JsOracle, scene, steps):
    _walk(oracle_shared, scene, steps)


@pytest.mark.parametrize("scene,steps", UPDATEOBJECT_FIXTURES)
def test_updateobject_matrix_local(oracle_local: JsOracle, scene, steps):
    _walk(oracle_local, scene, steps)


@pytest.mark.parametrize("scene,steps", UPDATEOBJECT_FIXTURES)
def test_updateobject_matrix_shared(oracle_shared: JsOracle, scene, steps):
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
