"""Versioned flat scene store — the replication seam for push sync v2.

The store owns the authoritative "what every client scene should be" state: a
flat ``id -> node`` map plus one global monotonic sequence number. Publishers
write translated nodes through a transaction; the transaction computes
generic, schema-agnostic ops (``upsert`` / ``remove`` / ``patchArray``) plus
the blob-ref deltas the publisher needs for payload inlining and server-side
blob GC. See ``docs/DESIGN-scene-store.md``.

Key properties:

- **Schema-agnostic.** Nodes are opaque JSON-able dicts; any key that differs
  makes the node dirty. New kinds of state (feature blocks, future top-level
  keys) participate in diffing automatically — nothing to register.
- **No per-client state.** One global ``seq``; clients keep their own cursor
  and cache keys and resync from ``snapshot()`` when they can't apply ops.
- **Reachability-based lifetime.** Nodes unreachable from the root after a
  commit are removed automatically; refs from reachable nodes may not dangle.
- **Atomic commits.** A failed commit leaves the store untouched.

This module is intentionally VTK-free and import-light so it can be used from
both ``module/`` and ``widgets/`` and unit-tested without VTK installed.
"""

from __future__ import annotations

import copy
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

# Array-ref namespaces. ``c:``/``c2:`` refs are content-addressed (stable for
# identical bytes); ``v:`` refs are monotonically versioned identities minted
# by ``patch_array`` so in-place region updates never rehash content.
REF_CONTENT_PREFIX = "c:"
REF_CELLS_PREFIX = "c2:"
REF_VERSION_PREFIX = "v:"


# ---------------------------------------------------------------------------
# Pure helpers over node dicts
# ---------------------------------------------------------------------------


def _canonical_refs(node_id, refs):
    if not isinstance(refs, Mapping):
        raise ValueError(f"node {node_id!r}: 'refs' must be a mapping")

    result = {}
    for slot, value in refs.items():
        if isinstance(value, (str, int)):
            result[slot] = str(value)
        elif isinstance(value, Sequence):
            result[slot] = [
                str(item) if isinstance(item, (str, int)) else _bad_ref(node_id, slot, item)
                for item in value
            ]
        else:
            _bad_ref(node_id, slot, value)
    return result


def _bad_ref(node_id, slot, value):
    raise ValueError(
        f"node {node_id!r}: ref slot {slot!r} must hold an id or list of ids, "
        f"got {value!r}"
    )


def _canonical_arrays(node_id, arrays):
    if not isinstance(arrays, Mapping):
        raise ValueError(f"node {node_id!r}: 'arrays' must be a mapping")

    result = {}
    for key, entry in arrays.items():
        if not isinstance(entry, Mapping) or not isinstance(entry.get("ref"), str):
            raise ValueError(
                f"node {node_id!r}: array {key!r} must be a mapping with a "
                f"string 'ref'"
            )
        result[key] = copy.deepcopy(dict(entry))
    return result


def _canonical_node(node_id, node):
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

    result = {}
    for key, value in node.items():
        if key == "refs":
            result[key] = _canonical_refs(node_id, value)
        elif key == "arrays":
            result[key] = _canonical_arrays(node_id, value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def _iter_ref_ids(node):
    for value in (node.get("refs") or {}).values():
        if isinstance(value, str):
            yield value
        else:
            yield from value


def _iter_array_refs(node):
    for entry in (node.get("arrays") or {}).values():
        yield entry["ref"]


def _live_refs(nodes):
    refs = set()
    for node in nodes.values():
        refs.update(_iter_array_refs(node))
    return refs


def _reachability(nodes, root_id):
    """Return (reachable ids, dangling id -> referrer ids) walking ``refs``."""
    reachable = set()
    dangling = {}
    stack = [(root_id, None)]
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


def _sorted_ids(ids):
    return sorted(ids, key=lambda i: (0, int(i)) if i.isdigit() else (1, i))


def _version_ref(node_id, key, version):
    return f"{REF_VERSION_PREFIX}{node_id}:{key}:{version}"


# ---------------------------------------------------------------------------
# Commit planning (pure: state in, new state + result out)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _StoreState:
    nodes: dict  # id -> canonical node (exactly the reachable set)
    seq: int
    array_versions: dict  # (id, key) -> int; survives node removal (id reuse)
    touched: dict  # id -> seq of last op touching a live node


def _plan_commit(state, root_id, upserts, patches):
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
    patch_ops = []
    patched_refs = set()
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

    upsert_ops = [
        {"op": "upsert", "id": node_id, "node": node}
        for node_id, node in upserts.items()
        if node_id in reachable and node != state.nodes.get(node_id)
    ]
    removed_ids = _sorted_ids(set(state.nodes) - reachable)
    remove_ops = [{"op": "remove", "id": node_id} for node_id in removed_ids]

    # Upserts first (clients instantiate/rewire), then in-place array patches,
    # then removals of anything the rewiring disconnected.
    ops = [*upsert_ops, *patch_ops, *remove_ops]
    if not ops:
        result = {
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
    touched = dict(state.touched)
    for op in ops:
        if op["op"] != "remove":
            touched[op["id"]] = seq
    for node_id in removed_ids:
        touched.pop(node_id, None)

    new_state = _StoreState(
        nodes=final_nodes,
        seq=seq,
        array_versions=array_versions,
        touched=touched,
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


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


class SceneTransaction:
    """Accumulates upserts and array patches; ``commit()`` applies atomically."""

    def __init__(self, store):
        self._store = store
        self._upserts = {}
        self._patches = []
        self._committed = False

    def _guard(self):
        if self._committed:
            raise RuntimeError("transaction already committed")

    def upsert(self, node_id, node):
        self._guard()
        node_id = str(node_id)
        self._upserts[node_id] = _canonical_node(node_id, node)
        return self

    def upsert_nodes(self, nodes):
        for node_id, node in nodes.items():
            self.upsert(node_id, node)
        return self

    def patch_array(self, node_id, key, offset, data, data_type):
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

    def commit(self):
        self._guard()
        self._committed = True
        return self._store._commit(self._upserts, self._patches)


class SceneStore:
    """Authoritative flat node store for one render window."""

    def __init__(self, root_id):
        self._root_id = str(root_id)
        self._state = _StoreState(nodes={}, seq=0, array_versions={}, touched={})

    @property
    def root_id(self):
        return self._root_id

    @property
    def seq(self):
        return self._state.seq

    def get(self, node_id):
        node = self._state.nodes.get(str(node_id))
        return copy.deepcopy(node) if node is not None else None

    def node_ids(self):
        return frozenset(self._state.nodes)

    def live_refs(self):
        return frozenset(_live_refs(self._state.nodes))

    def last_seq_touching(self, node_id):
        """Seq of the last op touching a live node; None if unknown/removed.

        Callers doing staleness checks must treat None as "stale".
        """
        return self._state.touched.get(str(node_id))

    def snapshot(self):
        """Wire-ready full state: ``{seq, root, nodes}`` (deep copy)."""
        return {
            "seq": self._state.seq,
            "root": self._root_id,
            "nodes": copy.deepcopy(self._state.nodes),
        }

    def advance(self):
        """Mint a seq with no ops (for command-only broadcasts)."""
        state = self._state
        self._state = _StoreState(
            nodes=state.nodes,
            seq=state.seq + 1,
            array_versions=state.array_versions,
            touched=state.touched,
        )
        return state.seq, self._state.seq

    def transact(self):
        return SceneTransaction(self)

    def _commit(self, upserts, patches):
        new_state, result = _plan_commit(self._state, self._root_id, upserts, patches)
        self._state = new_state
        return result
