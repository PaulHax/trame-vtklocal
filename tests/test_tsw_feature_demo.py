"""Real MapLibre + two-view example checks; no TSW project or service required."""

import base64
import hashlib
import math
import io

from PIL import Image
import os
from pathlib import Path
import struct

import pytest
from trame_client.utils.testing import FixtureHelper

pytestmark = pytest.mark.js_oracle
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def demo_server(xprocess):
    vendor = os.environ.get("TRAME_TSW_DEMO_VENDOR")
    if not vendor:
        pytest.skip(
            "Set TRAME_TSW_DEMO_VENDOR to local MapLibre/gl-matrix distributions"
        )
    for name in ("maplibre-gl.js", "maplibre-gl.css", "gl-matrix-min.js"):
        assert (Path(vendor) / name).is_file(), f"Missing {name} in {vendor}"
    helper = FixtureHelper(ROOT)
    name, starter, monitor = helper.get_xprocess_args("examples/vtk/maplibre_vtkjs.py")
    # xprocess changes cwd; a relative PYTHONPATH would silently test an installed wheel.
    starter.env = {**os.environ, "PYTHONPATH": str(ROOT / "src")}
    logfile = xprocess.ensure(name, starter)
    try:
        yield f"http://127.0.0.1:{monitor(logfile[1]).port}"
    finally:
        xprocess.getinfo(name).terminate()


def wait_painted(page):
    page.wait_for_function("""() => {
      const d = window.tswDemo?.diagnostics();
      return d && ['demoMap', 'demoLocal'].every(key =>
        d.frames[key] && d.paints[key]?.textures.some(t =>
          t.key === 'demo-video' &&
          t.token?.frame === d.frames[key].frame &&
          t.token?.generation === d.frames[key].generation));
    }""")


def step(page):
    previous = page.evaluate("window.tswDemo.diagnostics().frames.demoMap.frame")
    page.get_by_role("button", name="Step", exact=True).click()
    page.wait_for_function(
        "f => window.tswDemo.diagnostics().frames.demoMap.frame === f + 1", arg=previous
    )
    wait_painted(page)
    return previous + 1


def cloud_points(page, view):
    entries = page.evaluate(
        """key => Object.values(window.tswDemo.views[key].getAppliedSceneState().nodes)
          .map(n=>n.arrays?.points).filter(a=>a?.size===12288)""",
        view,
    )
    assert len(entries) == 1
    return struct.unpack("<12288f", base64.b64decode(entries[0]["content"]))


def wait_streamed(page):
    page.wait_for_function("""() => {
      const d = window.tswDemo.diagnostics();
      return ['map', 'local'].every(key => {
        const m = d[key].streamedScene.members;
        return m.length === 2 && m.every(e => !e.error &&
          (e.kind === 'pointCloud' ? e.stats?.controller?.residentPoints > 0 :
           e.stats?.sourceState === 'ready' && e.stats?.submittedActors > 0 && e.stats?.submittedTextureBytes > 0));
      });
    }""")


def test_feature_demo_lifecycle_and_frames(demo_server, page):
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    with page.expect_response(lambda r: "trame_vtklocal.umd.js" in r.url) as served:
        page.goto(demo_server + "?basemap=blank")
    bundle = ROOT / "src/trame_vtklocal/module/serve/js/trame_vtklocal.umd.js"
    assert (
        hashlib.sha256(served.value.body()).digest()
        == hashlib.sha256(bundle.read_bytes()).digest()
    )
    wait_painted(page)
    wait_streamed(page)
    step(page)
    page.evaluate("window.tswDemo.setTextureDelay(250)")
    previous = page.evaluate("window.tswDemo.diagnostics().frames.demoMap.frame")
    page.get_by_role("button", name="Step", exact=True).click()
    page.wait_for_function("window.tswDemo.diagnostics().map.heldLength > 0")
    assert (
        page.evaluate("window.tswDemo.diagnostics().frames.demoMap.frame") == previous
    )
    page.wait_for_function(
        "f=>window.tswDemo.diagnostics().frames.demoMap.frame===f+1", arg=previous
    )
    wait_painted(page)
    frame = previous + 1
    image = Image.open(io.BytesIO(page.screenshot())).convert("RGB")
    expected_color = (21, 184, 188) if frame % 2 else (174, 79, 200)
    for point in ([-2 + math.sin(frame / 10), -6, 0], [5, -6, 0]):
        pixel = project(page, "demoMap", point)
        color = image.getpixel((round(pixel["x"]), round(pixel["y"])))
        assert color == pytest.approx(expected_color, abs=8)
    before = cloud_points(page, "demoMap")
    assert before[602] == pytest.approx(0.5 + math.sin(frame / 4))
    assert cloud_points(page, "demoLocal") == before
    page.get_by_role("button", name="Replace dependencies", exact=True).click()
    page.wait_for_function(
        "window.tswDemo.diagnostics().frames.demoMap.generation === 1"
    )
    frame = step(page)
    frame = step(page)
    after = cloud_points(page, "demoMap")
    assert after[602] == pytest.approx(0.5 + math.sin(frame / 4))
    assert cloud_points(page, "demoLocal") == after
    assert after[602] != before[602]
    assert page.evaluate("window.tswDemo.diagnostics().operations.patchArray") >= 4
    page.get_by_role("button", name="Remove / re-add", exact=True).click()
    page.wait_for_function(
        "window.tswDemo.diagnostics().map.streamedScene.members.length === 0"
    )
    page.get_by_role("button", name="Remove / re-add", exact=True).click()
    wait_streamed(page)
    step(page)
    page.get_by_role("button", name="Correction transform", exact=True).click()
    page.wait_for_function("""() => window.tswDemo.diagnostics().map.streamedScene.members
      .find(m=>m.kind==='pointCloud').anchorUserMatrix[13] === 1""")
    page.get_by_role("button", name="Pick cloud point", exact=True).click()
    point = project(page, "demoMap", [8, 1, 1 + math.sin(8) / 2])
    page.mouse.click(point["x"], point["y"])
    page.wait_for_function(
        "document.getElementById('pointer-status').textContent.includes('cloud hit')"
    )
    page.get_by_role("button", name="Correction transform", exact=True).click()
    page.wait_for_function(
        "document.getElementById('pointer-status').textContent==='No pick yet'"
    )
    page.get_by_role("button", name="Opacity", exact=True).click()
    page.get_by_role("button", name="Recover", exact=True).click()
    page.get_by_role("button", name="Reset cameras", exact=True).click()
    page.get_by_role("button", name="Reload map style", exact=True).click()
    page.wait_for_function("window.tswDemo.map.getLayer('vtk-demo')")
    frame = step(page)
    assert cloud_points(page, "demoMap")[602] == pytest.approx(
        0.5 + math.sin(frame / 4)
    )
    assert page.evaluate("window.tswDemo.diagnostics().error") is None
    assert page.evaluate("window.tswDemo.diagnostics().mismatchedPaints") == 0
    # Reconnect snapshots restore retained frame commands and texture ownership.
    page.reload()
    wait_painted(page)
    wait_streamed(page)
    assert page.evaluate("window.tswDemo.diagnostics().frames.demoMap.frame") == frame
    assert page.evaluate("window.tswDemo.diagnostics().mismatchedPaints") == 0
    assert not errors


def project(page, view, point):
    return page.evaluate(
        """({key, point}) => {
      const view = window.tswDemo.views[key];
      const canvas = key === 'demoMap' ? window.tswDemo.map.getCanvas() :
        document.querySelector('#inspector canvas');
      const rect = canvas.getBoundingClientRect();
      const camera = view.getRenderer().getActiveCamera();
      const raw = camera.getCompositeProjectionMatrix(rect.width / rect.height, -1, 1);
      const matrix = glMatrix.mat4.transpose(new Float64Array(16), raw);
      const p = glMatrix.vec4.transformMat4([], [...point,1], matrix);
      return {x: rect.left+(p[0]/p[3]+1)*rect.width/2,
              y: rect.top+(1-p[1]/p[3])*rect.height/2};
    }""",
        {"key": view, "point": point},
    )


def test_feature_demo_drag_round_trip(demo_server, page):
    page.goto(demo_server + "?basemap=blank")
    wait_painted(page)
    for key in ("demoMap", "demoLocal"):
        before = page.evaluate(
            """key => Object.values(
          window.tswDemo.views[key].getAppliedSceneState().nodes)
          .find(n=>n.arrays?.points?.size===9).arrays.points.content""",
            key,
        )
        values = struct.unpack("<9f", base64.b64decode(before))
        start = project(page, key, [values[3], values[4], values[5]])
        before_seq = page.evaluate(
            "key => window.tswDemo.views[key].getSyncDiagnostics().mySeq", key
        )
        page.mouse.move(start["x"], start["y"])
        page.mouse.down()
        page.mouse.move(start["x"] + 20, start["y"], steps=4)
        page.mouse.up()
        page.wait_for_function(
            "({key,seq})=>window.tswDemo.views[key].getSyncDiagnostics().mySeq>seq",
            arg={"key": key, "seq": before_seq},
        )
        page.wait_for_function(
            """({key,before}) => Object.values(
          window.tswDemo.views[key].getAppliedSceneState().nodes)
          .find(n=>n.arrays?.points?.size===9).arrays.points.content !== before""",
            arg={"key": key, "before": before},
        )
        after = page.evaluate(
            """key => Object.values(
          window.tswDemo.views[key].getAppliedSceneState().nodes)
          .find(n=>n.arrays?.points?.size===9).arrays.points.content""",
            key,
        )
        values = struct.unpack("<9f", base64.b64decode(after))
        end = project(page, key, [values[3], values[4], values[5]])
        assert end["x"] == pytest.approx(start["x"] + 20, abs=2)
        assert end["y"] == pytest.approx(start["y"], abs=2)


def test_nadir_pick_feedback_and_follow(demo_server, page):
    page.goto(demo_server + "?basemap=blank")
    wait_painted(page)
    wait_streamed(page)
    # The map's top-down view used to give lookAt a parallel up vector.
    for bearing in (0, 90, 180):
        page.evaluate(
            "bearing => window.tswDemo.map.jumpTo({pitch:0,bearing})", bearing
        )
        page.wait_for_timeout(150)
        image = Image.open(io.BytesIO(page.screenshot())).convert("RGB")
        point = project(page, "demoMap", [-7, 0, 2])
        assert math.isfinite(point["x"]) and math.isfinite(point["y"])
        assert image.getpixel((round(point["x"]), round(point["y"]))) == pytest.approx(
            (255, 51, 77), abs=12
        )

    page.evaluate("window.tswDemo.map.jumpTo({pitch:0,bearing:0})")
    page.wait_for_timeout(150)
    # Search beyond the cloud edge for an outer-bucket hit; verify the result
    # is on the cursor ray, not snapped to the distant supporting vertex.
    candidate = page.evaluate("""() => {
      const d=window.tswDemo, canvas=d.map.getCanvas(), rect=canvas.getBoundingClientRect();
      for (let x=rect.width-1;x>rect.width/2;x-=3) {
        const y=Math.floor(rect.height/2);
        const hit=d.views.demoMap.pickCloudPoint('demo-cloud',x,y);
        if(hit?.status==='hit' && hit.distance_px>30)
          return {x:x+rect.left,y:y+rect.top,hit};
      }
      return null;
    }""")
    assert candidate is not None
    assert 30 < candidate["hit"]["distance_px"] <= 100
    projected = project(page, "demoMap", candidate["hit"]["world"])
    assert projected["x"] == pytest.approx(candidate["x"], abs=1)
    assert projected["y"] == pytest.approx(candidate["y"], abs=1)
    page.get_by_role("button", name="Pick cloud point", exact=True).click()
    page.mouse.click(candidate["x"], candidate["y"])
    page.wait_for_function(
        "document.getElementById('pointer-status').textContent.includes('supporting vertex')"
    )
    for key in ("demoMap", "demoLocal"):
        page.wait_for_function(
            """({key,expected}) => Object.values(window.tswDemo.views[key].getAppliedSceneState().nodes)
            .some(n=>n.arrays?.points?.size===3 &&
              Array.from(new Float32Array(Uint8Array.from(atob(n.arrays.points.content),
                c=>c.charCodeAt(0)).buffer)).every((v,i)=>Math.abs(v-expected[i])<0.001))""",
            arg={"key": key, "expected": candidate["hit"]["world"]},
        )
        marker = project(page, key, candidate["hit"]["world"])
        image = Image.open(io.BytesIO(page.screenshot())).convert("RGB")
        assert image.getpixel(
            (round(marker["x"]), round(marker["y"]))
        ) == pytest.approx((255, 255, 255), abs=12)
    page.get_by_role("button", name="Stop cloud picking", exact=True).click()
    page.wait_for_function(
        "document.getElementById('pointer-status').textContent==='No pick yet'"
    )
    page.get_by_label("Follow sphere", exact=True).check()
    frame = step(page)
    center = page.evaluate("""() => {
      const c=maplibregl.MercatorCoordinate.fromLngLat(window.tswDemo.map.getCenter());
      const origin=maplibregl.MercatorCoordinate.fromLngLat([-74.006,40.7128]);
      const scale=origin.meterInMercatorCoordinateUnits();
      return [(c.x-origin.x)/scale, -(c.y-origin.y)/scale];
    }""")
    assert center == pytest.approx(
        [16 * math.cos(frame * math.pi / 100), 12 * math.sin(frame * math.pi / 100)],
        abs=0.001,
    )
    page.get_by_label("Follow sphere", exact=True).uncheck()
    # Disabled following must not leave a command that replays on reconnect.
    page.reload()
    wait_painted(page)
    assert not page.get_by_label("Follow sphere", exact=True).is_checked()
    center = page.evaluate("window.tswDemo.map.getCenter().toArray()")
    assert center == pytest.approx([-74.006, 40.7128], abs=1e-7)
    page.get_by_role("button", name="Help / What am I seeing?", exact=True).click()
    assert page.locator("#demo-help").evaluate("(el)=>el.open && el.scrollTop===0")
    page.keyboard.press("Escape")
    page.locator(".v-select").click()
    page.get_by_role("option", name="Blank · offline", exact=True).click()
    page.get_by_role("button", name="Play", exact=True).click()
    page.wait_for_function(
        "f=>window.tswDemo.diagnostics().frames.demoMap.frame>f+1", arg=frame
    )
    page.get_by_role("button", name="Pause", exact=True).click()


@pytest.mark.parametrize("armed", [False, True])
def test_background_click_does_not_reapply_follow(demo_server, page, armed):
    page.goto(demo_server + "?basemap=blank")
    wait_painted(page)
    page.get_by_label("Follow sphere", exact=True).check()
    step(page)
    if armed:
        page.get_by_role("button", name="Pick cloud point", exact=True).click()
    page.evaluate(
        "window.tswDemo.map.jumpTo({center:[-74.0059,40.7129],bearing:28,pitch:20})"
    )
    before = page.evaluate("""() => {
      const map=window.tswDemo.map;
      return {center:map.getCenter().toArray(),bearing:map.getBearing(),pitch:map.getPitch()};
    }""")
    seq = page.evaluate("window.tswDemo.diagnostics().map.mySeq")
    rect = page.locator("#map canvas").bounding_box()
    page.mouse.click(rect["x"] + 100, rect["y"] + 100)
    page.wait_for_function("seq=>window.tswDemo.diagnostics().map.mySeq>seq", arg=seq)
    after = page.evaluate("""() => {
      const map=window.tswDemo.map;
      return {center:map.getCenter().toArray(),bearing:map.getBearing(),pitch:map.getPitch()};
    }""")
    assert after == before
    page.get_by_label("Follow sphere", exact=True).uncheck()
