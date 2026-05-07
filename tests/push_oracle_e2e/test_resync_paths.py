"""Coverage for resync code paths beyond the per-step matrix.

The matrix proves the patch / arrayPartial dispatch path is correct. These
tests cover the *recovery* paths the production stack exercises when wire
state diverges:

- mid-stream server-initiated ``request_resync`` (no scene change)
- automatic gap recovery via ``createPushSync``'s ``gapResyncDelayMs`` timer
  when a patch is dropped on the wire
"""

from __future__ import annotations

import pytest

from tests.push_oracle_e2e.runner import JsOracle


pytestmark = pytest.mark.js_oracle


def _mid_stream_resync(oracle: JsOracle):
    oracle.reset("basic")
    oracle.run_step("hide-actor", publish="update")
    oracle.compare(step_name="hide-actor")

    # Server-initiated resync without dropping clients or changing the scene.
    # Existing client receives a fresh full state at a new seq and converges.
    oracle.request_resync()
    oracle.compare(step_name="<after-mid-stream-resync>")

    # Subsequent patches keep working after the resync.
    oracle.run_step("set-pickable", publish="update")
    oracle.compare(step_name="set-pickable")


def test_mid_stream_resync_local(oracle_local: JsOracle):
    _mid_stream_resync(oracle_local)


def test_mid_stream_resync_shared(oracle_shared: JsOracle):
    _mid_stream_resync(oracle_shared)


def _gap_recovery(oracle: JsOracle):
    """Drop one patch; the next patch is `blocked` on the client; the
    ``gapResyncDelayMs`` timer fires and the client auto-resyncs."""
    oracle.reset("basic")
    oracle.run_step("hide-actor", publish="update")
    oracle.compare(step_name="hide-actor")

    # Drop the next outgoing message (one patch). The patch after that will
    # have ``baseSeq`` referring to the dropped seq, so the client's
    # ``validateMessageEnvelope`` returns "blocked" and ``scheduleGapResync``
    # arms the recovery timer.
    oracle.suppress_next_publish(count=1)
    oracle.run_step("show-actor", publish="update", wait=False)
    next_result = oracle.run_step("set-pickable", publish="update", wait=False)

    # Wait for the production gap-resync timer (default 1000ms in
    # ``createPushSync``) plus headroom for the resync RPC round trip and
    # full-state apply. After recovery the client's ``lastSeq`` advances to
    # the server's authoritative seq.
    oracle.wait_for_seq(next_result["seq"], timeout_ms=4000)
    oracle.compare(step_name="set-pickable-after-gap-recovery")


def test_gap_recovery_local(oracle_local: JsOracle):
    _gap_recovery(oracle_local)


def test_gap_recovery_shared(oracle_shared: JsOracle):
    _gap_recovery(oracle_shared)
