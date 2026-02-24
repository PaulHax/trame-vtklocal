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
