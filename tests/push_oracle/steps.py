"""Canonical e2e oracle step registry.

The end-to-end Playwright oracle and the in-process Python harness both
dispatch by ``(scene_name, step_name)``; the registry below is the single
source of truth so the JS oracle test cases stay aligned with the Python
ones. Mutators take an :class:`OracleScene` and mutate live VTK objects in
place; the harness then calls ``view._push_sync.update()`` / ``flush()``
based on each step's ``publish`` field.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Literal

from .scenes import (
    OracleScene,
    SCENE_POPULATORS,
    mutate_tsw_like_frame,
    set_float_array_values,
)


@dataclass(frozen=True)
class E2EStep:
    """One e2e step: mutator + how the server should publish it."""

    name: str
    mutate: Callable[[OracleScene], None]
    publish: Literal["update", "flush"] = "update"
    extra: dict | None = None


# ---------------------------------------------------------------------------
# basic scene
# ---------------------------------------------------------------------------

def _basic_hide_actor(scene: OracleScene):
    scene.handles["actor"].SetVisibility(False)


def _basic_show_actor(scene: OracleScene):
    scene.handles["actor"].SetVisibility(True)


def _basic_set_pickable(scene: OracleScene):
    scene.handles["actor"].SetPickable(False)


def _basic_move_points(scene: OracleScene):
    pts = scene.handles["points"]
    pts.SetPoint(0, 0.5, 0.0, 0.0)
    pts.SetPoint(1, 1.5, 0.0, 0.0)
    pts.Modified()
    scene.handles["polydata"].Modified()


# ---------------------------------------------------------------------------
# quad scene
# ---------------------------------------------------------------------------

def _quad_set_color(scene: OracleScene):
    scene.handles["actor"].GetProperty().SetColor(0.5, 0.25, 0.75)


def _quad_change_tcoords(scene: OracleScene):
    set_float_array_values(
        scene.handles["tcoords"],
        [(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)],
    )
    scene.handles["polydata"].Modified()


def _quad_change_homography(scene: OracleScene):
    set_float_array_values(
        scene.handles["homography"],
        [
            (
                2.0, 0.0, 0.0, 0.0,
                0.0, 2.0, 0.0, 0.0,
                0.0, 0.0, 2.0, 0.0,
                0.5, 0.5, 0.0, 1.0,
            )
        ],
    )
    scene.handles["polydata"].Modified()


# ---------------------------------------------------------------------------
# tsw_like scene
# ---------------------------------------------------------------------------

def _tsw_frame_0(scene: OracleScene):
    mutate_tsw_like_frame(scene, 0)


def _tsw_frame_1(scene: OracleScene):
    mutate_tsw_like_frame(scene, 1)


def _tsw_frame_2(scene: OracleScene):
    mutate_tsw_like_frame(scene, 2)


# ---------------------------------------------------------------------------
# scalars scene
# ---------------------------------------------------------------------------

def _scalars_change_point_data(scene: OracleScene):
    set_float_array_values(
        scene.handles["point_scalars"],
        [(0.1,), (0.4,), (0.9,), (0.4,)],
    )
    scene.handles["polydata"].Modified()


def _scalars_change_cell_data(scene: OracleScene):
    set_float_array_values(scene.handles["cell_scalars"], [(0.75,)])
    scene.handles["polydata"].Modified()


# ---------------------------------------------------------------------------
# polyline scene
# ---------------------------------------------------------------------------

def _polyline_move_points(scene: OracleScene):
    pts = scene.handles["points"]
    for i in range(pts.GetNumberOfPoints()):
        pts.SetPoint(i, float(i) * 0.5, float(i) * 0.25, 0.5)
    pts.Modified()
    scene.handles["polydata"].Modified()


REGISTRY: dict[str, dict[str, E2EStep]] = {
    "basic": {
        "hide-actor": E2EStep("hide-actor", _basic_hide_actor),
        "show-actor": E2EStep("show-actor", _basic_show_actor),
        "set-pickable": E2EStep("set-pickable", _basic_set_pickable),
        "move-points": E2EStep("move-points", _basic_move_points),
    },
    "quad": {
        "set-color": E2EStep("set-color", _quad_set_color),
        "change-tcoords": E2EStep("change-tcoords", _quad_change_tcoords),
        "change-homography": E2EStep(
            "change-homography", _quad_change_homography
        ),
    },
    "tsw_like": {
        "frame-0": E2EStep("frame-0", _tsw_frame_0),
        "frame-1": E2EStep("frame-1", _tsw_frame_1),
        "frame-2": E2EStep("frame-2", _tsw_frame_2),
    },
    "scalars": {
        "change-point-data": E2EStep(
            "change-point-data", _scalars_change_point_data
        ),
        "change-cell-data": E2EStep(
            "change-cell-data", _scalars_change_cell_data
        ),
    },
    "polyline": {
        "move-points": E2EStep("move-points", _polyline_move_points),
    },
}


def lookup_step(scene_name: str, step_name: str) -> E2EStep:
    if scene_name not in REGISTRY:
        raise KeyError(f"Unknown e2e scene {scene_name!r}")
    if step_name not in REGISTRY[scene_name]:
        raise KeyError(
            f"Unknown e2e step {step_name!r} for scene {scene_name!r}"
        )
    return REGISTRY[scene_name][step_name]


def known_scenes() -> list[str]:
    """Scenes the e2e oracle can drive (must overlap with SCENE_POPULATORS)."""
    return [name for name in REGISTRY.keys() if name in SCENE_POPULATORS]
