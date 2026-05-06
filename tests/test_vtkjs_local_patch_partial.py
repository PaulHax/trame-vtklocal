import pytest
from playwright.sync_api import Page, expect


@pytest.fixture
def server_path():
    return "examples/tests/rendering/vtkjs_local_patch_partial.py"


def wait_for_ready(page: Page):
    page.set_viewport_size({"width": 600, "height": 300})
    expect(page.locator(".readyCount")).not_to_have_text("0", timeout=15000)
    page.wait_for_function("window.testFirstPoint && window.testFirstPoint() !== null")


def wait_for_first_point_x(page: Page, expected: float):
    page.wait_for_function(
        """(expected) => {
            const point = window.testFirstPoint?.();
            return point && Math.abs(point[0] - expected) < 1e-5;
        }""",
        arg=expected,
        timeout=15000,
    )


def assert_no_sync_recovery(page: Page):
    errors = page.evaluate(
        """() => {
            return (window.__consoleErrors || []).filter((message) => {
                return message.includes('hash mismatch')
                    || message.includes('Requesting full resync')
                    || message.includes('partial-old-hash-mismatch')
                    || message.includes('patch-apply-failed')
                    || message.includes('sequence gap');
            });
        }"""
    )
    assert errors == []


def test_vtkjs_local_patch_partial_patch_keeps_client_array_state(
    server, server_path, page: Page
):
    """Real local view keeps client array hashes/data coherent across patch and partial ops."""
    page.goto(f"http://127.0.0.1:{server.port}/")
    wait_for_ready(page)
    wait_for_first_point_x(page, 0.0)

    page.evaluate("window.__consoleErrors = []")

    page.evaluate("window.trame.trigger('patch_move')")
    wait_for_first_point_x(page, 0.2)

    page.evaluate("window.trame.trigger('partial_move')")
    wait_for_first_point_x(page, 0.4)

    page.evaluate("window.trame.trigger('patch_move_again')")
    wait_for_first_point_x(page, 0.6)

    page.evaluate("window.trame.trigger('partial_move_again')")
    wait_for_first_point_x(page, 0.8)

    assert page.evaluate("window.testGetDeltaQueueLength()") == 0
    assert_no_sync_recovery(page)
