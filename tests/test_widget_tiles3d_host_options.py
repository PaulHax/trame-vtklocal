import pytest
from trame.app import get_server
from vtkmodules.vtkRenderingCore import vtkRenderer, vtkRenderWindow

from trame_vtklocal.widgets import VtkJsLocalView, VtkJsSharedView


def _render_window():
    render_window = vtkRenderWindow()
    render_window.SetOffScreenRendering(1)
    render_window.AddRenderer(vtkRenderer())
    return render_window


@pytest.mark.parametrize("view_type", [VtkJsLocalView, VtkJsSharedView])
def test_vtkjs_views_declare_tiles3d_host_policy_defaults(view_type):
    server = get_server(
        f"widget-tiles3d-policy-default-{view_type.__name__}", client_type="vue3"
    )
    view = view_type(_render_window(), trame_server=server)
    try:
        assert view._attributes["tiles3d_texture_policy"] == (
            'tiles3d-texture-policy="auto"'
        )
        assert view._attributes["tiles3d_quality_policy"] == (
            'tiles3d-quality-policy="adaptive"'
        )
    finally:
        view.cleanup()


@pytest.mark.parametrize("view_type", [VtkJsLocalView, VtkJsSharedView])
def test_vtkjs_views_forward_explicit_tiles3d_host_policies(view_type):
    server = get_server(
        f"widget-tiles3d-policy-explicit-{view_type.__name__}", client_type="vue3"
    )
    view = view_type(
        _render_window(),
        tiles3d_texture_policy="rgba",
        tiles3d_quality_policy="fixed",
        trame_server=server,
    )
    try:
        assert view._attributes["tiles3d_texture_policy"] == (
            'tiles3d-texture-policy="rgba"'
        )
        assert view._attributes["tiles3d_quality_policy"] == (
            'tiles3d-quality-policy="fixed"'
        )
    finally:
        view.cleanup()


@pytest.mark.parametrize(
    ("keyword", "value"),
    [
        ("tiles3d_texture_policy", "compressed"),
        ("tiles3d_quality_policy", "manual"),
    ],
)
def test_vtkjs_views_reject_unknown_tiles3d_host_policies(keyword, value):
    server = get_server(f"widget-tiles3d-policy-invalid-{keyword}", client_type="vue3")
    with pytest.raises(ValueError, match=keyword):
        VtkJsLocalView(_render_window(), **{keyword: value}, trame_server=server)
