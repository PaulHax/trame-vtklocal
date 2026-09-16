# TSW feature exerciser

This updates the MapLibre partial-update example into a synthetic scene for
checking the library features used by TeleSculptor-Web. It needs no TSW checkout,
project, video, COPC file, or tile service. The server generates a tiny cloud and
textured mesh in a temporary directory. The basemap is an empty MapLibre style;
the map still owns the canvas, camera and interaction.

From the trame-vtklocal checkout, with its VTK and trame dependencies installed:

    PYTHONPATH="$PWD/src" python examples/vtk/maplibre_vtkjs_partial.py --server

The browser loads pinned MapLibre 5.16.0 and gl-matrix 3.4.3 from unpkg. For an
offline run, place maplibre-gl.js, maplibre-gl.css and gl-matrix-min.js in a
directory and pass --vendor-dir /absolute/path/to/directory. Use those same
versions. Rebuild the library's served UMD before exercising modified JS.

## What to try

- **Step / Play** publishes geometry and a retained frame command in one
  transaction per view, followed by TSW's extra sync. One of 4096 cloud points
  changes; later updates use sparse array patches. The cone pipeline and its
  transform also change.
- **Replace dependencies**, then step again: swaps vtkPoints, a property,
  a transform and a pipeline connection. Later edits must still reach both
  views.
- **Remove / re-add**, then step: detaches and restores direct geometry and
  both streamed actors.
- **Correction transform / Opacity** changes streamed actors and their
  presentation. Correction uses the same user-matrix path as TSW.
- Drag the red screen-sized landmarks in either view. Client previews are
  confirmed by a server update shared by both views; stale picks are rejected.
  Glyph centers are scene-space coordinates, as in TSW.
- **Arm cloud pick**, then click the cyan cloud. The feedback reports the
  asset-scoped depth solve.
- **Reload map style** removes/re-adds the custom layer while retaining the
  external GL context. **Reset cameras** exercises ordered map-camera and
  owned-view camera commands.
- Reload the page to check snapshot recovery, retained frame commands and
  per-view texture ownership. **Recover** explicitly scans server MTimes.

Both views have three renderers: world (layer 0), video (layer 1, preserving
depth), and annotations (layer 2, clearing depth). The annotation renderer is
first for camera/picking authority, matching TSW.

Two planes sample one generated, numbered video texture through homography and
world-to-clip projection. A synthetic 80 ms decode delay holds geometry with
registerSceneGate until matching pixels arrive. The status reports the geometry
frame and the texture token actually painted. In the browser console,
window.tswDemo.setTextureDelay(500) makes the hold easier to see, and
window.tswDemo.diagnostics() exposes frame, paint, stream and patch counters.

The cyan cloud uses actual HTTP hierarchy and PCT1 tile requests. The orange
mesh uses an actual 3D Tiles 1.1 tileset with an embedded PNG texture in its GLB.
They exercise the pointcloud-lod adapters, workers, transforms, visibility,
opacity and shared page coordinator. Their tiny size does **not** stress LOD
selection, adaptive budgets, memory eviction or performance.

## Repeatable browser checks

With pytest-playwright, pytest-xprocess, pixelmatch and the existing project
test dependencies available:

    TRAME_TSW_DEMO_VENDOR=/absolute/path/to/vendor       PYTHONPATH="$PWD/src:$PWD/tests"       python -m pytest -q tests/test_tsw_feature_demo.py

The test runs headless. It verifies the served UMD matches the checkout's built
file; both streams submit; both projected planes paint the expected pixels;
delayed geometry waits for its texture; replacement/edit and removal/re-add
preserve client array bytes; both views commit drags at the released position;
cloud picking, correction transforms, style reload and reconnect work.

This is a library integration fixture, not a replacement for TSW E2E tests.
Real video decoding/delivery, MapLibre terrain/globe modes, large COPC trees,
implicit 3D Tiles, Draco/KTX2 codecs, registration workflows and GPU latency
still need the application's own fixtures and hardware checks.
