"""Tests for shared GL context rendering — sync state at render time.

With syncStateAtRender: true, queued state must be applied within
renderShared() so it takes effect in the same render frame.
Without applyQueuedStateSync() in renderShared(), state stays in the
queue and VTK renders the old scene.

Run with --headed (VTK.js WebGL needs a GPU context):
    pytest tests/test_shared_gl_context.py -v -s --headed
"""

import time

from playwright.sync_api import Page, expect
import pytest


@pytest.fixture
def server_path():
    return "examples/tests/rendering/shared_gl.py"


def wait_for_ready(page: Page):
    page.set_viewport_size({"width": 600, "height": 300})
    expect(page.locator(".readyCount")).not_to_have_text("0", timeout=15000)


def test_shared_common_scene_api(server, server_path, page: Page):
    url = f"http://127.0.0.1:{server.port}/"
    page.goto(url)
    wait_for_ready(page)

    result = page.evaluate("window.testCommonSceneApi()")
    assert result["ready"], "Shared view should be initialized before API inspection"
    assert result["missing"] == [], f"Missing common scene methods: {result['missing']}"
    assert result["hasRenderer"], "Shared view should expose getRenderer()"
    assert result["cameraChanged"], "setCamera() should update the shared renderer camera"
    assert result["cameraReset"], "resetCamera() should restore the shared renderer camera"
    assert result["idleQueueDrained"], (
        "applyQueuedStateSync() should return false when the queue is empty"
    )


def test_render_shared_drains_sync_queue(server, server_path, page: Page):
    """renderShared() must drain the sync queue synchronously when
    syncStateAtRender is true."""
    url = f"http://127.0.0.1:{server.port}/"
    page.goto(url)
    wait_for_ready(page)

    page.evaluate("window.testDisableAutoRender()")
    page.evaluate("window.trame.trigger('change_color')")
    time.sleep(1)

    drained = page.evaluate("window.testRenderSharedDrainsQueue()")
    assert drained, "renderShared() should drain the sync queue synchronously"


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


def test_partial_flush_sends_no_delta(server, server_path, page: Page):
    """flush() sends only partial array updates, no delta state."""
    url = f"http://127.0.0.1:{server.port}/"
    page.goto(url)
    wait_for_ready(page)

    page.evaluate("window.testDisableAutoRender()")
    # Drain any queued resync/update state so the baseline reflects only what
    # partial_move() itself contributes.
    page.evaluate("window.testRenderSharedDrainsQueue()")
    queue_before = page.evaluate("window.testGetDeltaQueueLength()")
    page.evaluate("window.trame.trigger('partial_move')")
    time.sleep(1)

    queue_after = page.evaluate("window.testGetDeltaQueueLength()")
    assert queue_after == queue_before, (
        f"flush() should not enqueue a delta (before={queue_before}, after={queue_after})"
    )


def test_update_after_mark_modified_prefetches_missing_arrays(
    server, server_path, page: Page
):
    """update() after mark_modified() must prefetch missing arrays before sync apply."""
    url = f"http://127.0.0.1:{server.port}/"
    page.goto(url)
    wait_for_ready(page)

    page.evaluate("window.trame.trigger('mark_then_update')")
    time.sleep(1)

    errors = page.evaluate("""() => {
        return (window.__consoleErrors || []).filter(
            m => m.includes('synchronizeSync') || m.includes('inline') || m.includes('prefetch')
        );
    }""")
    assert len(errors) == 0, f"Expected no synchronizeSync/prefetch errors, got: {errors}"

    queue_len = page.evaluate("window.testGetDeltaQueueLength()")
    assert queue_len == 0, (
        f"Delta queue should be drained after update(), but has {queue_len} items"
    )
