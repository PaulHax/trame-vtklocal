"""VTK-identity-safe streamed actor registration for scene publishers."""

from __future__ import annotations

import threading
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from vtkmodules.vtkCommonCore import vtkCommand, vtkWeakReference

if TYPE_CHECKING:
    from vtkmodules.vtkCommonCore import vtkObject, vtkObjectBase
    from vtkmodules.vtkSerializationManager import vtkObjectManager

    from trame_vtklocal.streamed_scene import (
        PointCloudSource,
        StreamedSceneActor,
        StreamedSource,
        Tiles3DSource,
    )


def _source_types() -> tuple[type[PointCloudSource], type[Tiles3DSource]]:
    # Delayed imports make this module safe to import before streamed_scene.
    from trame_vtklocal.streamed_scene import PointCloudSource, Tiles3DSource

    return (PointCloudSource, Tiles3DSource)


def _streamed_actor_type() -> type[StreamedSceneActor]:
    from trame_vtklocal.streamed_scene import StreamedSceneActor

    return StreamedSceneActor


def _actor_address(actor: vtkObjectBase) -> str:
    """Canonical C++ address, independent of the current Python wrapper."""
    pointer = getattr(actor, "__this__", None)
    if pointer:
        return str(pointer).split("_p_", 1)[0].lstrip("_").lower()
    address = actor.GetAddressAsString("")
    return str(address).split("0x", 1)[-1].lower()


def _vtk_pointer(actor: vtkObjectBase) -> str:
    """Unpatched VTK identity used to validate an address-registry hit."""
    return str(getattr(actor, "__this__", ""))


def _vtk_weak(actor: vtkObject) -> vtkWeakReference:
    reference = vtkWeakReference()
    reference.Set(actor)
    return reference


@dataclass
class _Registration:
    source: StreamedSource
    vtk_object: vtkWeakReference
    observer_tag: int | None = None
    scopes: set[int] = field(default_factory=set)
    ever_scoped: bool = False

    def resolves(self, actor: vtkObjectBase) -> bool:
        registered = self.vtk_object.Get()
        return registered is not None and _vtk_pointer(registered) == _vtk_pointer(
            actor
        )


_REGISTRATION_LOCK = threading.RLock()
_REGISTRATIONS: dict[str, _Registration] = {}


def _detach_observer(registration: _Registration | None) -> None:
    """Take the DeleteEvent hook back off the actor a registration watched.

    The actor owns the observer, and the observer owns the closure that owns
    the registration and its source, so a registration that leaves the table
    without this stays alive — and re-registering the same actor stacks a
    second hook — for as long as the actor lives.
    """
    if registration is None:
        return
    tag, registration.observer_tag = registration.observer_tag, None
    if tag is None:
        return
    actor = registration.vtk_object.Get()
    if actor is not None:
        actor.RemoveObserver(tag)


def _drop_registration(address: str, registration: _Registration | None = None) -> None:
    with _REGISTRATION_LOCK:
        current = _REGISTRATIONS.get(address)
        if registration is not None and current is not registration:
            return
        dropped = _REGISTRATIONS.pop(address, None)
    _detach_observer(dropped)


def _on_vtk_delete(
    _vtk_object: vtkObject, _event: str, *, address: str, registration: _Registration
) -> None:
    # The observer dies with the actor invoking it; nothing to detach.
    registration.observer_tag = None
    _drop_registration(address, registration)


def _new_registration(actor: vtkObject, source: StreamedSource) -> _Registration:
    address = _actor_address(actor)
    registration = _Registration(source=source, vtk_object=_vtk_weak(actor))

    def on_delete(vtk_object: vtkObject, event: str) -> None:
        _on_vtk_delete(
            vtk_object,
            event,
            address=address,
            registration=registration,
        )

    with _REGISTRATION_LOCK:
        previous = _REGISTRATIONS.get(address)
        if previous is not None and previous.resolves(actor):
            return previous
        registration.observer_tag = actor.AddObserver(vtkCommand.DeleteEvent, on_delete)
        _REGISTRATIONS[address] = registration
    _detach_observer(previous)
    return registration


def _registration(address: str) -> _Registration | None:
    with _REGISTRATION_LOCK:
        return _REGISTRATIONS.get(address)


def _registration_for_actor(actor: vtkObjectBase) -> _Registration | None:
    address = _actor_address(actor)
    registration = _registration(address)
    if registration is None:
        return None
    if registration.resolves(actor):
        return registration
    # A dead vtkWeakReference or different live C++ object at the same
    # address/id proves this is a stale registry entry, never a streamed hit.
    _drop_registration(address, registration)
    return None


def _registered_source(actor: vtkObjectBase) -> StreamedSource | None:
    registration = _registration_for_actor(actor)
    return registration.source if registration is not None else None


def _register_actor(actor: vtkObject, source: StreamedSource) -> _Registration:
    registration = _registration_for_actor(actor)
    if registration is None:
        registration = _new_registration(actor, source)
    return registration


def _update_registered_source(
    actor: vtkObject, source: StreamedSource
) -> _Registration:
    registration = _register_actor(actor, source)
    registration.source = source
    return registration


def _has_registration(address: str) -> bool:
    return _registration(address) is not None


def _forget_registration(address: str) -> None:
    _drop_registration(address)


def _object_source(actor: vtkObjectBase) -> StreamedSource | None:
    if not isinstance(actor, _streamed_actor_type()):
        return None
    try:
        source = actor.source
    except (AttributeError, RuntimeError):
        return None
    return source if isinstance(source, _source_types()) else None


@dataclass
class _ScopedEntry:
    object_id: str
    address: str
    registration: _Registration


class _StreamedSceneRegistry:
    """Publisher-scoped manager-id associations over global VTK identity."""

    def __init__(self) -> None:
        self._token = id(self)
        self._by_id: dict[str, _ScopedEntry] = {}
        self._by_address: dict[str, _ScopedEntry] = {}

    def object_ids(self) -> frozenset[str]:
        return frozenset(self._by_id)

    def _valid_entry(
        self, entry: _ScopedEntry | None, actor: vtkObjectBase
    ) -> _ScopedEntry | None:
        if entry is None or not entry.registration.resolves(actor):
            if entry is not None:
                self._release(entry)
            return None
        return entry

    def _associate(
        self, actor: vtkObject, object_id: str | int, source: StreamedSource
    ) -> StreamedSource:
        object_id = str(object_id)
        address = _actor_address(actor)
        registration = _register_actor(actor, source)
        # Once registered, this source is authoritative. A stale wrapper or
        # scoped entry may associate with it but can never write it back.
        source = registration.source

        previous = self._by_id.get(object_id)
        if previous is not None and previous.registration is not registration:
            self._release(previous)
        collision = self._by_address.get(address)
        if collision is not None and collision.registration is not registration:
            self._release(collision)

        registration.scopes.add(self._token)
        registration.ever_scoped = True
        entry = _ScopedEntry(object_id, address, registration)
        self._by_id[object_id] = entry
        self._by_address[address] = entry
        return source

    def resolve(
        self, actor: vtkObject, object_id: str | int | None
    ) -> StreamedSource | None:
        """Return a current source for streaming, or ``None`` for plain actors."""
        object_id = str(object_id)
        address = _actor_address(actor)
        registration = _registration_for_actor(actor)
        by_id = self._valid_entry(self._by_id.get(object_id), actor)
        by_address = self._valid_entry(self._by_address.get(address), actor)

        source = registration.source if registration is not None else None
        if source is None and by_id is not None:
            source = by_id.registration.source
        if source is None and by_address is not None:
            source = by_address.registration.source
        if source is None:
            source = _object_source(actor)

        marker = isinstance(actor, _streamed_actor_type())
        recognized = marker or by_id is not None or by_address is not None
        if source is None:
            if recognized:
                raise RuntimeError(
                    f"streamed scene actor {object_id} lost its streamed source"
                )
            return None
        if not isinstance(source, _source_types()):
            raise RuntimeError(
                f"streamed scene actor {object_id} lost its streamed source"
            )
        return self._associate(actor, object_id, source)

    def _release(self, entry: _ScopedEntry) -> None:
        if self._by_id.get(entry.object_id) is entry:
            self._by_id.pop(entry.object_id, None)
        if self._by_address.get(entry.address) is entry:
            self._by_address.pop(entry.address, None)
        registration = entry.registration
        if any(item.registration is registration for item in self._by_id.values()):
            return
        registration.scopes.discard(self._token)
        if registration.ever_scoped and not registration.scopes:
            _drop_registration(entry.address, registration)

    def retain(
        self,
        live_ids: Iterable[str | int],
        object_manager: vtkObjectManager | None = None,
    ) -> None:
        """Drop associations outside the publisher's current dependency ids."""
        live = {str(object_id) for object_id in live_ids}
        for object_id, entry in list(self._by_id.items()):
            if object_id not in live:
                self._release(entry)
                continue
            if object_manager is not None:
                actor = object_manager.GetObjectAtId(int(object_id))
                if actor is None or not entry.registration.resolves(actor):
                    self._release(entry)

    def cleanup(self) -> None:
        self.retain(())


def _resolve_unscoped(actor: vtkObject) -> StreamedSource | None:
    registration = _registration_for_actor(actor)
    if registration is not None:
        if isinstance(registration.source, _source_types()):
            return registration.source
        raise RuntimeError("streamed scene actor lost its streamed source")
    source = _object_source(actor)
    if source is not None:
        return _register_actor(actor, source).source
    if isinstance(actor, _streamed_actor_type()):
        raise RuntimeError("streamed scene actor lost its streamed source")
    return None


def streamed_scene_source(
    actor: vtkObject,
    object_id: str | int | None = None,
    registry: _StreamedSceneRegistry | None = None,
) -> StreamedSource | None:
    """Translator lookup for a live VTK actor wrapper."""
    if registry is None:
        return _resolve_unscoped(actor)
    return registry.resolve(actor, object_id)
