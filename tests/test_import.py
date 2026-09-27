def test_import():
    from trame_vtklocal.widgets import VtkJsSharedView

    # For components only, the CustomWidget is also importable via trame
    from trame.widgets.vtklocal import VtkJsSharedView  # noqa: F401,F811
