"""JS-oracle self-test: drop a broadcast, assert the comparator catches.

The oracle's value is "the comparator catches client-side divergences before
they ship." This test deliberately drops the next outgoing ``scene.ops``
broadcast via the test-app protocol wrapper (suppress_next_publish). The
server store advances to post-mutation, but the client never sees the
message and stays at pre-mutation — so the comparator must raise
:class:`JsOracleMismatch` with a ``first_difference`` naming the diverged
path.

If the comparator stops detecting deliberate divergences, this test fails
and the e2e oracle has lost its primary contract.
"""

from __future__ import annotations

import pytest

from tests.push_oracle_e2e.runner import JsOracle, JsOracleMismatch


pytestmark = pytest.mark.js_oracle


def _run_drop_message(oracle: JsOracle):
    oracle.reset("basic")
    # Run one step normally to prove the pipe works before the drop.
    oracle.run_step("hide-actor")
    oracle.compare(step_name="hide-actor")

    # Now drop the next outgoing broadcast. The server advances the actor's
    # pickable=False, but the client never sees the op (and receives nothing
    # afterwards that would expose the seq gap), so it stays at pickable=True.
    oracle.suppress_next_publish(count=1)
    oracle.run_step("set-pickable", wait=False)

    # The server's seq advanced; the client's mySeq stays behind. Hand the
    # comparison to the comparator path so we exercise its exception
    # construction; expect JsOracleMismatch.
    with pytest.raises(JsOracleMismatch) as excinfo:
        oracle.compare(step_name="set-pickable")
    err = excinfo.value
    assert err.scene == "basic"
    assert err.step == "set-pickable"
    assert err.report.get("first_difference"), "first_difference must be set"


def test_self_test_dropped_broadcast_local(oracle_local: JsOracle):
    _run_drop_message(oracle_local)


def test_self_test_dropped_broadcast_shared(oracle_shared: JsOracle):
    _run_drop_message(oracle_shared)
