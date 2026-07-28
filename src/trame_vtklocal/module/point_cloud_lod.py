"""Point-cloud LOD anchor translation helpers.

Marking a server-side mapper makes the translator emit its serialized node
with type "vtkPointCloudLodMapper" plus a ``pointCloudLod`` feature block, so
the client instantiates an octree LOD controller (the pointcloud-lod
library) that streams tiles over HTTP instead of receiving point arrays
through this channel. The marked mapper should carry an empty dataset — the
full-resolution cloud never rides the scene payload; only this small config
does. Coordinate correction stays on the anchor actor's UserMatrix, which the
client fans out to every streamed tile.
"""

import weakref

POINT_CLOUD_LOD_TYPE = "vtkPointCloudLodMapper"
POINT_CLOUD_LOD_BLOCK = "pointCloudLod"
POINT_CLOUD_PRESENTATION_BLOCK = "pointCloudPresentation"

# The client's adaptive floor. Mirrored here so a max_budget below the floor is
# rejected while marking rather than thrown from a render pass.
DEFAULT_ADAPTIVE_MIN_BUDGET = 200_000

_MAPPER_CONFIGS = weakref.WeakKeyDictionary()
_PRESENTATION_CONFIGS = weakref.WeakKeyDictionary()


def _as_presentation(value):
    if not isinstance(value, dict):
        raise ValueError("presentation must be a Fixed or Auto object")
    mode = value.get("mode")
    if mode == "fixed":
        diameter = float(value["diameterCssPx"])
        if not diameter > 0:
            raise ValueError("Fixed diameterCssPx must be positive")
        return {"mode": "fixed", "diameterCssPx": diameter}
    if mode == "auto":
        user_scale = float(value["userScale"])
        minimum = float(value["minDiameterCssPx"])
        maximum = float(value["maxDiameterCssPx"])
        if not user_scale > 0 or not 0 < minimum <= maximum:
            raise ValueError(
                "Auto scale and diameter clamps must be positive and ordered"
            )
        return {
            "mode": "auto",
            "userScale": user_scale,
            "minDiameterCssPx": minimum,
            "maxDiameterCssPx": maximum,
        }
    raise ValueError("presentation mode must be 'fixed' or 'auto'")


def _as_adaptive_options(value):
    """Normalize the optional adaptive-quality options for the wire.

    These reach the client's view governor as construction options, which
    throw rather than clamp, so an unusable value is rejected here instead of
    reaching a render pass. Keys mirror the wire (and the library) exactly.
    """
    if not isinstance(value, dict):
        raise ValueError("adaptive_options must be an object")
    unknown = set(value) - {
        "minBudget",
        "maxBudget",
        "interactionTargetMs",
        "stationaryTargetMs",
    }
    if unknown:
        raise ValueError(f"unknown adaptive_options: {', '.join(sorted(unknown))}")

    options = {}
    minimum = DEFAULT_ADAPTIVE_MIN_BUDGET
    if (raw := value.get("minBudget")) is not None:
        minimum = int(raw)
        if not minimum > 0:
            raise ValueError(f"minBudget must be > 0, got {minimum}")
        options["minBudget"] = minimum
    if (raw := value.get("maxBudget")) is not None:
        maximum = int(raw)
        # The memory-derived ceiling stays authoritative; this is the optional
        # policy ceiling on top of it, so it only has to clear the floor.
        if maximum < minimum:
            raise ValueError(
                f"maxBudget must be >= minBudget ({minimum}), got {maximum}"
            )
        options["maxBudget"] = maximum
    for key in ("interactionTargetMs", "stationaryTargetMs"):
        if (raw := value.get(key)) is not None:
            target = float(raw)
            if not target > 0:
                raise ValueError(f"{key} must be > 0, got {target}")
            options[key] = target
    return options


def mark_point_cloud_lod(
    mapper,
    *,
    source_asset_id,
    revision,
    endpoint,
    point_count,
    presentation,
    has_rgb=True,
    point_budget=None,
    adaptive=False,
    adaptive_options=None,
    refinement_cutoff_px=None,
):
    """Mark a mapper to translate as a streamed LOD point-cloud anchor.

    ``source_asset_id`` is the durable session/source asset identity —
    the id client-side picking scopes its queries by and echoes back as
    provenance. It is deliberately separate from the URL-safe tile-service id,
    which lives only inside ``endpoint``: the two must never be conflated,
    because gesture identity has to survive tile-service re-registration.

    ``endpoint`` is the revision-scoped base URL of the tile service (no
    trailing slash), e.g. ``/pointcloud/<asset>/<revision>``. Node bounds and
    metric spacing arrive in each hierarchy response.

    With ``adaptive`` set, the client adapts the visible-point budget to
    measured render duration and ``point_budget`` is ignored. The effective
    budget is the smallest of the adaptive budget, the optional
    ``adaptive_options["maxBudget"]``, and the client's memory-derived
    ceiling, which stays authoritative. Omitting ``maxBudget`` means the
    memory ceiling is the only upper bound. ``adaptive_options`` also carries
    ``minBudget`` and the per-regime frame-time targets
    (``interactionTargetMs`` while the camera moves, ``stationaryTargetMs``
    once it settles); each is optional and falls back to the client default.

    Without ``adaptive``, ``point_budget`` is the fixed visible-point budget
    (client default 2,000,000), still capped by the memory ceiling.

    ``presentation`` is an explicit Fixed CSS-pixel diameter or Auto scale and
    clamp contract. The browser owns projected-density calculation.
    """
    if not source_asset_id:
        raise ValueError("source_asset_id is required")
    if not revision:
        raise ValueError("revision is required")
    if not endpoint or str(endpoint).endswith("/"):
        raise ValueError("endpoint is required and must not end with '/'")
    point_count = int(point_count)
    if point_count < 0:
        raise ValueError(f"point_count must be >= 0, got {point_count}")

    config = {
        "sourceAssetId": str(source_asset_id),
        "revision": str(revision),
        "endpoint": str(endpoint),
        "pointCount": point_count,
        "hasRgb": bool(has_rgb),
        "adaptive": bool(adaptive),
        "presentation": _as_presentation(presentation),
    }
    if adaptive_options is not None:
        # Silently inert configuration is the failure mode this block exists to
        # avoid, so refuse options that nothing would ever read.
        if not adaptive:
            raise ValueError("adaptive_options requires adaptive=True")
        config["adaptiveOptions"] = _as_adaptive_options(adaptive_options)
    if point_budget is not None:
        point_budget = int(point_budget)
        if not point_budget > 0:
            raise ValueError(f"point_budget must be > 0, got {point_budget}")
        config["pointBudget"] = point_budget
    if refinement_cutoff_px is not None:
        refinement_cutoff_px = float(refinement_cutoff_px)
        if refinement_cutoff_px < 0:
            raise ValueError(
                f"refinement_cutoff_px must be >= 0, got {refinement_cutoff_px}"
            )
        config["refinementCutoffPx"] = refinement_cutoff_px
    _MAPPER_CONFIGS[mapper] = config
    mapper.Modified()
    return config


def clear_point_cloud_lod(mapper):
    if _MAPPER_CONFIGS.pop(mapper, None) is not None:
        mapper.Modified()


def point_cloud_lod_config(mapper):
    config = _MAPPER_CONFIGS.get(mapper)
    return dict(config) if config else None


def mark_point_cloud_presentation(mapper, *, diameter_css_px):
    diameter = float(diameter_css_px)
    if not diameter > 0:
        raise ValueError("diameter_css_px must be positive")
    config = {"mode": "fixed", "diameterCssPx": diameter}
    _PRESENTATION_CONFIGS[mapper] = config
    mapper.Modified()
    return config


def clear_point_cloud_presentation(mapper):
    if _PRESENTATION_CONFIGS.pop(mapper, None) is not None:
        mapper.Modified()


def point_cloud_presentation_config(mapper):
    config = _PRESENTATION_CONFIGS.get(mapper)
    return dict(config) if config else None


def apply_point_cloud_blocks(mapper, node_type, blocks):
    """Attach point-cloud feature blocks and return the translated mapper type."""
    if lod := point_cloud_lod_config(mapper):
        node_type = POINT_CLOUD_LOD_TYPE
        blocks[POINT_CLOUD_LOD_BLOCK] = lod
    if presentation := point_cloud_presentation_config(mapper):
        blocks[POINT_CLOUD_PRESENTATION_BLOCK] = presentation
    return node_type
