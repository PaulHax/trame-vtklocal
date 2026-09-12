"""One publish tick's dirty-candidate record."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from vtkmodules.vtkCommonExecutionModel import vtkAlgorithm


@dataclass
class DirtyBatch:
    """Objects and owners affected by one set of VTK modification events.

    ``dirty_ids`` is every id the tick marked dirty, before owner mapping —
    both the objects that emitted their own ``ModifiedEvent`` and the ones
    the healing sweep found with a moved ``GetMTime``. ``swept_ids`` is that
    second group alone: ids whose MTime moved with no modification event of
    their own, which for a container means the move propagated up from a
    child rather than describing a change to the container itself.
    """

    candidates: set[str] = field(default_factory=set)
    refresh_ids: set[str] = field(default_factory=set)
    producers: dict[int, vtkAlgorithm] = field(default_factory=dict)
    structural: bool = False
    dirty_ids: set[str] = field(default_factory=set)
    swept_ids: set[str] = field(default_factory=set)

    def __bool__(self) -> bool:
        return bool(
            self.candidates or self.refresh_ids or self.producers or self.structural
        )
