"""Shared real-VTK scene builders for push-sync tests."""

from .scenes import (
    OracleScene,
    SCENE_POPULATORS,
    add_actor,
    make_basic_scene,
    make_line_polydata,
    make_pipeline_cone_scene,
    make_polyline_scene,
    make_quad_polydata,
    make_quad_scene,
    make_scalars_scene,
    make_tsw_like_scene,
    make_two_stage_pipeline_scene,
    mutate_tsw_like_frame,
    set_float_array_values,
)

__all__ = [
    "OracleScene",
    "SCENE_POPULATORS",
    "add_actor",
    "make_basic_scene",
    "make_line_polydata",
    "make_pipeline_cone_scene",
    "make_polyline_scene",
    "make_quad_polydata",
    "make_quad_scene",
    "make_scalars_scene",
    "make_tsw_like_scene",
    "make_two_stage_pipeline_scene",
    "mutate_tsw_like_frame",
    "set_float_array_values",
]
