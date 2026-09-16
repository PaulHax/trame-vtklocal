"""Live dependencies not fully represented in serialized VTK state."""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from typing import TYPE_CHECKING

from vtkmodules.vtkCommonExecutionModel import vtkAlgorithm

if TYPE_CHECKING:
    from vtkmodules.vtkCommonCore import vtkObject, vtkObjectBase


def _iter_via_getters(obj: object, names: Iterable[str]) -> Iterator[vtkObject]:
    """Yield each non-None result of calling obj.<name>() for each name."""
    if obj is None:
        return
    for getter in names:
        get = getattr(obj, getter, None)
        if get is None:
            continue
        result = get()
        if result is not None:
            yield result


def _iter_field_data_arrays(field_data: vtkObject | None) -> Iterator[vtkObject]:
    if field_data is None:
        return

    yield field_data

    get_count = getattr(field_data, "GetNumberOfArrays", None)
    get_array = getattr(field_data, "GetArray", None)
    if get_count is not None and get_array is not None:
        for index in range(get_count()):
            array = get_array(index)
            if array is not None:
                yield array

    yield from _iter_via_getters(
        field_data, ("GetScalars", "GetTCoords", "GetNormals", "GetVectors")
    )


def _iter_cell_array_children(cell_array: vtkObject | None) -> Iterator[vtkObject]:
    if cell_array is None:
        return

    yield cell_array
    # Not GetData(): it copies the whole connectivity per call, never a dependency.
    getters = ("GetConnectivityArray", "GetOffsetsArray")
    yield from _iter_via_getters(cell_array, getters)


def dataset_children(dataset: vtkObjectBase | None) -> Iterator[vtkObject]:
    if dataset is None:
        return

    points = dataset.GetPoints() if hasattr(dataset, "GetPoints") else None
    if points is not None:
        yield points
        data = points.GetData() if hasattr(points, "GetData") else None
        if data is not None:
            yield data

    for cell_array in _iter_via_getters(
        dataset, ("GetVerts", "GetLines", "GetPolys", "GetStrips")
    ):
        yield from _iter_cell_array_children(cell_array)

    for field_data in _iter_via_getters(
        dataset, ("GetPointData", "GetCellData", "GetFieldData")
    ):
        yield from _iter_field_data_arrays(field_data)


def owned_collections(vtk_obj: vtkObjectBase | None) -> Iterator[vtkObject]:
    """Structural collections owned by a node-worthy object.

    ``AddActor``/``RemoveActor``/``AddRenderer`` fire ``ModifiedEvent`` on the
    collection only — never on the renderer or window — so structural changes
    are observed on the collection and attributed back to its owner node.
    """
    if vtk_obj is None or not hasattr(vtk_obj, "IsA"):
        return
    if vtk_obj.IsA("vtkRenderWindow"):
        yield from _iter_via_getters(vtk_obj, ("GetRenderers",))
    elif vtk_obj.IsA("vtkRenderer"):
        yield from _iter_via_getters(vtk_obj, ("GetViewProps", "GetLights"))


def pipeline_producers(mapper: vtkAlgorithm) -> Iterator[vtkAlgorithm]:
    """Every upstream producer, once, including reconnection intermediates."""
    seen = {id(mapper)}
    pending = [mapper]
    while pending:
        current = pending.pop()
        for port in range(current.GetNumberOfInputPorts()):
            for index in range(current.GetNumberOfInputConnections(port)):
                connection = current.GetInputConnection(port, index)
                producer = connection.GetProducer() if connection else None
                if producer is not None and id(producer) not in seen:
                    seen.add(id(producer))
                    yield producer
                    pending.append(producer)


def transform_children(actor: vtkObjectBase) -> Iterator[vtkObject]:
    """Matrices and transforms flattened into actor userMatrix."""
    pending = list(
        _iter_via_getters(actor, ("GetUserMatrix", "GetUserTransform", "GetTransform"))
    )
    seen: set[int] = set()
    while pending:
        child = pending.pop()
        if id(child) in seen:
            continue
        seen.add(id(child))
        yield child
        pending.extend(_iter_via_getters(child, ("GetInput", "GetMatrix")))
