"""Playwright-side runner for the push-sync v2 end-to-end oracle.

Wraps a single ``Page`` against a single trame app (started via xprocess) and
exposes a high-level ``JsOracle`` that the test matrix calls. ``compare()``
flows the JS dump and the server shadow through
``tests/push_oracle/normalize.py`` and raises :class:`JsOracleMismatch` with
the first differing path, the client's seq cursor, and the last applied op
when divergence is detected.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from playwright.sync_api import Page

from tests.push_oracle.normalize import (
    first_difference,
    normalize_client_dump,
    normalize_server_shadow,
)


WAIT_FOR_SEQ_TIMEOUT_MS = 5000
READY_TIMEOUT_MS = 15000


class JsOracleMismatch(AssertionError):
    """Raised when a step's JS dump diverges from the server shadow."""

    def __init__(self, *, view, scene, step, report):
        self.view = view
        self.scene = scene
        self.step = step
        self.report = report
        super().__init__(self._format())

    def _format(self):
        lines = [
            f"JsOracleMismatch on view={self.view!r} "
            f"scene={self.scene!r} step={self.step!r}:"
        ]
        for key, value in self.report.items():
            lines.append(f"  {key}: {value}")
        return "\n".join(lines)


def _decode_b64_bytes(payload):
    """Inverse of ``app._b64`` — convert ``{__b64__: "..."}`` back to bytes."""
    import base64

    if isinstance(payload, dict):
        if (
            "__b64__" in payload
            and len(payload) == 1
            and isinstance(payload["__b64__"], str)
        ):
            return base64.b64decode(payload["__b64__"])
        return {k: _decode_b64_bytes(v) for k, v in payload.items()}
    if isinstance(payload, list):
        return [_decode_b64_bytes(v) for v in payload]
    return payload


@dataclass
class JsOracle:
    page: Page
    view: str
    base_url: str

    rw_id: int = 0
    current_scene: str | None = None

    # ------------------------------------------------------------------
    # Page lifecycle
    # ------------------------------------------------------------------

    def open(self):
        self.page.goto(self.base_url)
        self.wait_ready()
        return self

    def wait_ready(self):
        self.page.wait_for_function(
            "() => !!window.__pushOracle__ && window.__pushOracle__.isReady()",
            timeout=READY_TIMEOUT_MS,
        )

    # ------------------------------------------------------------------
    # Trigger plumbing
    # ------------------------------------------------------------------

    def trigger(self, name: str, *args) -> Any:
        # ``window.trame.trigger`` returns a Promise resolving to the trigger's
        # return value; awaiting in-page keeps this synchronous from the
        # pytest runner's perspective.
        return self.page.evaluate(
            "([name, args]) => window.trame.trigger(name, args)",
            [name, list(args)],
        )

    def diagnostics(self) -> dict:
        return self.page.evaluate("() => window.__pushOracle__.diagnostics()")

    def console_messages(self) -> dict:
        return self.page.evaluate("() => window.__pushOracleConsole__ || {}")

    def wait_for_seq(self, target: int, *, timeout_ms: int | None = None):
        self.page.evaluate(
            "([target, timeout]) => window.__pushOracle__.waitForSeq(target, timeout)",
            [int(target), int(timeout_ms or WAIT_FOR_SEQ_TIMEOUT_MS)],
        )

    # ------------------------------------------------------------------
    # Oracle operations
    # ------------------------------------------------------------------

    def reset(self, scene_name: str) -> dict:
        # Server-side: clear + populate the chosen scene and publish it. Then
        # reload the page so the browser client starts from a fresh resync
        # against the new scene rather than a cross-scene incremental diff.
        result = self.trigger("oracle.reset", scene_name)
        self.rw_id = result["rw_id"]
        self.current_scene = scene_name
        if result.get("needs_reload"):
            self.page.reload()
            self.wait_ready()
        baseline = result.get("baseline_seq", 0)
        if baseline:
            self.wait_for_seq(baseline)
        return result

    def run_step(self, step_name: str, *, wait: bool = True) -> dict:
        result = self.trigger("oracle.run_step", step_name)
        if wait:
            self.wait_for_seq(result["seq"])
        return result

    def dump(self) -> dict:
        return self.page.evaluate(
            "([rwId]) => window.__pushOracle__.dump(rwId)",
            [str(self.rw_id)],
        )

    def shadow(self) -> dict:
        encoded = self.trigger("oracle.shadow")
        return _decode_b64_bytes(encoded)

    def compare(self, *, step_name: str) -> None:
        js_dump = self.dump()
        server_shadow = self.shadow()
        if js_dump is None:
            raise JsOracleMismatch(
                view=self.view,
                scene=self.current_scene,
                step=step_name,
                report={"actual": "JS dump returned None"},
            )

        js_normalized = normalize_client_dump(js_dump)
        server_normalized = normalize_server_shadow(server_shadow)

        if js_normalized != server_normalized:
            diag = self.diagnostics() or {}
            diff = first_difference(js_normalized, server_normalized)
            raise JsOracleMismatch(
                view=self.view,
                scene=self.current_scene,
                step=step_name,
                report={
                    "client_seq": diag.get("mySeq"),
                    "server_seq": server_shadow.get("seq"),
                    "last_applied_op": diag.get("lastAppliedOp"),
                    "first_difference": diff,
                    "console_errors": (self.console_messages() or {}).get("errors", []),
                },
            )

    # ------------------------------------------------------------------
    # Recovery-path helpers
    # ------------------------------------------------------------------

    def request_resync(self, *, wait: bool = True):
        result = self.trigger("oracle.request_resync")
        if wait:
            baseline = result.get("baseline_seq", 0)
            if baseline:
                self.wait_for_seq(baseline)
        return result

    def suppress_next_publish(self, count: int = 1):
        return self.trigger("oracle.suppress_next_publish", int(count))
