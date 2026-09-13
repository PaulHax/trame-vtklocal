"""Feature blocks stored on the VTK object they describe.

Every block on an object lives in one JSON object, keyed by block name, under a
string key in the object's own ``vtkInformation``: ``GetInformation()`` for an
algorithm (every mapper), and ``GetPropertyKeys()`` for a prop. The blocks live
and die with the C++ object, so they survive Python wrapper churn without a
registry, and the translator reads them back into ``node["blocks"][name]``.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import TYPE_CHECKING

from vtkmodules.vtkCommonCore import vtkInformation, vtkInformationStringKey
from vtkmodules.vtkCommonDataModel import vtkCompositeDataSet
from vtkmodules.vtkCommonExecutionModel import vtkAlgorithm
from vtkmodules.vtkRenderingCore import vtkProp

if TYPE_CHECKING:
    from vtkmodules.vtkCommonCore import vtkObject, vtkObjectBase

# A key created from Python (vtkInformationStringKey.MakeKey) crashes VTK's
# static key manager when the process exits, so the blocks ride a key VTK
# defines. Nothing in VTK reads NAME from an algorithm's
# information or a prop's keys.
_BLOCKS_KEY: vtkInformationStringKey = vtkCompositeDataSet.NAME()


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


def _blocks(information: vtkInformation | None) -> dict[str, dict[str, object]]:
    if information is None or not information.Has(_BLOCKS_KEY):
        return {}
    blocks: object = json.loads(_BLOCKS_KEY.Get(information))
    if not isinstance(blocks, dict) or not all(
        isinstance(block, dict) for block in blocks.values()
    ):
        raise RuntimeError("feature blocks are not a JSON object of objects")
    return blocks


def get_block(vtk_object: vtkObjectBase | None, name: str) -> dict[str, object] | None:
    """The named block on ``vtk_object``, or None when it carries none."""
    if vtk_object is None:
        return None
    return _blocks(_information(vtk_object, create=False)).get(name)


def set_block(
    vtk_object: vtkObject, name: str, block: Mapping[str, object] | None
) -> bool:
    """Store (or, with None, remove) one block; True when it changed.

    Only a change bumps the object's MTime, so callers may re-apply the same
    block on every update without forcing a re-serialization.
    """
    information = _information(vtk_object, create=block is not None)
    if information is None:
        return False
    blocks = _blocks(information)
    if block is None:
        if blocks.pop(name, None) is None:
            return False
    else:
        # Compared encoded, so a block equal to the stored one after the JSON
        # round trip (tuples read back as lists) is not a change.
        encoded = json.dumps(block, sort_keys=True)
        if name in blocks and json.dumps(blocks[name], sort_keys=True) == encoded:
            return False
        blocks[name] = json.loads(encoded)
    if blocks:
        _BLOCKS_KEY.Set(information, json.dumps(blocks, sort_keys=True))
    else:
        information.Remove(_BLOCKS_KEY)
    vtk_object.Modified()
    return True
