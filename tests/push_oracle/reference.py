"""The normative client mirror, free of VTK.

A client mirror that applies every broadcast op with ``apply_ops`` must equal
the server store's ``snapshot()["nodes"]`` after every commit. The JS engine's
mirror store implements exactly this contract.
"""

from __future__ import annotations

import copy


def apply_ops(mirror, ops):
    """Reference client-mirror applier."""
    for op in ops:
        if op["op"] == "upsert":
            mirror[op["id"]] = copy.deepcopy(op["node"])
        elif op["op"] == "remove":
            del mirror[op["id"]]
        elif op["op"] == "patchArray":
            node = mirror[op["id"]]
            arrays = dict(node["arrays"])
            arrays[op["key"]] = {**arrays[op["key"]], "ref": op["ref"]}
            mirror[op["id"]] = {**node, "arrays": arrays}
        else:  # pragma: no cover - protocol violation
            raise AssertionError(f"unknown op {op['op']!r}")
    return mirror
