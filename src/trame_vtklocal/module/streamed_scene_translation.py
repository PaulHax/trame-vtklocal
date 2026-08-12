"""Actor-specific translation for the synthetic streamed scene anchor."""

from trame_vtklocal.module.streamed_scene_registry import streamed_scene_source
from trame_vtklocal.module.vtkjs_translator import actor_user_matrix_property
from trame_vtklocal.streamed_scene import (
    STREAMED_SCENE_BLOCK,
    STREAMED_SCENE_TYPE,
    source_block,
)


def translate_actor(reader, state, props, refs):
    """Preserve actor props while replacing drawable refs for streaming."""
    actor = reader.vtk_object(state["Id"])
    user_matrix = actor_user_matrix_property(actor)
    if user_matrix is not None:
        props["userMatrix"] = user_matrix

    source = streamed_scene_source(
        actor, state["Id"], registry=reader.streamed_scene_registry
    )
    if source is None:
        return "vtkActor", props, refs, {}
    return (
        STREAMED_SCENE_TYPE,
        props,
        {},
        {STREAMED_SCENE_BLOCK: source_block(source)},
    )
