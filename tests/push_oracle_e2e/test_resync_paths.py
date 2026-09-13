"""Coverage for the v2 resync recovery path beyond the per-step matrix.

The matrix proves the broadcast apply path is correct. These tests cover
automatic gap recovery: a dropped broadcast makes the next delivered message's
``baseSeq`` miss the client cursor, and the engine resyncs immediately (no
timers in v2).
"""

from __future__ import annotations

import pytest

from tests.push_oracle_e2e.runner import JsOracle


pytestmark = pytest.mark.js_oracle


def _gap_recovery(oracle: JsOracle):
    """Drop one broadcast; the next delivered message exposes the seq gap and
    the client resyncs to the authoritative state on the spot."""
    oracle.reset("basic")
    oracle.run_step("hide-actor")
    oracle.compare(step_name="hide-actor")

    # Drop the next outgoing broadcast. The message after that carries a
    # baseSeq the client cursor never reached, so the engine's consistency
    # rule lands on "resync" and re-pulls the snapshot.
    oracle.suppress_next_publish(count=1)
    oracle.run_step("show-actor", wait=False)
    next_result = oracle.run_step("set-pickable", wait=False)

    # Headroom covers the resync RPC round trip plus snapshot apply.
    oracle.wait_for_seq(next_result["seq"], timeout_ms=4000)
    oracle.compare(step_name="set-pickable-after-gap-recovery")


def test_gap_recovery_local(oracle_local: JsOracle):
    _gap_recovery(oracle_local)


def test_gap_recovery_shared(oracle_shared: JsOracle):
    _gap_recovery(oracle_shared)
