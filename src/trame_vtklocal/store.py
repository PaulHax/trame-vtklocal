"""Versioned flat scene store — the replication seam for push sync v2.

The store owns the authoritative "what every client scene should be" state: a
flat ``id -> node`` map plus one global monotonic sequence number. Publishers
write translated nodes through a transaction; the transaction computes
generic, schema-agnostic ops (``upsert`` / ``remove`` / ``patchArray``) plus
the blob-ref deltas the publisher needs for payload inlining and server-side
blob GC.

Nodes are schema-agnostic, client-independent, reachability-pruned, and
committed atomically.

This module is intentionally VTK-free and import-light so it can be used from
both ``module/`` and ``widgets/`` and unit-tested without VTK installed.
"""

from __future__ import annotations

import copy
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import (
    TYPE_CHECKING,
    Literal,
    NoReturn,
    Tuple,
    TypedDict,
    TypeVar,
    Union,
    cast,
)

if TYPE_CHECKING:
    from typing_extensions import Buffer

# Array-ref namespaces. ``c:``/``c2:`` refs are content-addressed (stable for
# identical bytes); ``v:`` refs are monotonically versioned identities minted
# by ``patch_array`` so in-place region updates never rehash content.
REF_CONTENT_PREFIX = "c:"
REF_CELLS_PREFIX = "c2:"
REF_VERSION_PREFIX = "v:"

# A ref slot names one node id or an ordered list of them.
RefSlot = Union[str, list[str]]
# Array payload bytes; wslink attachments hand back the buffer they were given.
WirePayload = Union[bytes, memoryview]


class _ArrayEntryRequired(TypedDict):
    ref: str


class ArrayEntry(_ArrayEntryRequired, total=False):
    """One dataset array of a node; ``ref`` names its payload."""

    dataType: str
    size: int
    numberOfComponents: int
    name: str
    location: str
    registration: str
    vtkClass: str


class _SceneNodeRequired(TypedDict):
    type: str


class SceneNode(_SceneNodeRequired, total=False):
    """A flat store node. Only ``refs`` and ``arrays`` have enforced shapes."""

    props: dict[str, object]
    refs: dict[str, RefSlot]
    arrays: dict[str, ArrayEntry]
    blocks: dict[str, Mapping[str, object]]


class UpsertOp(TypedDict):
    op: Literal["upsert"]
    id: str
    node: SceneNode


class PatchArrayOp(TypedDict):
    op: Literal["patchArray"]
    id: str
    key: str
    offset: int
    data: WirePayload
    dataType: str
    ref: str


class RemoveOp(TypedDict):
    op: Literal["remove"]
    id: str


SceneOp = Union[UpsertOp, PatchArrayOp, RemoveOp]


class CommitResult(TypedDict):
    base_seq: int
    seq: int
    ops: list[SceneOp]
    blob_refs_entering: frozenset[str]
    refs_leaving: frozenset[str]


class StoreSnapshot(TypedDict):
    seq: int
    root: str
    nodes: dict[str, SceneNode]


# (node id, array key, element offset, element bytes, JS typed-array name)
_ArrayPatch = Tuple[str, str, int, bytes, str]


def ref_manager_hashes(refs: Iterable[str] | None) -> set[str]:
    """Raw object-manager blob hashes behind ``c:``/``c2:`` refs.

    ``v:`` refs are versioned identities resolved from live VTK arrays — they
    have no object-manager blob, so they contribute nothing here.
    """
    hashes: set[str] = set()
    for ref in refs or ():
        if ref.startswith(REF_CONTENT_PREFIX):
            hashes.add(ref[len(REF_CONTENT_PREFIX) :])
        elif ref.startswith(REF_CELLS_PREFIX):
            connectivity_hash, offsets_hash = ref[len(REF_CELLS_PREFIX) :].split(":", 1)
            hashes.add(connectivity_hash)
            hashes.add(offsets_hash)
    return hashes


_T = TypeVar("_T")


def _copy_value(value: _T) -> _T:
    """Deep copy of JSON-shaped node data, about 3x faster than ``deepcopy``."""
    copied: object = value
    if type(value) is dict:
        items = cast("dict[str, object]", value).items()
        copied = {key: _copy_value(item) for key, item in items}
    elif type(value) is list:
        copied = [_copy_value(item) for item in cast("list[object]", value)]
    elif value is not None and not isinstance(value, (str, int, float)):
        copied = copy.deepcopy(value)
    return cast(_T, copied)


def _canonical_refs(node_id: str, refs: object) -> dict[str, RefSlot]:
    if not isinstance(refs, Mapping):
        raise ValueError(f"node {node_id!r}: 'refs' must be a mapping")

    result: dict[str, RefSlot] = {}
    for slot, value in refs.items():
        if isinstance(value, (str, int)):
            result[slot] = str(value)
        elif isinstance(value, Sequence):
            result[slot] = [
                str(item)
                if isinstance(item, (str, int))
                else _bad_ref(node_id, slot, item)
                for item in value
            ]
        else:
            _bad_ref(node_id, slot, value)
    return result


def _bad_ref(node_id: str, slot: str, value: object) -> NoReturn:
    raise ValueError(
        f"node {node_id!r}: ref slot {slot!r} must hold an id or list of ids, "
        f"got {value!r}"
    )


def _canonical_arrays(
    node_id: str, arrays: Mapping[str, ArrayEntry]
) -> dict[str, ArrayEntry]:
    if not isinstance(arrays, Mapping):
        raise ValueError(f"node {node_id!r}: 'arrays' must be a mapping")

    result: dict[str, ArrayEntry] = {}
    for key, entry in arrays.items():
        if not isinstance(entry, Mapping) or not isinstance(entry.get("ref"), str):
            raise ValueError(
                f"node {node_id!r}: array {key!r} must be a mapping with a string 'ref'"
            )
        entry_copy: ArrayEntry = {**entry}
        result[key] = _copy_value(entry_copy)
    return result


def _canonical_node(node_id: str, node: SceneNode) -> SceneNode:
    """Validate and deep-copy a node into its stored canonical form.

    Unknown top-level keys are allowed and preserved — they diff like any
    other data. Only ``refs`` (graph structure) and ``arrays`` (payload refs)
    have enforced shapes.
    """
    if not isinstance(node, Mapping):
        raise ValueError(f"node {node_id!r} must be a mapping")
    node_type = node.get("type")
    if not isinstance(node_type, str) or not node_type:
        raise ValueError(f"node {node_id!r} needs a non-empty string 'type'")

    refs = _canonical_refs(node_id, node["refs"]) if "refs" in node else None
    arrays = _canonical_arrays(node_id, node["arrays"]) if "arrays" in node else None
    # Empty placeholders keep the slots in key order so the single deep copy
    # below never walks the refs and arrays already copied above.
    rest: SceneNode = {**node}
    if refs is not None:
        rest["refs"] = {}
    if arrays is not None:
        rest["arrays"] = {}
    result = _copy_value(rest)
    if refs is not None:
        result["refs"] = refs
    if arrays is not None:
        result["arrays"] = arrays
    return result


def _iter_ref_ids(node: SceneNode) -> Iterator[str]:
    for value in (node.get("refs") or {}).values():
        if isinstance(value, str):
            yield value
        else:
            yield from value


def _iter_array_refs(node: SceneNode) -> Iterator[str]:
    for entry in (node.get("arrays") or {}).values():
        yield entry["ref"]


def _live_refs(nodes: Mapping[str, SceneNode]) -> set[str]:
    refs: set[str] = set()
    for node in nodes.values():
        refs.update(_iter_array_refs(node))
    return refs


def _reachability(
    nodes: Mapping[str, SceneNode], root_id: str
) -> tuple[set[str], dict[str, set[str | None]]]:
    """Return (reachable ids, dangling id -> referrer ids) walking ``refs``."""
    reachable: set[str] = set()
    dangling: dict[str, set[str | None]] = {}
    stack: list[tuple[str, str | None]] = [(root_id, None)]
    while stack:
        node_id, referrer = stack.pop()
        if node_id in reachable:
            continue
        node = nodes.get(node_id)
        if node is None:
            dangling.setdefault(node_id, set()).add(referrer)
            continue
        reachable.add(node_id)
        for ref_id in _iter_ref_ids(node):
            if ref_id not in reachable:
                stack.append((ref_id, node_id))
    return reachable, dangling


def _sorted_ids(ids: Iterable[str]) -> list[str]:
    return sorted(ids, key=lambda i: (0, int(i)) if i.isdigit() else (1, i))


def _version_ref(node_id: str, key: str, version: int) -> str:
    return f"{REF_VERSION_PREFIX}{node_id}:{key}:{version}"


@dataclass(frozen=True)
class _StoreState:
    nodes: dict[str, SceneNode]  # id -> canonical node (exactly the reachable set)
    seq: int
    # (id, key) -> int; survives node removal (id reuse)
    array_versions: dict[tuple[str, str], int]
    touched_structural: dict[str, int]  # id -> seq of last upsert touching a live node
    touched_array: dict[str, int]  # id -> seq of last patchArray touching a live node


def _plan_commit(
    state: _StoreState,
    root_id: str,
    upserts: Mapping[str, SceneNode],
    patches: Iterable[_ArrayPatch],
) -> tuple[_StoreState, CommitResult]:
    next_nodes = dict(state.nodes)
    next_nodes.update(upserts)

    if upserts:
        reachable, dangling = _reachability(next_nodes, root_id)
        if dangling:
            details = ", ".join(
                f"{node_id!r} (referenced by "
                f"{_sorted_ids({str(r) for r in referrers})})"
                for node_id, referrers in sorted(dangling.items())
            )
            raise ValueError(f"commit references missing nodes: {details}")
    else:
        reachable = set(state.nodes)

    array_versions = dict(state.array_versions)
    patch_ops: list[PatchArrayOp] = []
    patched_refs: set[str] = set()
    for node_id, key, offset, data, data_type in patches:
        node = next_nodes.get(node_id)
        if node is None:
            raise ValueError(f"patch_array target node {node_id!r} does not exist")
        arrays = node.get("arrays") or {}
        if key not in arrays:
            raise ValueError(f"patch_array: node {node_id!r} has no array {key!r}")
        if node_id not in reachable:
            # The same commit removes this node; the patch is moot.
            continue

        version = array_versions.get((node_id, key), 0) + 1
        array_versions[(node_id, key)] = version
        ref = _version_ref(node_id, key, version)
        next_nodes[node_id] = {
            **node,
            "arrays": {**arrays, key: {**arrays[key], "ref": ref}},
        }
        patched_refs.add(ref)
        patch_ops.append(
            {
                "op": "patchArray",
                "id": node_id,
                "key": key,
                "offset": offset,
                "data": data,
                "dataType": data_type,
                "ref": ref,
            }
        )

    upsert_ops: list[UpsertOp] = [
        {"op": "upsert", "id": node_id, "node": node}
        for node_id, node in upserts.items()
        if node_id in reachable and node != state.nodes.get(node_id)
    ]
    removed_ids = _sorted_ids(set(state.nodes) - reachable)
    remove_ops: list[RemoveOp] = [
        {"op": "remove", "id": node_id} for node_id in removed_ids
    ]

    # Upserts first (clients instantiate/rewire), then in-place array patches,
    # then removals of anything the rewiring disconnected.
    ops: list[SceneOp] = [*upsert_ops, *patch_ops, *remove_ops]
    if not ops:
        result: CommitResult = {
            "base_seq": state.seq,
            "seq": state.seq,
            "ops": [],
            "blob_refs_entering": frozenset(),
            "refs_leaving": frozenset(),
        }
        return state, result

    final_nodes = {node_id: next_nodes[node_id] for node_id in reachable}
    live_before = _live_refs(state.nodes)
    live_after = _live_refs(final_nodes)

    seq = state.seq + 1
    touched_structural = dict(state.touched_structural)
    touched_array = dict(state.touched_array)
    for op in ops:
        if op["op"] == "upsert":
            touched_structural[op["id"]] = seq
        elif op["op"] == "patchArray":
            touched_array[op["id"]] = seq
    for node_id in removed_ids:
        touched_structural.pop(node_id, None)
        touched_array.pop(node_id, None)

    new_state = _StoreState(
        nodes=final_nodes,
        seq=seq,
        array_versions=array_versions,
        touched_structural=touched_structural,
        touched_array=touched_array,
    )
    result = {
        "base_seq": state.seq,
        "seq": seq,
        "ops": ops,
        # patchArray content rides its op; everything else entering the live
        # set must be inlined (or resolvable) by the publisher exactly once.
        "blob_refs_entering": frozenset((live_after - live_before) - patched_refs),
        "refs_leaving": frozenset(live_before - live_after),
    }
    return new_state, result


class SceneTransaction:
    """Accumulates upserts and array patches; ``commit()`` applies atomically."""

    def __init__(self, store: SceneStore) -> None:
        self._store = store
        self._upserts: dict[str, SceneNode] = {}
        self._patches: list[_ArrayPatch] = []
        self._committed = False

    def _guard(self) -> None:
        if self._committed:
            raise RuntimeError("transaction already committed")

    def upsert(self, node_id: str | int, node: SceneNode) -> SceneTransaction:
        self._guard()
        node_id = str(node_id)
        self._upserts[node_id] = _canonical_node(node_id, node)
        return self

    def upsert_nodes(self, nodes: Mapping[str, SceneNode]) -> SceneTransaction:
        for node_id, node in nodes.items():
            self.upsert(node_id, node)
        return self

    def patch_array(
        self,
        node_id: str | int,
        key: str,
        offset: int,
        data: Buffer,
        data_type: str,
    ) -> SceneTransaction:
        """Queue an in-place region update of ``node.arrays[key]``.

        ``offset`` is the flat element offset in the target typed array;
        ``data`` is the raw little-endian element bytes for the region.
        """
        self._guard()
        offset = int(offset)
        if offset < 0:
            raise ValueError("patch_array offset must be >= 0")
        if not isinstance(data_type, str) or not data_type:
            raise ValueError("patch_array data_type must be a non-empty string")
        self._patches.append((str(node_id), str(key), offset, bytes(data), data_type))
        return self

    def commit(self) -> CommitResult:
        self._guard()
        self._committed = True
        return self._store._commit(self._upserts, self._patches)


class SceneStore:
    """Authoritative flat node store for one render window."""

    def __init__(self, root_id: str | int) -> None:
        self._root_id = str(root_id)
        self._state = _StoreState(
            nodes={},
            seq=0,
            array_versions={},
            touched_structural={},
            touched_array={},
        )

    @property
    def root_id(self) -> str:
        return self._root_id

    @property
    def seq(self) -> int:
        return self._state.seq

    def get(self, node_id: str | int) -> SceneNode | None:
        node = self._state.nodes.get(str(node_id))
        return _copy_value(node) if node is not None else None

    def node_ids(self) -> frozenset[str]:
        return frozenset(self._state.nodes)

    def live_refs(self) -> frozenset[str]:
        return frozenset(_live_refs(self._state.nodes))

    def last_seq_touching(self, node_id: str | int, strict: bool = True) -> int | None:
        """Seq relevant to event staleness for a live node.

        By default every touch counts — array patches move points, so a pick
        measured against pre-patch geometry is stale. ``strict=False`` counts
        only structural upserts, for callers validating events mid-gesture
        whose own array confirmations ride the same channel. Unknown or
        removed nodes return ``None`` and must be treated as stale.
        """
        node_id = str(node_id)
        structural = self._state.touched_structural.get(node_id)
        if not strict:
            return structural
        array = self._state.touched_array.get(node_id)
        if structural is None:
            return array
        if array is None:
            return structural
        return max(structural, array)

    def snapshot(self) -> StoreSnapshot:
        """Wire-ready full state: ``{seq, root, nodes}`` (deep copy)."""
        return {
            "seq": self._state.seq,
            "root": self._root_id,
            "nodes": _copy_value(self._state.nodes),
        }

    def advance(self) -> tuple[int, int]:
        """Mint a seq with no ops (for command-only broadcasts)."""
        state = self._state
        self._state = _StoreState(
            nodes=state.nodes,
            seq=state.seq + 1,
            array_versions=state.array_versions,
            touched_structural=state.touched_structural,
            touched_array=state.touched_array,
        )
        return state.seq, self._state.seq

    def transact(self) -> SceneTransaction:
        return SceneTransaction(self)

    def _commit(
        self, upserts: Mapping[str, SceneNode], patches: Iterable[_ArrayPatch]
    ) -> CommitResult:
        new_state, result = _plan_commit(self._state, self._root_id, upserts, patches)
        self._state = new_state
        return result
