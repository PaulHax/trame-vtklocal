"""Pure ledger-shape comparison helpers for the push-sync oracle.

Inputs are already in *ledger shape*: callers must pass values through
``push_sync._state_for_ledger`` so transport-only fields and inline ``content``
bytes are stripped first.

The normalizer flattens the dependency tree into ``{id: object_state}``,
preserves dependency signatures that are not already encoded by object calls,
collapses top-level ``calls`` to a multiset, drops the root ``mtime`` (which
the scene counter bumps on every full translate), and resolves array
descriptors to their concrete bytes via an injected resolver. ``v:...``
synthetic hashes, ``cell:conn:off`` cell-array hashes, and normal content
hashes are compared by the bytes the resolver returns, not by hash string.
"""

import base64
from collections import Counter
from copy import deepcopy
from typing import Callable

ARRAY_DESCRIPTOR_FIELDS = ("dataType", "numberOfComponents", "size")

# Fields stamped by Render() / pipeline timing that aren't user-visible state.
# The patch path doesn't refresh non-dirty objects, but the shadow snapshot
# always renders before translating, so these drift between the two even when
# the synced content is identical. The vtk.js client uses these for LOD
# heuristics only — leaving them stale on the patch ledger is benign.
RENDER_TIMING_PROPERTIES = frozenset(
    {
        "renderTime",
        "renderTimeMultiplier",
        "estimatedRenderTime",
    }
)

# Resolver: descriptor dict -> bytes (or None if it cannot be resolved).
ResolveBytes = Callable[[dict], "bytes | None"]


def _is_array_descriptor(value):
    return (
        isinstance(value, dict)
        and "hash" in value
        and "dataType" in value
    )


def _array_signature(descriptor: dict, resolve_bytes: ResolveBytes):
    """Return a comparable signature for one array descriptor."""
    metadata = {key: descriptor.get(key) for key in ARRAY_DESCRIPTOR_FIELDS}
    payload = resolve_bytes(descriptor)
    payload_bytes = bytes(payload) if payload is not None else None
    return ("array", metadata, payload_bytes, len(payload_bytes) if payload_bytes else 0)


def _normalize_value(value, resolve_bytes: ResolveBytes, drop_keys=()):
    if isinstance(value, list):
        return [_normalize_value(item, resolve_bytes) for item in value]
    if not isinstance(value, dict):
        return value
    if _is_array_descriptor(value):
        return _array_signature(value, resolve_bytes)
    return {
        key: _normalize_value(child, resolve_bytes)
        for key, child in value.items()
        if key not in drop_keys
    }


def _call_reference_ids(value):
    refs = set()
    if isinstance(value, str):
        prefix = "instance:${"
        if value.startswith(prefix) and value.endswith("}"):
            refs.add(value[len(prefix):-1])
        return refs
    if isinstance(value, list):
        for item in value:
            refs.update(_call_reference_ids(item))
        return refs
    if isinstance(value, dict):
        for item in value.values():
            refs.update(_call_reference_ids(item))
    return refs


def _dependency_signature(children, call_reference_ids):
    signature = []
    for child in children:
        if not isinstance(child, dict):
            continue
        child_id = child.get("id")
        if child_id is None:
            continue
        child_id = str(child_id)
        # vtkjs_translator may include a dependency payload only the first time
        # an object is encountered. If a call already records the relationship,
        # duplicated dependency payloads are a transport detail, not state.
        if child_id in call_reference_ids:
            continue
        signature.append((child_id, child.get("type")))
    return signature


def _flatten_objects(state: dict, resolve_bytes: ResolveBytes):
    """Walk dependencies and return {id: normalized_object_with_dep_signature}.

    Drops ``mtime`` on every node. ``Render()`` (run by the shadow callback) bumps
    VTK MTime on render-side objects (cameras, render passes, etc.) that the
    patch path doesn't refresh. The vtk.js client doesn't render off MTime; what
    matters is property / array / dependency / calls equivalence. Real
    divergences still surface through those fields.

    Per-object ``calls`` are collapsed into a multiset (same as top-level)
    because the server emits calls in vtkObjectManager state iteration order
    while the JS dump emits in ``PROPERTY_RELATIONS`` declaration order; the
    semantic content (which method was called with which args) is the same.
    """
    objects = {}

    def visit(node):
        if not isinstance(node, dict):
            return
        object_id = node.get("id")
        children = node.get("dependencies") or []
        body = {}
        dependency_signature = _dependency_signature(
            children,
            _call_reference_ids(node.get("calls") or []),
        )
        if dependency_signature:
            body["dependencies"] = dependency_signature
        for key, child in node.items():
            if key in ("dependencies", "mtime"):
                continue
            if key == "properties" and isinstance(child, dict):
                body[key] = {
                    prop_key: _normalize_value(prop_val, resolve_bytes)
                    for prop_key, prop_val in child.items()
                    if prop_key not in RENDER_TIMING_PROPERTIES
                }
                continue
            if key == "calls" and isinstance(child, list):
                body[key] = Counter(
                    tuple(_freeze(call)) for call in child
                )
                continue
            body[key] = _normalize_value(child, resolve_bytes)
        if object_id is not None:
            objects[str(object_id)] = body
        for child in children:
            visit(child)

    visit(state)
    return objects


def _normalize_calls(state: dict):
    calls = state.get("calls") or []
    return Counter(tuple(_freeze(call)) for call in calls)


def _freeze(value):
    if isinstance(value, list):
        return tuple(_freeze(item) for item in value)
    if isinstance(value, dict):
        return tuple(sorted((k, _freeze(v)) for k, v in value.items()))
    return value


def normalize(state: dict, resolve_bytes: ResolveBytes) -> dict:
    """Convert a ledger-shape state tree into a comparable representation.

    ``state`` must already be in ledger shape (envelope keys + inline content
    stripped). The result drops the root ``mtime`` field, flattens objects into
    ``{id: object}`` while preserving dependency signatures not already encoded
    by calls, treats top-level ``calls`` as a multiset, and rewrites every array
    descriptor as a signature whose ``content`` field is the bytes returned by
    ``resolve_bytes``.
    """
    state = deepcopy(state)
    state.pop("mtime", None)

    objects = _flatten_objects(state, resolve_bytes)
    # The top-level node also lives in ``objects`` keyed by its id. We keep
    # only the per-object body there. Top-level ``calls`` are recorded as a
    # multiset because tracker-based emission order is not semantically
    # observable.
    calls = _normalize_calls(state)

    return {
        "objects": objects,
        "calls": calls,
    }


def first_difference(left: dict, right: dict):
    """Return a short human-readable description of the first difference."""
    if left == right:
        return None

    left_calls = left.get("calls") or Counter()
    right_calls = right.get("calls") or Counter()
    if left_calls != right_calls:
        only_left = (left_calls - right_calls)
        only_right = (right_calls - left_calls)
        parts = []
        if only_left:
            parts.append(f"calls only in ledger: {dict(only_left)}")
        if only_right:
            parts.append(f"calls only in shadow: {dict(only_right)}")
        return "; ".join(parts) or "calls multiset differs"

    left_objects = left.get("objects") or {}
    right_objects = right.get("objects") or {}

    only_left_ids = set(left_objects) - set(right_objects)
    only_right_ids = set(right_objects) - set(left_objects)
    if only_left_ids:
        return f"object ids only in ledger: {sorted(only_left_ids)[:5]}"
    if only_right_ids:
        return f"object ids only in shadow: {sorted(only_right_ids)[:5]}"

    for object_id in sorted(left_objects):
        left_obj = left_objects[object_id]
        right_obj = right_objects[object_id]
        if left_obj == right_obj:
            continue
        path = _first_diff_path(left_obj, right_obj, prefix=object_id)
        return f"first differing object {object_id}: {path}"

    return "states differ but no per-object diff found"


def _first_diff_path(left, right, prefix):
    if left == right:
        return None
    if type(left) is not type(right):
        return f"{prefix}: type mismatch ({type(left).__name__} vs {type(right).__name__})"
    if isinstance(left, dict):
        keys = sorted(set(left) | set(right))
        for key in keys:
            if left.get(key) != right.get(key):
                child_path = _first_diff_path(
                    left.get(key), right.get(key), prefix=f"{prefix}.{key}"
                )
                return child_path or f"{prefix}.{key} differs"
    if isinstance(left, list):
        if len(left) != len(right):
            return f"{prefix}: list length {len(left)} vs {len(right)}"
        for index, (left_item, right_item) in enumerate(zip(left, right)):
            if left_item != right_item:
                child_path = _first_diff_path(
                    left_item, right_item, prefix=f"{prefix}[{index}]"
                )
                return child_path or f"{prefix}[{index}] differs"
    if isinstance(left, tuple) and len(left) >= 1 and left and left[0] == "array":
        # array signature tuple
        _, left_meta, left_bytes, left_size = left
        _, right_meta, right_bytes, right_size = right
        if left_meta != right_meta:
            return f"{prefix}: array metadata {left_meta} vs {right_meta}"
        if left_size != right_size:
            return f"{prefix}: array byte length {left_size} vs {right_size}"
        if left_bytes != right_bytes:
            return f"{prefix}: array bytes differ (len={left_size})"
    return f"{prefix} differs ({left!r} vs {right!r})" if not isinstance(left, (dict, list)) else f"{prefix} differs"


def inline_resolver(descriptor: dict) -> "bytes | None":
    """Return ``descriptor['content']`` as bytes, decoding base64 if needed.

    The JS-oracle dump emits arrays with raw bytes inlined under ``content``;
    nothing else needs to consult a hash registry. This pairs with
    :func:`make_resolver` for the server side, where ``v:`` / ``cell:`` hashes
    point into the live :class:`PartialArrayLedger` and blob registry.
    """
    content = descriptor.get("content")
    if content is None:
        return None
    if isinstance(content, str):
        return base64.b64decode(content)
    if isinstance(content, (bytes, bytearray)):
        return bytes(content)
    return bytes(memoryview(content))


def make_resolver(push_sync, vtk_object_manager) -> ResolveBytes:
    """Return a resolver that walks ``v:`` / ``cell:`` / blob hashes.

    The harness injects this so the pure normalizer never imports push_sync.
    """
    from trame_vtklocal.widgets.push_sync import (  # local import keeps normalize.py pure-by-default
        SYNTHETIC_CELL_PREFIX,
        SYNTHETIC_VERSION_PREFIX,
        _pack_cell_array_payload,
    )

    def resolve(descriptor):
        hash_val = descriptor.get("hash")
        if not hash_val:
            return None
        if hash_val.startswith(SYNTHETIC_VERSION_PREFIX):
            return push_sync._resolve_version_payload(hash_val, descriptor)
        if hash_val.startswith(SYNTHETIC_CELL_PREFIX):
            return _pack_cell_array_payload(vtk_object_manager, hash_val)
        blob = vtk_object_manager.GetBlob(hash_val)
        if blob is None:
            return None
        return bytes(memoryview(blob))

    return resolve
