"""Structural types for the trame and wslink objects the package is handed.

trame and wslink ship no type information, so each Protocol names only the
members this package calls.
"""

from __future__ import annotations

from collections.abc import Callable
from types import ModuleType
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from trame_vtklocal.module.protocol import ObjectManagerAPI


class NamedServer(Protocol):
    """A trame server as far as per-server module state needs it."""

    @property
    def name(self) -> str: ...


class LinkProtocolRoot(Protocol):
    """The wslink server protocol handed to protocol configuration callbacks."""

    def registerLinkProtocol(self, protocol: ObjectManagerAPI, /) -> object: ...


class ProtocolHostServer(NamedServer, Protocol):
    """A trame server that registers wslink protocols once it starts."""

    def add_protocol_to_configure(
        self, configure_protocol_fn: Callable[[LinkProtocolRoot], None], /
    ) -> object: ...


class ModuleHostServer(NamedServer, Protocol):
    """A trame server that can enable a module definition."""

    def enable_module(
        self, module: ModuleType | dict[str, object], /, **kwargs: object
    ) -> object: ...


class UpdateThrottle(Protocol):
    """trame's ``Throttle`` around :meth:`LocalView.update`."""

    rate: float

    def __call__(self, *args: object, **kwargs: object) -> None: ...
