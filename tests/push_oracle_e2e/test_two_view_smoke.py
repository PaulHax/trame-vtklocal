"""Two-view smoke: VtkJsShared + VtkJsLocal sharing one wslink client.

The matrix proves push-sync correctness per view; this smoke proves the two
views co-exist without cross-view interference. Each step mutates only one
view's render window and asserts:

- the mutated view's JS dump matches its own server store,
- the *other* view's JS dump still matches its own server store (no
  cross-view sync collateral).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest
from playwright.sync_api import Page
from trame_client.utils.testing import FixtureHelper

from tests.push_oracle.normalize import (
    first_difference,
    normalize_client_dump,
    normalize_server_shadow,
)
from tests.push_oracle_e2e.runner import (
    JsOracleMismatch,
    READY_TIMEOUT_MS,
    WAIT_FOR_SEQ_TIMEOUT_MS,
    _decode_b64_bytes,
)


pytestmark = pytest.mark.js_oracle


ROOT_PATH = Path(__file__).resolve().parents[2]
HELPER = FixtureHelper(ROOT_PATH)
VIEWS = ("shared", "local")
REF_NAMES = {"shared": "vtkView", "local": "vtkViewLocal"}


@pytest.fixture(scope="module")
def two_view_app(xprocess):
    name, Starter, Monitor = HELPER.get_xprocess_args(
        "tests/push_oracle_e2e/two_view_app.py"
    )
    logfile = xprocess.ensure(name, Starter)
    yield Monitor(logfile[1])
    xprocess.getinfo(name).terminate()


@dataclass
class TwoViewClient:
    page: Page
    base_url: str
    rw_ids: dict[str, int]

    def trigger(self, name: str, *args):
        return self.page.evaluate(
            "([name, args]) => window.trame.trigger(name, args)",
            [name, list(args)],
        )

    def wait_ready(self):
        for ref in REF_NAMES.values():
            self.page.wait_for_function(
                "(refName) => !!window.__pushOracle__ "
                "&& window.__pushOracle__.isReady(refName)",
                arg=ref,
                timeout=READY_TIMEOUT_MS,
            )

    def wait_for_seq(self, view: str, target: int):
        self.page.evaluate(
            "([target, timeout, ref]) => window.__pushOracle__.waitForSeq(target, timeout, ref)",
            [int(target), WAIT_FOR_SEQ_TIMEOUT_MS, REF_NAMES[view]],
        )

    def reset(self, view: str, scene: str):
        result = self.trigger("oracle.reset", view, scene)
        self.rw_ids[view] = result["rw_id"]
        return result

    def run_step(self, view: str, step: str):
        result = self.trigger("oracle.run_step", view, step)
        self.wait_for_seq(view, result["seq"])
        return result

    def dump(self, view: str):
        return self.page.evaluate(
            "([rwId, ref]) => window.__pushOracle__.dump(rwId, ref)",
            [str(self.rw_ids[view]), REF_NAMES[view]],
        )

    def shadow(self, view: str):
        return _decode_b64_bytes(self.trigger("oracle.shadow", view))

    def compare(self, view: str, scene: str, step: str):
        js_dump = self.dump(view)
        srv_shadow = self.shadow(view)
        if js_dump is None:
            raise JsOracleMismatch(
                view=view, scene=scene, step=step,
                report={"actual": "JS dump returned None"},
            )
        js_norm = normalize_client_dump(js_dump)
        sh_norm = normalize_server_shadow(srv_shadow)
        if js_norm != sh_norm:
            raise JsOracleMismatch(
                view=view, scene=scene, step=step,
                report={
                    "first_difference": first_difference(js_norm, sh_norm),
                },
            )


@pytest.fixture
def two_view(two_view_app, page: Page) -> TwoViewClient:
    base_url = f"http://127.0.0.1:{two_view_app.port}/"
    page.goto(base_url)
    client = TwoViewClient(page=page, base_url=base_url, rw_ids={})
    client.wait_ready()
    return client


def test_two_view_smoke_basic(two_view: TwoViewClient):
    # Reset both views server-side, then reload to produce a fresh client
    # that resyncs against the now-prepared state on both views.
    reset_shared = two_view.reset("shared", "basic")
    reset_local = two_view.reset("local", "basic")
    two_view.page.reload()
    two_view.wait_ready()

    two_view.wait_for_seq("shared", reset_shared["baseline_seq"])
    two_view.wait_for_seq("local", reset_local["baseline_seq"])

    # Mutate only the shared view; the local view should remain unchanged
    # and its dump should still match its own store.
    two_view.run_step("shared", "hide-actor")
    two_view.compare("shared", "basic", "hide-actor")
    two_view.compare("local", "basic", "<no-step>")

    # Now mutate only the local view.
    two_view.run_step("local", "hide-actor")
    two_view.compare("local", "basic", "hide-actor")
    two_view.compare("shared", "basic", "<no-step-after-shared-hide>")
