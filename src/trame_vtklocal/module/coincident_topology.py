"""Translate mapper-relative offsets; adapt VTK's mutable output parameters."""

from __future__ import annotations

from typing import Callable, SupportsFloat, cast
from vtkmodules.vtkCommonCore import reference
from vtkmodules.vtkRenderingCore import vtkMapper

# VTK 9.6 stubs describe these mutable output references as input floats.
# The runtime fills reference objects and they implement the numeric protocol.
OffsetGetter = Callable[[reference, reference], None]


def coincident_topology_block(mapper: vtkMapper) -> dict[str, object] | None:
    if mapper.GetResolveCoincidentTopology() != 1:
        return None

    line_factor, line_units = reference(0.0), reference(0.0)
    polygon_factor, polygon_units = reference(0.0), reference(0.0)
    cast(OffsetGetter, mapper.GetRelativeCoincidentTopologyLineOffsetParameters)(
        line_factor, line_units
    )
    cast(OffsetGetter, mapper.GetRelativeCoincidentTopologyPolygonOffsetParameters)(
        polygon_factor, polygon_units
    )
    if not any(
        float(cast(SupportsFloat, value))
        for value in (line_factor, line_units, polygon_factor, polygon_units)
    ):
        return None
    return {
        "line": {
            "factor": float(cast(SupportsFloat, line_factor)),
            "offset": float(cast(SupportsFloat, line_units)),
        },
        "polygon": {
            "factor": float(cast(SupportsFloat, polygon_factor)),
            "offset": float(cast(SupportsFloat, polygon_units)),
        },
    }
