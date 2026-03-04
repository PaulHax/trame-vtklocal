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


def test_partial_flush_sends_no_delta(server, server_path, page: Page):
    """flush() sends only partial array updates, no delta state."""
    url = f"http://127.0.0.1:{server.port}/"
    page.goto(url)
    wait_for_ready(page)

    page.evaluate("window.testDisableAutoRender()")
    queue_before = page.evaluate("window.testGetDeltaQueueLength()")
    page.evaluate("window.trame.trigger('partial_move')")
    time.sleep(1)

    queue_after = page.evaluate("window.testGetDeltaQueueLength()")
    assert queue_after == queue_before, (
        f"flush() should not enqueue a delta (before={queue_before}, after={queue_after})"
    )


def test_update_after_mark_modified_has_inlined_arrays(server, server_path, page: Page):
    """update() after mark_modified() must send inlined arrays (no synchronizeSync error)."""
    url = f"http://127.0.0.1:{server.port}/"
    page.goto(url)
    wait_for_ready(page)

    page.evaluate("window.trame.trigger('mark_then_update')")
    time.sleep(1)

    errors = page.evaluate("""() => {
        return (window.__consoleErrors || []).filter(
            m => m.includes('synchronizeSync') || m.includes('inline')
        );
    }""")
    assert len(errors) == 0, f"Expected no synchronizeSync errors, got: {errors}"

    queue_len = page.evaluate("window.testGetDeltaQueueLength()")
    assert queue_len == 0, (
        f"Delta queue should be drained after update(), but has {queue_len} items"
    )
