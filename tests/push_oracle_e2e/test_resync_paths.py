"""Coverage for v2 resync code paths beyond the per-step matrix.

The matrix proves the broadcast apply path is correct. These tests cover the
*recovery* paths the production stack exercises when wire state diverges:

- mid-stream server-initiated ``request_resync`` (no scene change)
- automatic gap recovery: a dropped broadcast makes the next delivered
  message's ``baseSeq`` miss the client cursor, and the engine resyncs
  immediately (no timers in v2)
"""

from __future__ import annotations

import pytest

from tests.push_oracle_e2e.runner import JsOracle


pytestmark = pytest.mark.js_oracle


def _mid_stream_resync(oracle: JsOracle):
    oracle.reset("basic")
    oracle.run_step("hide-actor")
    oracle.compare(step_name="hide-actor")

    # Server-initiated resync without changing the scene: the broadcast's
    # baseSeq=-1 can match no cursor, so the existing client re-pulls the
    # snapshot at a fresh seq and converges.
    oracle.request_resync()
    oracle.compare(step_name="<after-mid-stream-resync>")

    # Subsequent ops keep working after the resync.
    oracle.run_step("set-pickable")
    oracle.compare(step_name="set-pickable")


def test_mid_stream_resync_local(oracle_local: JsOracle):
    _mid_stream_resync(oracle_local)


def test_mid_stream_resync_shared(oracle_shared: JsOracle):
    _mid_stream_resync(oracle_shared)


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
