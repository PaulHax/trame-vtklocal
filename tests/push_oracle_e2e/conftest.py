"""Pytest fixtures for the push-sync end-to-end oracle.

Two trame test apps run in parallel via xprocess (one per view variant):

- ``e2e_app_shared`` mounts ``VtkJsSharedView`` with a canvas + WebGL2 context
- ``e2e_app_local`` mounts ``VtkJsLocalView`` with its own render window

Both expose the same ``oracle.*`` RPC triggers; tests parametrize ``view`` and
build a fresh :class:`JsOracle` per test using the corresponding fixture.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from playwright.sync_api import Page
from trame_client.utils.testing import FixtureHelper

from tests.push_oracle_e2e.runner import JsOracle


ROOT_PATH = Path(__file__).resolve().parents[2]
HELPER = FixtureHelper(ROOT_PATH)


def _start_app(xprocess, server_relative_path: str):
    name, Starter, Monitor = HELPER.get_xprocess_args(server_relative_path)
    logfile = xprocess.ensure(name, Starter)
    return name, Monitor(logfile[1])


@pytest.fixture(scope="module")
def e2e_app_shared(xprocess):
    name, monitor = _start_app(
        xprocess, "tests/push_oracle_e2e/app_shared.py"
    )
    yield monitor
    xprocess.getinfo(name).terminate()


@pytest.fixture(scope="module")
def e2e_app_local(xprocess):
    name, monitor = _start_app(
        xprocess, "tests/push_oracle_e2e/app_local.py"
    )
    yield monitor
    xprocess.getinfo(name).terminate()


def _build_oracle(monitor, view: str, page: Page) -> JsOracle:
    base_url = f"http://127.0.0.1:{monitor.port}/"
    oracle = JsOracle(page=page, view=view, base_url=base_url)
    return oracle.open()


@pytest.fixture
def oracle_shared(e2e_app_shared, page: Page) -> JsOracle:
    return _build_oracle(e2e_app_shared, "shared", page)


@pytest.fixture
def oracle_local_pair(e2e_app_local, browser):
    """Two independent ``JsOracle`` instances against one trame app.

    Each oracle has its own browser context — the trame app sees them as two
    distinct wslink clients receiving the same ``scene.ops`` broadcasts. Used
    for two-client convergence coverage.
    """
    base_url = f"http://127.0.0.1:{e2e_app_local.port}/"
    contexts = []
    pages = []
    for _ in range(2):
        ctx = browser.new_context()
        contexts.append(ctx)
        pages.append(ctx.new_page())
    try:
        yield base_url, pages
    finally:
        for ctx in contexts:
            ctx.close()


@pytest.fixture
def oracle_local(e2e_app_local, page: Page) -> JsOracle:
    return _build_oracle(e2e_app_local, "local", page)
