"""Sequence-based client gesture validity."""

from __future__ import annotations

from collections.abc import Mapping

from trame_vtklocal.store import SceneStore


def event_is_current(
    store: SceneStore, event: object, node_id: str | int | None, strict: bool = True
) -> bool:
    """Whether a seq-stamped client event is current for one scene node.

    The event's ``seq`` (the client's applied cursor when it built the event)
    must be an int at or above the node's last touch — array patches count,
    they move the points a pick measures (``strict=False`` skips them, for
    mid-gesture events whose own confirmations ride this channel).

    The node is always named by the caller: a client gesture reports the whole
    list of nodes its measurement depended on, and each is checked in turn.
    An unknown or removed node is stale.
    """
    if not isinstance(event, Mapping):
        return False
    seq = event.get("seq")
    if isinstance(seq, bool) or not isinstance(seq, int):
        return False
    if node_id is None:
        return False
    last_seq = store.last_seq_touching(node_id, strict=strict)
    if last_seq is None:
        return False
    return seq >= last_seq
