"""Shared GL context e2e — push sync v2 through the real client engine.

Drives the production stack end to end (real wslink broadcasts, real
mirror-store client engine) against a shared-GL VtkJsSharedView:

- scene ops applied on arrival (a server-side SetColor reaches the live
  vtk.js property instance in the same session),
- in-place point moves ride the automatic ``patchArray`` region path,
- the common scene API surface stays intact,
- ``getRenderer()`` degrades gracefully on broken renderer collections.

The correctness suite runs headlessly by default:
    pytest tests/test_shared_gl_context.py -v -s --browser chromium

For an explicit hardware-renderer or performance qualification, add --headed
and verify WEBGL_debug_renderer_info is not a software renderer.
"""

import base64
import struct

from playwright.sync_api import Page, expect
import pytest


@pytest.fixture
def server_path():
    return "examples/tests/rendering/shared_gl.py"


def wait_for_ready(page: Page):
    page.set_viewport_size({"width": 600, "height": 300})
    expect(page.locator(".readyCount")).not_to_have_text("0", timeout=15000)


def trigger_and_wait(page: Page, name: str):
    """Fire a server trigger returning ``{"seq"}`` and wait for the client
    engine's cursor to reach it."""
    result = page.evaluate(
        "([name]) => window.trame.trigger(name, [])", [name]
    )
    seq = result["seq"]
    page.evaluate("([seq]) => window.testWaitForSeq(seq, 5000)", [seq])
    return seq


def test_shared_common_scene_api(server, server_path, page: Page):
    url = f"http://127.0.0.1:{server.port}/"
    page.goto(url)
    wait_for_ready(page)

    result = page.evaluate("window.testCommonSceneApi()")
    assert result["ready"], "Shared view should be initialized before API inspection"
    assert result["missing"] == [], f"Missing common scene methods: {result['missing']}"
    assert result["hasRenderer"], "Shared view should expose getRenderer()"
    assert result["cameraChanged"], (
        "setCamera() should update the shared renderer camera"
    )
    assert result["cameraReset"], (
        "resetCamera() should restore the shared renderer camera"
    )


def test_scene_ops_apply_on_arrival(server, server_path, page: Page):
    """A server-side property mutation must reach the live vtk.js instance
    through the scene.ops broadcast path, without any client-side pull."""
    url = f"http://127.0.0.1:{server.port}/"
    page.goto(url)
    wait_for_ready(page)

    before = page.evaluate("window.testGetAppliedPropertyColors()")
    assert before, "applied scene should carry at least one vtkProperty node"

    trigger_and_wait(page, "change_color")

    colors = page.evaluate("window.testGetAppliedPropertyColors()")
    greens = [
        entry
        for entry in colors
        if entry.get("diffuseColor") == [0, 1, 0] or entry.get("color") == [0, 1, 0]
    ]
    assert greens, f"SetColor(0,1,0) never reached the client: {colors}"

    diag = page.evaluate("window.testGetDiagnostics()")
    assert diag["live"], "engine should be live after applying ops"
    assert diag["lastAppliedOp"]["kind"] == "upsert", diag["lastAppliedOp"]

    errors = page.evaluate("window.__consoleErrors || []")
    assert not errors, f"console errors during scene-ops apply: {errors}"


def test_point_nudge_rides_patch_array(server, server_path, page: Page):
    """The second in-place point move must arrive as a patchArray region op
    (the first pays the full send that starts hot-array retention), and the
    patched bytes must land in the bound vtk.js points array."""
    url = f"http://127.0.0.1:{server.port}/"
    page.goto(url)
    wait_for_ready(page)

    trigger_and_wait(page, "nudge_point")
    first = page.evaluate("window.testGetAppliedPointsContent()")

    trigger_and_wait(page, "nudge_point")
    diag = page.evaluate("window.testGetDiagnostics()")
    assert diag["lastAppliedOp"]["kind"] == "patchArray", diag["lastAppliedOp"]

    second = page.evaluate("window.testGetAppliedPointsContent()")
    assert first and second, "applied scene should expose points content"
    before = struct.unpack("<f", base64.b64decode(first[0])[:4])[0]
    after = struct.unpack("<f", base64.b64decode(second[0])[:4])[0]
    assert after == pytest.approx(before + 0.1, abs=1e-5), (
        f"patched x should move by +0.1 (before={before}, after={after})"
    )

    errors = page.evaluate("window.__consoleErrors || []")
    assert not errors, f"console errors during patchArray apply: {errors}"


def test_get_renderer_handles_broken_renderer_collection(
    server, server_path, page: Page
):
    """getRenderer() should return null instead of throwing on transient renderer lookup failure."""
    url = f"http://127.0.0.1:{server.port}/"
    page.goto(url)
    wait_for_ready(page)

    result = page.evaluate("window.testGetRendererHandlesBrokenRendererCollection()")
    assert result["ready"], "Shared view should be initialized before the check"
    assert not result["threw"], (
        "getRenderer() should not throw when getRenderers() fails transiently "
        f"(message={result.get('message')})"
    )
    assert result["value"] is None, (
        "getRenderer() should degrade to null when the renderer collection "
        "is transiently unavailable"
    )


def test_get_renderer_ignores_null_renderer_entries(server, server_path, page: Page):
    """getRenderer() should skip dead/null renderer entries instead of throwing."""
    url = f"http://127.0.0.1:{server.port}/"
    page.goto(url)
    wait_for_ready(page)

    result = page.evaluate("window.testGetRendererIgnoresNullRendererEntries()")
    assert result["ready"], "Shared view should be initialized before the check"
    assert not result["threw"], (
        "getRenderer() should skip null renderer entries instead of throwing "
        f"(message={result.get('message')})"
    )
    assert result["sameRenderer"], (
        "getRenderer() should preserve the live renderer when null entries "
        "are present in the render window"
    )
