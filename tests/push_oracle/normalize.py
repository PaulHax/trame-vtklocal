"""Flat-node comparison helpers for the push-sync v2 e2e oracle.

Both sides of the comparison are already in the wire's flat-node shape
(``{"root", "nodes": {id: {type, props, refs, arrays, blocks}}}``):

- the client dump (``getAppliedSceneState``) carries per-array ``content``
  base64 read back from the bound vtk.js data arrays;
- the server shadow is ``store.snapshot()`` plus a ``blobs`` map inlining
  bytes for every live array ref.

Normalization replaces each array entry's payload indirection with the
concrete bytes so the two sides compare with plain ``==`` (Python equates
``True == 1`` and ``4 == 4.0``, which absorbs JSON round-trip representation
drift). Everything else — types, props, ref slots, blocks, and the array
refs themselves (the client mirror must hold the server's refs verbatim) —
must match exactly.
"""

from __future__ import annotations

import base64


def _content_bytes(value):
    if value is None:
        return None
    if isinstance(value, str):
        return base64.b64decode(value)
    return bytes(value)


def _normalize_arrays(arrays, content_for):
    normalized = {}
    for key, entry in (arrays or {}).items():
        entry = dict(entry)
        inline = _content_bytes(entry.pop("content", None))
        normalized[key] = {
            **entry,
            "content": inline if inline is not None else content_for(entry),
        }
    return normalized


def _normalize_nodes(nodes, content_for):
    normalized = {}
    for node_id, node in (nodes or {}).items():
        out = {"type": node.get("type")}
        for section in ("props", "refs", "blocks"):
            if node.get(section):
                out[section] = node[section]
        arrays = _normalize_arrays(node.get("arrays"), content_for)
        if arrays:
            out["arrays"] = arrays
        normalized[str(node_id)] = out
    return normalized


def normalize_client_dump(dump):
    """Client ``getAppliedSceneState`` output -> comparable structure."""

    def content_for(entry):
        return None  # client entries carry inline content or nothing

    return {
        "root": str(dump["root"]),
        "nodes": _normalize_nodes(dump.get("nodes"), content_for),
    }


def normalize_server_shadow(shadow):
    """Server ``oracle.shadow`` payload -> comparable structure."""
    blobs = shadow.get("blobs") or {}

    def content_for(entry):
        return _content_bytes(blobs.get(entry.get("ref")))

    return {
        "root": str(shadow["root"]),
        "nodes": _normalize_nodes(shadow.get("nodes"), content_for),
    }


def first_difference(a, b, path="$"):
    """First diverging path between two normalized structures, or None."""
    if isinstance(a, dict) and isinstance(b, dict):
        for key in sorted(set(a) | set(b), key=str):
            if key not in a:
                return {"path": f"{path}.{key}", "client": "<missing>", "server": b[key]}
            if key not in b:
                return {"path": f"{path}.{key}", "client": a[key], "server": "<missing>"}
            found = first_difference(a[key], b[key], f"{path}.{key}")
            if found:
                return found
        return None
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return {
                "path": f"{path}.length",
                "client": len(a),
                "server": len(b),
            }
        for index, (item_a, item_b) in enumerate(zip(a, b)):
            found = first_difference(item_a, item_b, f"{path}[{index}]")
            if found:
                return found
        return None
    if a != b:
        return {"path": path, "client": a, "server": b}
    return None
