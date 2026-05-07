"""Two-client coverage: one trame app, two browser contexts, one render window.

The matrix proves single-client convergence. This module exercises per-client
ledger isolation that the matrix can't see by construction:

- both clients receive the same patch and converge to the same shadow,
- ``oracle.drop_client(A)`` stops publishing to A but B keeps receiving and
  stays in sync.
"""

from __future__ import annotations

import pytest

from tests.push_oracle_e2e.runner import JsOracle, JsOracleMismatch


pytestmark = pytest.mark.js_oracle


def _connect_pair(base_url, pages, view="local"):
    """Open client A (which performs the destructive reset+reload), then
    open client B against the now-stable scene state."""
    page_a, page_b = pages
    oracle_a = JsOracle(page=page_a, view=view, base_url=base_url).open()
    oracle_a.reset("basic")
    # Now connect B. The server is at the post-reset baseline; the new client
    # gets a fresh full state via ``vtkjs.push.resync`` and lands at the same
    # seq A is at.
    oracle_b = JsOracle(page=page_b, view=view, base_url=base_url).open()
    # Wait for B to apply the baseline full state.
    diag_a = oracle_a.diagnostics()
    oracle_b.wait_for_seq(diag_a["lastSeq"])
    oracle_b.rw_id = oracle_a.rw_id
    oracle_b.current_scene = "basic"
    return oracle_a, oracle_b


def test_two_clients_converge_on_patch(oracle_local_pair):
    base_url, pages = oracle_local_pair
    oracle_a, oracle_b = _connect_pair(base_url, pages)
    assert oracle_a.client_id != oracle_b.client_id, (
        "two contexts should have distinct wslink client ids"
    )

    # Mutation goes through A's trigger (server is single-render-window;
    # both clients receive the patch).
    result = oracle_a.run_step("hide-actor", publish="update")
    oracle_b.wait_for_seq(result["seq"])

    oracle_a.compare(step_name="hide-actor")
    oracle_b.compare(step_name="hide-actor")


def test_dropped_client_stops_receiving(oracle_local_pair):
    base_url, pages = oracle_local_pair
    oracle_a, oracle_b = _connect_pair(base_url, pages)

    # Drop A's per-client ledger on the server. B is unaffected.
    oracle_a.drop_client(oracle_a.client_id)

    # Mutate via A's trigger; server now publishes only to remaining clients
    # (B). A's vtk.js instances stay at pre-step state (no patch arrives).
    result = oracle_a.run_step("hide-actor", publish="update", wait=False)
    oracle_b.wait_for_seq(result["seq"])

    # B converged with the server.
    oracle_b.compare(step_name="hide-actor")

    # A diverges (its dump still reflects pre-step state) — the comparator
    # must catch it.
    with pytest.raises(JsOracleMismatch):
        oracle_a.compare(step_name="hide-actor-after-drop")
