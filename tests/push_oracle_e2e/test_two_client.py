"""Two-client coverage: one trame app, two browser contexts, one render window.

The matrix proves single-client convergence. In v2 the server keeps no
per-client state at all — one broadcast fans out to every client — so the
interesting multi-client property is exactly that: both clients apply the
same ``scene.ops`` message and converge to the same server store.
"""

from __future__ import annotations

from tests.push_oracle_e2e.runner import JsOracle

import pytest


pytestmark = pytest.mark.js_oracle


def _connect_pair(base_url, pages, view="local"):
    """Open client A (which performs the destructive reset+reload), then
    open client B against the now-stable scene state."""
    page_a, page_b = pages
    oracle_a = JsOracle(page=page_a, view=view, base_url=base_url).open()
    oracle_a.reset("basic")
    # Now connect B. The server is at the post-reset baseline; the new client
    # pulls a fresh snapshot via ``scene.resync`` and lands at the same seq
    # A is at.
    oracle_b = JsOracle(page=page_b, view=view, base_url=base_url).open()
    diag_a = oracle_a.diagnostics()
    oracle_b.wait_for_seq(diag_a["mySeq"])
    oracle_b.rw_id = oracle_a.rw_id
    oracle_b.current_scene = "basic"
    return oracle_a, oracle_b


def test_two_clients_converge_on_broadcast(oracle_local_pair):
    base_url, pages = oracle_local_pair
    oracle_a, oracle_b = _connect_pair(base_url, pages)

    # Mutation goes through A's trigger (server is single-render-window;
    # the broadcast reaches both clients).
    result = oracle_a.run_step("hide-actor")
    oracle_b.wait_for_seq(result["seq"])

    oracle_a.compare(step_name="hide-actor")
    oracle_b.compare(step_name="hide-actor")
