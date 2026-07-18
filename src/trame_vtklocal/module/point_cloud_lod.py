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
DEFAULT_POINT_BUDGET = 2_000_000

_MAPPER_CONFIGS = weakref.WeakKeyDictionary()


def _as_root_cube(value):
    try:
        center = [float(v) for v in value["center"]]
        half_size = float(value["halfSize"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(
            "root_cube must be {'center': [x, y, z], 'halfSize': s}"
        ) from error
    if len(center) != 3:
        raise ValueError(f"root_cube center must have 3 values, got {len(center)}")
    if not half_size > 0:
        raise ValueError(f"root_cube halfSize must be > 0, got {half_size}")
    return {"center": center, "halfSize": half_size}


def mark_point_cloud_lod(
    mapper,
    *,
    asset_id,
    revision,
    endpoint,
    root_cube,
    root_spacing,
    point_count,
    has_rgb=True,
    point_budget=DEFAULT_POINT_BUDGET,
    adaptive=False,
    min_budget=None,
    stationary_target_ms=None,
    interaction_target_ms=None,
    world_size_factor=None,
):
    """Mark a mapper to translate as a streamed LOD point-cloud anchor.

    ``endpoint`` is the revision-scoped base URL of the tile service (no
    trailing slash), e.g. ``/pointcloud/<asset>/<revision>``. ``root_cube``
    is the octree root cube in scene-local coordinates; ``root_spacing`` the
    approximate point spacing at level 0 in the same units.

    With ``adaptive`` set, the client adapts the visible-point budget to
    measured render duration (Phase 5): ``point_budget`` becomes the ceiling
    (the user quality control) and the client keeps the effective budget at or
    below it, tracking a target frame time. ``min_budget`` /
    ``stationary_target_ms`` / ``interaction_target_ms`` tune the loop; omit
    them to use the client defaults.

    With ``world_size_factor`` set, tile splats are sized in world units —
    diameter = octree node point spacing times the factor — so coarse tiles
    render as a closed surface up close instead of thinning into sparse
    fixed-size pixels. Omit it for screen-pixel sizing from the actor point
    size.
    """
    if not asset_id:
        raise ValueError("asset_id is required")
    if not revision:
        raise ValueError("revision is required")
    if not endpoint or str(endpoint).endswith("/"):
        raise ValueError("endpoint is required and must not end with '/'")
    root_spacing = float(root_spacing)
    if not root_spacing > 0:
        raise ValueError(f"root_spacing must be > 0, got {root_spacing}")
    point_count = int(point_count)
    if point_count < 0:
        raise ValueError(f"point_count must be >= 0, got {point_count}")
    point_budget = int(point_budget)
    if not point_budget > 0:
        raise ValueError(f"point_budget must be > 0, got {point_budget}")

    config = {
        "assetId": str(asset_id),
        "revision": str(revision),
        "endpoint": str(endpoint),
        "rootCube": _as_root_cube(root_cube),
        "rootSpacing": root_spacing,
        "pointCount": point_count,
        "hasRgb": bool(has_rgb),
        "pointBudget": point_budget,
        "adaptive": bool(adaptive),
    }
    if min_budget is not None:
        min_budget = int(min_budget)
        if not min_budget > 0:
            raise ValueError(f"min_budget must be > 0, got {min_budget}")
        config["minBudget"] = min_budget
    if stationary_target_ms is not None:
        stationary_target_ms = float(stationary_target_ms)
        if not stationary_target_ms > 0:
            raise ValueError(
                f"stationary_target_ms must be > 0, got {stationary_target_ms}"
            )
        config["stationaryTargetMs"] = stationary_target_ms
    if interaction_target_ms is not None:
        interaction_target_ms = float(interaction_target_ms)
        if not interaction_target_ms > 0:
            raise ValueError(
                f"interaction_target_ms must be > 0, got {interaction_target_ms}"
            )
        config["interactionTargetMs"] = interaction_target_ms
    if world_size_factor is not None:
        world_size_factor = float(world_size_factor)
        if not world_size_factor > 0:
            raise ValueError(f"world_size_factor must be > 0, got {world_size_factor}")
        config["worldSizeFactor"] = world_size_factor
    _MAPPER_CONFIGS[mapper] = config
    mapper.Modified()
    return config


def clear_point_cloud_lod(mapper):
    if _MAPPER_CONFIGS.pop(mapper, None) is not None:
        mapper.Modified()


def point_cloud_lod_config(mapper):
    config = _MAPPER_CONFIGS.get(mapper)
    return dict(config) if config else None
