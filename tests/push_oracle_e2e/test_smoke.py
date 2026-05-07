"""Quickest possible JS-oracle smoke: identify, reset, inspect, no compare."""

from __future__ import annotations

import pytest

from tests.push_oracle_e2e.runner import JsOracle


pytestmark = pytest.mark.js_oracle


def _diagnose(oracle: JsOracle, scene: str):
    res = oracle.reset(scene)
    print(f"\n=== view={oracle.view} scene={scene} ===")
    print("reset:", res)

    from tests.push_oracle.normalize import inline_resolver, normalize

    js_dump = oracle.dump()
    shadow = oracle.shadow()
    js_norm = normalize(js_dump, inline_resolver)
    shadow_norm = normalize(shadow, inline_resolver)
    js_objs = js_norm["objects"]
    sh_objs = shadow_norm["objects"]
    common = set(js_objs.keys()) & set(sh_objs.keys())
    for oid in sorted(common, key=int):
        jp = js_objs[oid].get("properties", {})
        sp = sh_objs[oid].get("properties", {})
        only_js = set(jp.keys()) - set(sp.keys())
        only_sh = set(sp.keys()) - set(jp.keys())
        differs = [k for k in set(jp.keys()) & set(sp.keys()) if jp[k] != sp[k]]
        if only_js or only_sh or differs:
            t = js_objs[oid].get("type") or sh_objs[oid].get("type")
            print(f"  obj {oid} ({t}):")
            if only_js:
                print(f"    only_in_js: {sorted(only_js)[:20]}")
            if only_sh:
                print(f"    only_in_sh: {sorted(only_sh)[:20]}")
            for k in sorted(differs)[:5]:
                jstr = repr(jp.get(k))[:160]
                sstr = repr(sp.get(k))[:160]
                print(f"    {k}:\n      js={jstr}\n      sh={sstr}")


@pytest.mark.parametrize(
    "scene", ["basic", "quad", "tsw_like", "scalars", "polyline"]
)
def test_smoke_local(oracle_local: JsOracle, scene):
    _diagnose(oracle_local, scene)


@pytest.mark.parametrize("scene", ["basic"])
def test_smoke_shared(oracle_shared: JsOracle, scene):
    _diagnose(oracle_shared, scene)
