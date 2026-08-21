"""One publish tick's dirty-candidate record."""

from dataclasses import dataclass, field


@dataclass
class DirtyBatch:
    """Objects and owners affected by one set of VTK modification events.

    ``dirty_ids`` preserves the observed objects before owner mapping, while
    ``swept_ids`` distinguishes propagated MTime changes discovered by the
    healing sweep from objects that emitted their own modification event.
    """

    candidates: set = field(default_factory=set)
    refresh_ids: set = field(default_factory=set)
    producers: dict = field(default_factory=dict)
    structural: bool = False
    dirty_ids: set = field(default_factory=set)
    swept_ids: set = field(default_factory=set)

    def __bool__(self):
        return bool(
            self.candidates or self.refresh_ids or self.producers or self.structural
        )
