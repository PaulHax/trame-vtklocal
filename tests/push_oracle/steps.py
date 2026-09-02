"""Canonical e2e oracle step registry (push sync v2).

The end-to-end Playwright oracle dispatches by ``(scene_name, step_name)``;
the registry below is the single source of truth so the JS oracle test cases
stay aligned across test modules. Mutators take an :class:`OracleScene` and
mutate live VTK objects in place; the test app then publishes via the view's
``sync()`` — there is no per-step publish mode in v2 (the publisher decides
between upserts and automatic ``patchArray`` region diffs itself).

``expect_op`` optionally pins the op kind the client must see last for the
step (e.g. ``"patchArray"`` for an in-place point nudge after retention has
started), so a regression that silently degrades the hot-array path to full
resends fails loudly even though the final state still converges.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .scenes import (
    OracleScene,
    SCENE_POPULATORS,
    mutate_map_drape_frame,
    set_float_array_values,
)


@dataclass(frozen=True)
class E2EStep:
    """One e2e step: a mutator plus an optional expected last-applied op."""

    name: str
    mutate: Callable[[OracleScene], None]
    expect_op: str | None = None


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
                2.0,
                0.0,
                0.0,
                0.0,
                0.0,
                2.0,
                0.0,
                0.0,
                0.0,
                0.0,
                2.0,
                0.0,
                0.5,
                0.5,
                0.0,
                1.0,
            )
        ],
    )
    scene.handles["polydata"].Modified()


# ---------------------------------------------------------------------------
# map_drape scene
# ---------------------------------------------------------------------------


def _map_drape_frame_0(scene: OracleScene):
    mutate_map_drape_frame(scene, 0)


def _map_drape_frame_1(scene: OracleScene):
    mutate_map_drape_frame(scene, 1)


def _map_drape_frame_2(scene: OracleScene):
    mutate_map_drape_frame(scene, 2)


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


def _polyline_nudge_one_point(scene: OracleScene):
    # A single-point nudge after ``move-points`` (which started hot-array
    # retention) must ride the wire as a ``patchArray`` region op.
    pts = scene.handles["points"]
    x, y, z = pts.GetPoint(1)
    pts.SetPoint(1, x + 0.125, y, z)
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
        "change-homography": E2EStep("change-homography", _quad_change_homography),
    },
    "map_drape": {
        "frame-0": E2EStep("frame-0", _map_drape_frame_0),
        "frame-1": E2EStep("frame-1", _map_drape_frame_1),
        "frame-2": E2EStep("frame-2", _map_drape_frame_2),
    },
    "scalars": {
        "change-point-data": E2EStep("change-point-data", _scalars_change_point_data),
        "change-cell-data": E2EStep("change-cell-data", _scalars_change_cell_data),
    },
    "polyline": {
        "move-points": E2EStep("move-points", _polyline_move_points),
        "nudge-one-point": E2EStep(
            "nudge-one-point",
            _polyline_nudge_one_point,
            expect_op="patchArray",
        ),
    },
}


def lookup_step(scene_name: str, step_name: str) -> E2EStep:
    if scene_name not in REGISTRY:
        raise KeyError(f"Unknown e2e scene {scene_name!r}")
    if step_name not in REGISTRY[scene_name]:
        raise KeyError(f"Unknown e2e step {step_name!r} for scene {scene_name!r}")
    return REGISTRY[scene_name][step_name]


def known_scenes() -> list[str]:
    """Scenes the e2e oracle can drive (must overlap with SCENE_POPULATORS)."""
    return [name for name in REGISTRY.keys() if name in SCENE_POPULATORS]
