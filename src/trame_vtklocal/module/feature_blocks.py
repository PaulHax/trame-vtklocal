"""Feature blocks stored on the VTK object they describe.

A block is a JSON object kept under a string key in the object's own
``vtkInformation``: ``GetInformation()`` for an algorithm (every mapper), and
``GetPropertyKeys()`` for a prop. The block lives and dies with the C++ object,
so it survives Python wrapper churn without a registry, and the translator
reads it back into ``node["blocks"][name]``.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import TYPE_CHECKING

from vtkmodules.vtkCommonCore import vtkInformation, vtkInformationStringKey
from vtkmodules.vtkCommonExecutionModel import vtkAlgorithm
from vtkmodules.vtkRenderingCore import vtkProp

if TYPE_CHECKING:
    from vtkmodules.vtkCommonCore import vtkObject, vtkObjectBase

# vtkInformation compares keys by identity, so each name gets exactly one key
# object for the life of the process.
_KEYS: dict[str, vtkInformationStringKey] = {}


def _key(name: str) -> vtkInformationStringKey:
    key = _KEYS.get(name)
    if key is None:
        key = vtkInformationStringKey.MakeKey(f"trame_block_{name}", "trame_vtklocal")
        _KEYS[name] = key
    return key


def _information(vtk_object: vtkObjectBase, create: bool) -> vtkInformation | None:
    if isinstance(vtk_object, vtkAlgorithm):
        algorithm_information: vtkInformation = vtk_object.GetInformation()
        return algorithm_information
    if isinstance(vtk_object, vtkProp):
        information: vtkInformation | None = vtk_object.GetPropertyKeys()
        if information is None and create:
            information = vtkInformation()
            vtk_object.SetPropertyKeys(information)
        return information
    raise TypeError(f"{vtk_object.GetClassName()} cannot carry a feature block")


def get_block(vtk_object: vtkObjectBase | None, name: str) -> dict[str, object] | None:
    """The named block on ``vtk_object``, or None when it carries none."""
    if vtk_object is None:
        return None
    information = _information(vtk_object, create=False)
    key = _key(name)
    if information is None or not information.Has(key):
        return None
    block: object = json.loads(key.Get(information))
    if not isinstance(block, dict):
        raise RuntimeError(f"feature block {name!r} is not a JSON object")
    return block


def set_block(
    vtk_object: vtkObject, name: str, block: Mapping[str, object] | None
) -> bool:
    """Store (or, with None, remove) one block; True when it changed.

    Only a change bumps the object's MTime, so callers may re-apply the same
    block on every update without forcing a re-serialization.
    """
    information = _information(vtk_object, create=block is not None)
    key = _key(name)
    has_block = information is not None and information.Has(key)
    if information is None or (block is None and not has_block):
        return False
    if block is None:
        information.Remove(key)
    else:
        encoded = json.dumps(block, sort_keys=True)
        if has_block and key.Get(information) == encoded:
            return False
        key.Set(information, encoded)
    vtk_object.Modified()
    return True
