"""Pickable-mapper marking for the fork interaction seam.

Tagging a server-side glyph mapper as pickable makes the translator emit a
``pickable`` block on its serialized node. The block is opaque to the fork: the
app puts in whatever ``tags``/``ids`` it needs and the client round-trips them
verbatim through ``pickAt``. The fork never interprets tag semantics — it only
answers "what rendered glyph point is under (x, y)".
"""

import math
import weakref

PICKABLE_STATE_KEY = "pickable"

_PICKABLE_CONFIGS = weakref.WeakKeyDictionary()


def _copy_config(config):
    return {
        "tags": dict(config["tags"]),
        "ids": list(config["ids"]) if config["ids"] is not None else None,
        "grabPx": config["grabPx"],
        "priority": config["priority"],
    }


def make_pickable(mapper, tags=None, ids=None, grab_px=None, priority=0):
    """Mark ``mapper`` pickable and stamp its opaque hit-test metadata.

    ``tags`` (dict) and ``ids`` (list, one entry per glyph point) are opaque to
    the fork and round-tripped verbatim. ``grab_px`` is the CSS-pixel grab
    radius; ``priority`` breaks ties between overlapping pickables (higher
    wins). Re-calling replaces the whole config and bumps the mapper's MTime so
    the next push re-serializes it (reaching the client as a patch op).
    """
    grab = float(grab_px) if grab_px is not None else float("nan")
    if not math.isfinite(grab) or grab <= 0:
        raise ValueError("grab_px must be a positive number")

    config = {
        "tags": dict(tags) if tags else {},
        "ids": list(ids) if ids is not None else None,
        "grabPx": grab,
        "priority": int(priority),
    }
    _PICKABLE_CONFIGS[mapper] = config
    mapper.Modified()
    return _copy_config(config)


def clear_pickable(mapper):
    if _PICKABLE_CONFIGS.pop(mapper, None) is not None:
        mapper.Modified()


def pickable_config(mapper):
    if mapper is None:
        return None
    config = _PICKABLE_CONFIGS.get(mapper)
    return _copy_config(config) if config else None


def update_mapper_state(state, config):
    """Stamp a translated mapper node with its pickable block.

    Mirrors ``distance_to_camera.update_mapper_state``: the block rides at the
    top level of the serialized node (``node["pickable"]``), where the client
    registry walker reads it.
    """
    if config:
        state[PICKABLE_STATE_KEY] = config
    return state
