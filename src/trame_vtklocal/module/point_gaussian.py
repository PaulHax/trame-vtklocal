"""Supported VTK PointGaussianMapper contract for the browser backend."""

from vtkmodules.vtkRenderingCore import vtkPointGaussianMapper


def validate_simple_points(mapper: vtkPointGaussianMapper) -> None:
    """Reject Gaussian requests before unsupported settings leave the server."""
    if mapper.GetScaleFactor() != 0:
        raise ValueError(
            "vtkPointGaussianMapper supports only simple points in vtk.js; "
            "call SetScaleFactor(0). Gaussian splats are not implemented."
        )
    unsupported = [
        name
        for name in (
            "Anisotropic",
            "ScaleArray",
            "OpacityArray",
            "RotationArray",
            "ScaleFunction",
            "ScalarOpacityFunction",
            "SplatShaderCode",
        )
        if getattr(mapper, f"Get{name}")()
    ]
    if unsupported:
        raise ValueError(
            "vtkPointGaussianMapper Gaussian settings are unsupported in vtk.js: "
            + ", ".join(unsupported)
        )
