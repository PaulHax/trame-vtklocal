"""JS-oracle self-test: drop a published message, assert the oracle catches.

The oracle's value is "the comparator catches client-side divergences before
they ship." This test deliberately drops the next outgoing message via the
test-app protocol wrapper (suppress_next_publish). The server-side state
advances to post-mutation, but the client never sees the message and stays
at pre-mutation — so the comparator must raise :class:`JsOracleMismatch`
with the affected first_difference describing the diverged property.

Equivalent in spirit to the plan's "broken applyPatchUpdate" wrapper: if
the comparator stops detecting deliberate divergences, this test fails
and the e2e oracle has lost its primary contract.
"""

from __future__ import annotations

import pytest

from tests.push_oracle_e2e.runner import JsOracle, JsOracleMismatch


pytestmark = pytest.mark.js_oracle


def _run_drop_message(oracle: JsOracle):
    oracle.reset("basic")
    # Run one step normally to warm dirty tracking so the server emits a
    # patch on the next update (rather than a full-state fallback).
    oracle.run_step("hide-actor", publish="update")
    oracle.compare(step_name="hide-actor")

    # Now drop the next outgoing message for this client. The server will
    # advance the actor's pickable=False, but the client never sees the
    # patch and remains at pickable=True. The comparator must catch.
    oracle.suppress_next_publish(count=1)
    oracle.run_step("set-pickable", publish="update", wait=False)

    # The server's seq advanced; the client's lastSeq stays behind. Hand
    # the comparison to the comparator path so we exercise its exception
    # construction; expect JsOracleMismatch.
    with pytest.raises(JsOracleMismatch) as excinfo:
        oracle.compare(step_name="set-pickable")
    err = excinfo.value
    assert err.scene == "basic"
    assert err.step == "set-pickable"
    assert err.report.get("first_difference"), "first_difference must be set"


def test_self_test_dropped_patch_local(oracle_local: JsOracle):
    _run_drop_message(oracle_local)


def test_self_test_dropped_patch_shared(oracle_shared: JsOracle):
    _run_drop_message(oracle_shared)
