"""Incremental membership of the serialized VTK dependency graph."""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from typing import TYPE_CHECKING

from vtkmodules.vtkCommonExecutionModel import vtkAlgorithm

from trame_vtklocal.module.vtkjs_translator import get_ref_id

if TYPE_CHECKING:
    from vtkmodules.vtkCommonCore import vtkObjectBase
    from vtkmodules.vtkSerializationManager import vtkObjectManager

    from trame_vtklocal.module.state_cache import ParsedStateCache


def _references(value: object) -> Iterator[str]:
    if isinstance(value, dict):
        ref = get_ref_id(value)
        if ref:
            yield str(ref)
        else:
            for child in value.values():
                if isinstance(child, (dict, list)):
                    yield from _references(child)
    elif isinstance(value, list):
        for child in value:
            if isinstance(child, (dict, list)):
                yield from _references(child)


def mtime(obj: vtkObjectBase) -> int:
    getter = getattr(obj, "GetMTime", None)
    return getter() if getter else -1


class DependencyGraph:
    """Direct edges, reverse edges and live wrappers owned by one render window.

    Only refreshed roots and changed/new descendants read serialized state.
    A reachability pass over cached edges is needed only when edges disappear;
    this handles cycles and shared children without a per-frame VTK traversal.
    """

    def __init__(
        self, manager: vtkObjectManager, root: int, cache: ParsedStateCache
    ) -> None:
        self.manager = manager
        self.root = str(root)
        self.cache = cache
        self.objects: dict[str, vtkObjectBase] = {}
        self.classes: dict[str, str] = {}
        self.identifiers: dict[int, str] = {}
        self.children: dict[str, set[str]] = {}
        self.parents: dict[str, set[str]] = {}
        self._state_mtimes: dict[str, int] = {}
        self._needs_prune = False

    def refresh(self, roots: Iterable[str]) -> tuple[set[str], set[str]]:
        try:
            return self._refresh(roots)
        except Exception:
            # A failed descendant refresh must remain reachable on retry even
            # if its ancestors' MTimes were already recorded during this walk.
            self._state_mtimes.clear()
            self._needs_prune = True
            raise

    def _refresh(self, roots: Iterable[str]) -> tuple[set[str], set[str]]:
        changed: set[str] = set()
        removed_edges = self._needs_prune
        # The first walk follows the publisher's eager full serialization.
        refresh_entering = bool(self.objects)
        pending = [(str(root), True) for root in roots]
        seen: set[str] = set()
        while pending:
            object_id, force = pending.pop()
            if object_id in seen:
                continue
            obj = self.manager.GetObjectAtId(int(object_id))
            if obj is None:
                continue
            if refresh_entering and object_id not in self.objects:
                # Objects outside this graph have no observers. Their recorded
                # state can predate edits, even when their identity is retained.
                if isinstance(obj, vtkAlgorithm) and "Mapper" in obj.GetClassName():
                    obj.Update()
                    for port in range(obj.GetNumberOfInputPorts()):
                        for index in range(obj.GetNumberOfInputConnections(port)):
                            data = obj.GetInputDataObject(port, index)
                            data_id = self.manager.GetId(data) if data else 0
                            if data_id:
                                self.manager.UpdateStateFromObject(data_id)
                                self.cache.drop(str(data_id))
                self.manager.UpdateStateFromObject(int(object_id))
            stamp = mtime(obj)
            if not force and self._state_mtimes.get(object_id) == stamp:
                continue
            seen.add(object_id)
            self.cache.drop(object_id)
            state = self.cache.state(self.manager, object_id)
            self.objects[object_id] = obj
            self.identifiers[id(obj)] = object_id
            self.classes[object_id] = obj.GetClassName()
            self._state_mtimes[object_id] = stamp
            changed.add(object_id)
            children = set(_references(state))
            previous = self.children.get(object_id, set())
            self.children[object_id] = children
            for child in previous - children:
                self.parents[child].discard(object_id)
                removed_edges = True
            for child in children - previous:
                self.parents.setdefault(child, set()).add(object_id)
            pending.extend((child, False) for child in children)

        removed = self._prune() if removed_edges else set()
        self._needs_prune = False
        return changed - removed, removed

    def _prune(self) -> set[str]:
        live: set[str] = set()
        pending = [self.root]
        while pending:
            object_id = pending.pop()
            if object_id in live:
                continue
            live.add(object_id)
            pending.extend(self.children.get(object_id, ()))
        removed = set(self.objects) - live
        for object_id in removed:
            for child in self.children.pop(object_id, ()):
                self.parents.get(child, set()).discard(object_id)
            self.parents.pop(object_id, None)
            obj = self.objects.pop(object_id, None)
            if obj is not None:
                self.identifiers.pop(id(obj), None)
            self.classes.pop(object_id, None)
            self._state_mtimes.pop(object_id, None)
            self.cache.drop(object_id)
        return removed

    def clear(self) -> None:
        self._needs_prune = False
        self.objects.clear()
        self.identifiers.clear()
        self.classes.clear()
        self.children.clear()
        self.parents.clear()
        self._state_mtimes.clear()
