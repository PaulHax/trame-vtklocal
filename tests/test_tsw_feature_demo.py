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
    name, starter, monitor = helper.get_xprocess_args(
        "examples/vtk/maplibre_vtkjs_partial.py"
    )
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
