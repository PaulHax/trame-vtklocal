"""SceneStore unit + property tests (push sync v2, pure Python, no VTK).

The reference ``apply_ops`` here is the normative client behavior: a client
mirror that applies every broadcast op must equal ``store.snapshot()["nodes"]``
after every commit. The JS engine implements exactly this contract.
"""

from __future__ import annotations

import copy
import random

import pytest

from trame_vtklocal.store import SceneStore

RW = "1"


def apply_ops(mirror, ops):
    """Reference client-mirror applier."""
    for op in ops:
        if op["op"] == "upsert":
            mirror[op["id"]] = copy.deepcopy(op["node"])
        elif op["op"] == "remove":
            del mirror[op["id"]]
        elif op["op"] == "patchArray":
            node = mirror[op["id"]]
            arrays = dict(node["arrays"])
            arrays[op["key"]] = {**arrays[op["key"]], "ref": op["ref"]}
            mirror[op["id"]] = {**node, "arrays": arrays}
        else:  # pragma: no cover - protocol violation
            raise AssertionError(f"unknown op {op['op']!r}")
    return mirror


def basic_nodes():
    return {
        RW: {"type": "vtkRenderWindow", "props": {}, "refs": {"renderers": ["2"]}},
        "2": {
            "type": "vtkRenderer",
            "props": {"background": [0, 0, 0, 1]},
            "refs": {"viewProps": ["3"], "activeCamera": "6"},
        },
        "3": {
            "type": "vtkActor",
            "props": {"visibility": True},
            "refs": {"mapper": "4"},
        },
        "4": {
            "type": "vtkMapper",
            "props": {"scalarVisibility": False},
            "refs": {"input": "5"},
            "blocks": {"pickable": {"tags": {"rev": 1}, "ids": ["lm-1"]}},
        },
        "5": {
            "type": "vtkPolyData",
            "props": {},
            "arrays": {
                "points": {
                    "ref": "c:pts-hash-1",
                    "dataType": "Float32Array",
                    "size": 9,
                    "numberOfComponents": 3,
                },
                "verts": {"ref": "c2:conn-1:off-1", "dataType": "Uint32Array"},
            },
        },
        "6": {"type": "vtkCamera", "props": {"viewAngle": 30}},
    }


def committed_store(nodes=None):
    store = SceneStore(RW)
    result = store.transact().upsert_nodes(nodes or basic_nodes()).commit()
    return store, result


# ---------------------------------------------------------------------------
# Structural commits
# ---------------------------------------------------------------------------


def test_first_commit_upserts_full_graph_and_reports_entering_refs():
    store, result = committed_store()

    assert result["base_seq"] == 0
    assert result["seq"] == 1
    assert {op["op"] for op in result["ops"]} == {"upsert"}
    assert {op["id"] for op in result["ops"]} == set(basic_nodes())
    assert result["blob_refs_entering"] == {"c:pts-hash-1", "c2:conn-1:off-1"}
    assert result["refs_leaving"] == frozenset()
    assert store.snapshot()["nodes"] == basic_nodes()


def test_identical_reupsert_is_a_noop():
    store, _ = committed_store()

    result = store.transact().upsert_nodes(basic_nodes()).commit()

    assert result["ops"] == []
    assert result["base_seq"] == result["seq"] == 1
    assert store.seq == 1


def test_any_key_change_emits_an_upsert_for_that_node_only():
    store, _ = committed_store()

    # A feature-block change and a novel top-level key: exactly the two shapes
    # of state v1's hand-maintained patch signature used to silently drop.
    mapper = basic_nodes()["4"]
    mapper["blocks"]["pickable"]["tags"]["rev"] = 2
    mapper["authority"] = "server"

    result = store.transact().upsert("4", mapper).commit()

    assert [op["id"] for op in result["ops"]] == ["4"]
    assert result["ops"][0]["op"] == "upsert"
    assert result["ops"][0]["node"]["blocks"]["pickable"]["tags"]["rev"] == 2
    assert result["ops"][0]["node"]["authority"] == "server"


def test_unreachable_subtree_is_removed_and_refs_leave():
    store, _ = committed_store()

    renderer = basic_nodes()["2"]
    renderer["refs"]["viewProps"] = []
    result = store.transact().upsert("2", renderer).commit()

    removed = {op["id"] for op in result["ops"] if op["op"] == "remove"}
    assert removed == {"3", "4", "5"}
    assert result["refs_leaving"] == {"c:pts-hash-1", "c2:conn-1:off-1"}
    assert store.get("5") is None
    assert store.node_ids() == {RW, "2", "6"}


def test_dangling_ref_is_rejected_atomically():
    store, _ = committed_store()
    before = store.snapshot()

    actor = basic_nodes()["3"]
    actor["refs"]["mapper"] = "999"

    with pytest.raises(ValueError, match="999"):
        store.transact().upsert("3", actor).commit()

    assert store.snapshot() == before


def test_shared_ref_survives_losing_one_owner():
    nodes = basic_nodes()
    nodes["2"]["refs"]["viewProps"] = ["3", "30"]
    nodes["30"] = {
        "type": "vtkActor",
        "refs": {"mapper": "40"},
    }
    nodes["40"] = {
        "type": "vtkMapper",
        "refs": {"input": "50"},
    }
    nodes["50"] = {
        "type": "vtkPolyData",
        "arrays": {"points": {"ref": "c:pts-hash-1", "dataType": "Float32Array"}},
    }
    store, _ = committed_store(nodes)

    renderer = nodes["2"]
    renderer["refs"]["viewProps"] = ["3"]
    result = store.transact().upsert("2", renderer).commit()

    assert {op["id"] for op in result["ops"] if op["op"] == "remove"} == {
        "30",
        "40",
        "50",
    }
    # "c:pts-hash-1" is still referenced by node 5.
    assert result["refs_leaving"] == frozenset()


def test_missing_root_is_rejected():
    store = SceneStore(RW)
    nodes = {k: v for k, v in basic_nodes().items() if k != RW}

    with pytest.raises(ValueError, match=RW):
        store.transact().upsert_nodes(nodes).commit()


# ---------------------------------------------------------------------------
# Array region patches
# ---------------------------------------------------------------------------


def test_patch_array_mints_versions_and_carries_payload():
    store, _ = committed_store()

    tx = store.transact()
    tx.patch_array("5", "points", offset=3, data=b"\x00" * 12, data_type="Float32Array")
    result = tx.commit()

    (op,) = result["ops"]
    assert op == {
        "op": "patchArray",
        "id": "5",
        "key": "points",
        "offset": 3,
        "data": b"\x00" * 12,
        "dataType": "Float32Array",
        "ref": "v:5:points:1",
    }
    # Payload rode the op; the replaced content ref left the live set.
    assert result["blob_refs_entering"] == frozenset()
    assert result["refs_leaving"] == {"c:pts-hash-1"}
    assert store.get("5")["arrays"]["points"]["ref"] == "v:5:points:1"

    second = (
        store.transact()
        .patch_array("5", "points", 0, b"\x01" * 12, "Float32Array")
        .commit()
    )
    assert second["ops"][0]["ref"] == "v:5:points:2"
    assert second["refs_leaving"] == {"v:5:points:1"}


def test_patch_array_rejects_missing_targets():
    store, _ = committed_store()

    with pytest.raises(ValueError, match="999"):
        store.transact().patch_array("999", "points", 0, b"", "Float32Array").commit()
    with pytest.raises(ValueError, match="normals"):
        store.transact().patch_array("5", "normals", 0, b"", "Float32Array").commit()


def test_patch_with_upsert_in_same_commit_orders_upsert_first():
    store, _ = committed_store()

    polydata = basic_nodes()["5"]
    polydata["props"] = {"note": "resized"}
    tx = store.transact()
    tx.upsert("5", polydata)
    tx.patch_array("5", "points", 0, b"\x02" * 12, "Float32Array")
    result = tx.commit()

    assert [op["op"] for op in result["ops"]] == ["upsert", "patchArray"]
    # The upsert carries the translator's ref; the patch then re-refs it.
    assert result["ops"][0]["node"]["arrays"]["points"]["ref"] == "c:pts-hash-1"
    assert store.get("5")["arrays"]["points"]["ref"] == "v:5:points:1"


def test_patch_on_node_removed_in_same_commit_is_dropped():
    store, _ = committed_store()

    renderer = basic_nodes()["2"]
    renderer["refs"]["viewProps"] = []
    tx = store.transact()
    tx.upsert("2", renderer)
    tx.patch_array("5", "points", 0, b"\x03" * 12, "Float32Array")
    result = tx.commit()

    assert not [op for op in result["ops"] if op["op"] == "patchArray"]
    assert store.get("5") is None


def test_version_counter_survives_node_removal():
    store, _ = committed_store()
    store.transact().patch_array(
        "5", "points", 0, b"\x04" * 12, "Float32Array"
    ).commit()

    renderer = basic_nodes()["2"]
    renderer["refs"]["viewProps"] = []
    store.transact().upsert("2", renderer).commit()

    nodes = basic_nodes()
    store.transact().upsert_nodes(nodes).commit()
    result = (
        store.transact()
        .patch_array("5", "points", 0, b"\x05" * 12, "Float32Array")
        .commit()
    )

    # Object-manager ids can be recycled; version refs must never repeat.
    assert result["ops"][0]["ref"] == "v:5:points:2"


# ---------------------------------------------------------------------------
# Sequencing, snapshots, bookkeeping
# ---------------------------------------------------------------------------


def test_seq_chain_is_contiguous_across_commits():
    store, first = committed_store()

    actor = basic_nodes()["3"]
    actor["props"]["visibility"] = False
    second = store.transact().upsert("3", actor).commit()

    assert (first["base_seq"], first["seq"]) == (0, 1)
    assert (second["base_seq"], second["seq"]) == (1, 2)


def test_advance_mints_a_seq_without_ops():
    store, _ = committed_store()

    assert store.advance() == (1, 2)
    assert store.seq == 2
    assert store.snapshot()["nodes"] == basic_nodes()


def test_last_seq_touching_tracks_ops_and_forgets_removed_nodes():
    store, _ = committed_store()
    assert store.last_seq_touching("4") == 1

    mapper = basic_nodes()["4"]
    mapper["blocks"]["pickable"]["tags"]["rev"] = 2
    store.transact().upsert("4", mapper).commit()
    assert store.last_seq_touching("4") == 2
    assert store.last_seq_touching("3") == 1

    renderer = basic_nodes()["2"]
    renderer["refs"]["viewProps"] = []
    store.transact().upsert("2", renderer).commit()
    assert store.last_seq_touching("4") is None


def test_array_patches_advance_the_default_staleness_cursor():
    store, _ = committed_store()
    before = store.last_seq_touching("5")

    store.transact().patch_array(
        "5", "points", 0, b"\x00" * 12, "Float32Array"
    ).commit()

    # Patches move the picked points, so they count by default; mid-gesture
    # callers pass strict=False so their own confirmations don't stale them.
    assert store.last_seq_touching("5") == store.seq
    assert store.last_seq_touching("5", strict=False) == before

    node = store.get("5")
    node["props"] = {"structuralRevision": 2}
    store.transact().upsert("5", node).commit()
    assert store.last_seq_touching("5", strict=False) == store.seq


def test_snapshot_is_isolated_from_store_mutation():
    store, _ = committed_store()
    snap = store.snapshot()
    snap["nodes"]["3"]["props"]["visibility"] = False

    assert store.get("3")["props"]["visibility"] is True


def test_transaction_cannot_commit_twice():
    store, _ = committed_store()
    tx = store.transact()
    tx.commit()
    with pytest.raises(RuntimeError):
        tx.commit()


def test_node_validation_rejects_bad_shapes():
    store = SceneStore(RW)
    with pytest.raises(ValueError, match="type"):
        store.transact().upsert(RW, {"props": {}})
    with pytest.raises(ValueError, match="refs"):
        store.transact().upsert(RW, {"type": "vtkRenderWindow", "refs": [1, 2]})
    with pytest.raises(ValueError, match="ref"):
        store.transact().upsert(
            RW, {"type": "vtkPolyData", "arrays": {"points": {"dataType": "x"}}}
        )


def test_canonicalization_isolates_caller_mutations():
    store = SceneStore(RW)
    node = {"type": "vtkRenderWindow", "props": {"deep": {"n": 1}}, "refs": {}}
    tx = store.transact().upsert(RW, node)
    node["props"]["deep"]["n"] = 2
    tx.commit()

    assert store.get(RW)["props"]["deep"]["n"] == 1


# ---------------------------------------------------------------------------
# Mirror round-trip property
# ---------------------------------------------------------------------------


def test_mirror_roundtrip_over_randomized_history():
    rng = random.Random(1234)
    store = SceneStore(RW)
    mirror = {}

    def random_leaf(node_id, generation):
        return {
            "type": "vtkPolyData",
            "props": {"generation": generation},
            "arrays": {
                "points": {
                    "ref": f"c:content-{rng.randint(0, 3)}",
                    "dataType": "Float32Array",
                }
            },
        }

    leaf_ids = [str(i) for i in range(10, 22)]
    for round_index in range(60):
        tx = store.transact()

        attached = rng.sample(leaf_ids, k=rng.randint(0, len(leaf_ids)))
        tx.upsert(RW, {"type": "vtkRenderWindow", "refs": {"renderers": ["2"]}})
        tx.upsert(
            "2",
            {
                "type": "vtkRenderer",
                "props": {"round": round_index if rng.random() < 0.5 else -1},
                "refs": {"viewProps": attached},
            },
        )
        for node_id in attached:
            if rng.random() < 0.6:
                tx.upsert(node_id, random_leaf(node_id, rng.randint(0, 4)))
            elif store.get(node_id) is None:
                tx.upsert(node_id, random_leaf(node_id, -1))

        for node_id in attached:
            if rng.random() < 0.3 and (
                store.get(node_id) is not None or node_id in tx._upserts
            ):
                tx.patch_array(
                    node_id, "points", rng.randint(0, 8), b"\x07" * 12, "Float32Array"
                )

        result = tx.commit()
        apply_ops(mirror, result["ops"])

        assert mirror == store.snapshot()["nodes"], f"diverged at round {round_index}"
        live = {
            entry["ref"]
            for node in mirror.values()
            for entry in (node.get("arrays") or {}).values()
        }
        assert result["blob_refs_entering"] <= live
        assert not (result["refs_leaving"] & live)
