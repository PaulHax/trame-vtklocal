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
    copied = {
        "tags": dict(config["tags"]),
        "ids": list(config["ids"]) if config["ids"] is not None else None,
        "grabPx": config["grabPx"],
        "priority": config["priority"],
        "preview": config["preview"],
    }
    if config["plane"] is not None:
        copied["plane"] = {
            "origin": list(config["plane"]["origin"]),
            "normal": list(config["plane"]["normal"]),
        }
    return copied


def make_pickable(
    mapper,
    tags=None,
    ids=None,
    grab_px=None,
    priority=0,
    preview=None,
    plane=None,
):
    """Mark ``mapper`` pickable and stamp its opaque hit-test metadata.

    ``tags`` (dict) and ``ids`` (list, one entry per glyph point) are opaque to
    the fork and round-tripped verbatim. ``grab_px`` is the CSS-pixel grab
    radius; ``priority`` breaks ties between overlapping pickables (higher
    wins). Re-calling with a changed config replaces it and bumps the mapper's
    MTime so the next push re-serializes it (reaching the client as a patch
    op); an unchanged config is a no-op, so callers can re-tag on every update
    without forcing spurious re-serialization.
    """
    grab = float(grab_px) if grab_px is not None else float("nan")
    if not math.isfinite(grab) or grab <= 0:
        raise ValueError("grab_px must be a positive number")
    if preview not in (None, "screen", "plane"):
        raise ValueError("preview must be None, 'screen', or 'plane'")
    normalized_plane = None
    if plane is not None:
        if not isinstance(plane, dict):
            raise ValueError("plane must contain origin and normal vectors")
        origin = [float(value) for value in plane.get("origin", ())]
        normal = [float(value) for value in plane.get("normal", ())]
        if (
            len(origin) != 3
            or len(normal) != 3
            or not all(math.isfinite(value) for value in (*origin, *normal))
            or sum(value * value for value in normal) == 0
        ):
            raise ValueError("plane must contain finite 3D origin and normal vectors")
        normalized_plane = {"origin": origin, "normal": normal}
    if preview == "plane" and normalized_plane is None:
        raise ValueError("preview='plane' requires a plane")

    config = {
        "tags": dict(tags) if tags else {},
        "ids": list(ids) if ids is not None else None,
        "grabPx": grab,
        "priority": int(priority),
        "preview": preview,
        "plane": normalized_plane,
    }
    if _PICKABLE_CONFIGS.get(mapper) != config:
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
