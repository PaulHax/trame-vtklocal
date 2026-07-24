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
            raise ValueError("Auto scale and diameter clamps must be positive and ordered")
        return {
            "mode": "auto",
            "userScale": user_scale,
            "minDiameterCssPx": minimum,
            "maxDiameterCssPx": maximum,
        }
    raise ValueError("presentation mode must be 'fixed' or 'auto'")


def mark_point_cloud_lod(
    mapper,
    *,
    asset_id,
    revision,
    endpoint,
    point_count,
    presentation,
    has_rgb=True,
    point_budget=None,
    adaptive=False,
    refinement_cutoff_px=None,
):
    """Mark a mapper to translate as a streamed LOD point-cloud anchor.

    ``endpoint`` is the revision-scoped base URL of the tile service (no
    trailing slash), e.g. ``/pointcloud/<asset>/<revision>``. Node bounds and
    metric spacing arrive in each hierarchy response.

    With ``adaptive`` set, the client adapts the visible-point budget to
    measured render duration, capped only by the client's shared GPU-memory
    budget — there is no configured point ceiling, and ``point_budget`` is
    ignored. Without ``adaptive``, ``point_budget`` is the fixed visible-point
    budget (client default 2,000,000), still capped by the memory budget.

    ``presentation`` is an explicit Fixed CSS-pixel diameter or Auto scale and
    clamp contract. The browser owns projected-density calculation.
    """
    if not asset_id:
        raise ValueError("asset_id is required")
    if not revision:
        raise ValueError("revision is required")
    if not endpoint or str(endpoint).endswith("/"):
        raise ValueError("endpoint is required and must not end with '/'")
    point_count = int(point_count)
    if point_count < 0:
        raise ValueError(f"point_count must be >= 0, got {point_count}")

    config = {
        "assetId": str(asset_id),
        "revision": str(revision),
        "endpoint": str(endpoint),
        "pointCount": point_count,
        "hasRgb": bool(has_rgb),
        "adaptive": bool(adaptive),
        "presentation": _as_presentation(presentation),
    }
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
