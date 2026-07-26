// Rendered-camera motion classification: the adaptive quality regime must
// follow the camera the view actually renders — playback, scrubbing,
// programmatic animation and server-applied cameras included — and must never
// turn a server-provided camera into a user camera report.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

const BLOCK = {
  endpoint: "/pointcloud/cloud-1/rev1",
  pointCount: 2,
  presentation: { mode: "fixed", diameterCssPx: 3 },
  adaptive: true,
};

// Short enough that a burst of camera changes and the still gap after it both
// fit inside one test, wide enough that a late timer cannot end a burst: the
// drivers below repaint at least three times per debounce window.
const DEBOUNCE_MS = 120;
// The governor's own settle delay before stationary refinement starts.
const SETTLE_MS = 750;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) {
    await sleep(0);
  }
}

function makePct1(positions) {
  const buffer = new ArrayBuffer(40 + positions.length * 4);
  const view = new DataView(buffer);
  for (let index = 0; index < 4; index += 1) {
    view.setUint8(index, "PCT1".charCodeAt(index));
  }
  view.setUint32(4, positions.length / 3, true);
  view.setUint32(8, 0, true);
  new Float32Array(buffer, 40, positions.length).set(positions);
  return buffer;
}

function stubFetch() {
  globalThis.fetch = async (url) => {
    if (String(url).includes("/hierarchy/")) {
      return new Response(
        JSON.stringify({
          nodes: {
            "0-0-0-0": {
              pointCount: 2,
              children: [],
              page: null,
              bounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
              spacing: 0.1,
            },
          },
        }),
        { status: 200 },
      );
    }
    return new Response(makePct1([0.1, 0.1, 0.1, -0.1, -0.1, -0.1]), {
      status: 200,
    });
  };
}

// A camera in the magnitudes the map really renders with: a Mercator-scaled
// world-to-clip transform and a metre-scale eye point.
function makeCamera() {
  const camera = {
    matrix: [
      4096, 0, 0, 0, 0, 4096, 0, 0, 0, 0, -1.0002, -1, 5000.5, -1200.25, 3.5, 1,
    ],
    position: [5000.5, -1200.25, 850],
    // Pan the camera by whole metres — what one video frame or one scrub step
    // moves it by.
    panBy(metres) {
      camera.position[0] += metres;
      camera.matrix[12] += metres;
    },
    // What recomputing the same camera from the same transform costs in double
    // precision: the last bits move, the view does not.
    jitter() {
      camera.matrix[12] *= 1 + 1e-12;
      camera.position[0] *= 1 - 1e-12;
    },
    // What the map does when the scene's visible bounds change: clip z is
    // remapped (z' = alpha * z + beta * w) so the far plane covers whatever is
    // now in the scene. The eye and the image are untouched — this happens
    // because a tile landed, not because anyone moved the camera.
    remapDepth(alpha, beta) {
      for (let index = 0; index < 4; index += 1) {
        camera.matrix[8 + index] =
          alpha * camera.matrix[8 + index] + beta * camera.matrix[12 + index];
      }
    },
    getCompositeProjectionMatrix: () => camera.matrix.slice(),
    getPosition: () => camera.position.slice(),
    getParallelProjection: () => false,
    getParallelScale: () => 500,
    getViewAngle: () => 60,
  };
  return camera;
}

function makeRenderer(camera) {
  const anchorMapper = { isDeleted: () => false };
  const anchorActor = {
    getMapper: () => anchorMapper,
    getVisibility: () => 1,
    getUserMatrix: () => null,
    getProperty: () => ({ getPointSize: () => 3 }),
  };
  const added = [];
  const renderer = {
    getActors: () => [anchorActor, ...added],
    addActor: (actor) => added.push(actor),
    removeActor: (actor) => {
      const at = added.indexOf(actor);
      if (at >= 0) added.splice(at, 1);
    },
    getActiveCamera: () => camera,
    getViewport: () => [0, 0, 1, 1],
  };
  const renderWindow = { getViews: () => [{ getSize: () => [1600, 900] }] };
  return { anchorMapper, renderer, renderWindow };
}

// One adaptive cloud rendering into one view, driven exactly the way a host
// drives it: apply the block, then repaint.
async function makeAdaptiveView() {
  const module = await loadModule("/src/components/pointCloudLod.js");
  stubFetch();
  const camera = makeCamera();
  const { anchorMapper, renderer, renderWindow } = makeRenderer(camera);
  const registry = new Map();
  const context = {
    renderers: [renderer],
    renderWindow,
    scheduleRender: () => {},
    motionDebounceMs: DEBOUNCE_MS,
  };
  module.applyPointCloudLodBlock(registry, "42", BLOCK, anchorMapper, () => {});
  const repaint = () => module.updatePointCloudLods(registry, context);
  // The first repaint builds the streaming stack and establishes the camera
  // baseline; a first sighting is not motion.
  repaint();
  await settle();
  return {
    ...module,
    registry,
    camera,
    repaint,
    governor: () => module.describePointCloudLodGovernor(registry),
    dispose: () => module.disposePointCloudLods(registry),
  };
}

test("locked video playback holds the responsive quality regime", async () => {
  const view = await makeAdaptiveView();
  try {
    assert.equal(view.governor().regime, "stationary", "still before playback");

    // Playback pushes one camera per video frame; the map repaints each one.
    for (let frame = 0; frame < 10; frame += 1) {
      view.camera.panBy(4);
      view.repaint();
      await sleep(30);
      const stats = view.governor();
      assert.equal(stats.regime, "interaction", `frame ${frame}`);
      assert.equal(stats.targetFrameTimeMs, 16, `frame ${frame}`);
      assert.equal(stats.motion.source, "inferred", `frame ${frame}`);
      assert.equal(stats.motion.explicitReferences, 0, `frame ${frame}`);
    }
  } finally {
    view.dispose();
  }
});

test("pausing playback transitions once into settled refinement", async () => {
  const view = await makeAdaptiveView();
  try {
    for (let frame = 0; frame < 6; frame += 1) {
      view.camera.panBy(4);
      view.repaint();
      await sleep(30);
    }
    assert.equal(view.governor().regime, "interaction");

    // Paused: the view keeps repainting, the camera stops changing.
    const regimes = [];
    const until = Date.now() + DEBOUNCE_MS + SETTLE_MS + 250;
    while (Date.now() < until) {
      view.repaint();
      await sleep(25);
      regimes.push(view.governor().regime);
    }

    assert.equal(regimes[0], "interaction", "the pause starts still moving");
    const transitions = regimes.filter(
      (regime, index) => index > 0 && regime !== regimes[index - 1],
    );
    assert.deepEqual(transitions, ["stationary"], "one transition, and it is");
    const stats = view.governor();
    assert.equal(stats.targetFrameTimeMs, 33);
    assert.equal(stats.motion.source, null);
    assert.equal(stats.motion.settling, false);
  } finally {
    view.dispose();
  }
});

test("scrubbing the timeline holds the responsive quality regime", async () => {
  const view = await makeAdaptiveView();
  try {
    // A drag along the slider: fewer, larger camera jumps than playback.
    for (let step = 0; step < 6; step += 1) {
      view.camera.panBy(120);
      view.repaint();
      await sleep(40);
      const stats = view.governor();
      assert.equal(stats.regime, "interaction", `step ${step}`);
      assert.equal(stats.targetFrameTimeMs, 16, `step ${step}`);
    }
  } finally {
    view.dispose();
  }
});

test("playback under a fixed camera stays in the settled regime", async () => {
  const view = await makeAdaptiveView();
  try {
    // Every video frame repaints the scene; the map camera never moves, so the
    // only difference between two rendered cameras is recomputation noise.
    for (let frame = 0; frame < 10; frame += 1) {
      view.camera.jitter();
      view.repaint();
      await sleep(25);
      const stats = view.governor();
      assert.equal(stats.regime, "stationary", `frame ${frame}`);
      assert.equal(stats.targetFrameTimeMs, 33, `frame ${frame}`);
      assert.equal(stats.motion.source, null, `frame ${frame}`);
      assert.equal(stats.motion.inferredReferences, 0, `frame ${frame}`);
    }
  } finally {
    view.dispose();
  }
});

test("a tile landing under a still camera is not camera motion", async () => {
  const view = await makeAdaptiveView();
  try {
    const eyeBefore = view.camera.getPosition();
    // Each streamed tile grows the scene bounds the map derives its depth
    // range from, so every arrival rewrites clip z under a still camera.
    for (let landing = 0; landing < 10; landing += 1) {
      view.camera.remapDepth(1 + 1e-5, -1e-4);
      view.repaint();
      await sleep(25);
      const stats = view.governor();
      assert.equal(stats.regime, "stationary", `landing ${landing}`);
      assert.equal(stats.targetFrameTimeMs, 33, `landing ${landing}`);
      assert.equal(stats.motion.source, null, `landing ${landing}`);
      assert.equal(stats.motion.inferredReferences, 0, `landing ${landing}`);
    }
    assert.deepEqual(view.camera.getPosition(), eyeBefore, "eye never moved");

    // The classifier is still watching: a real move is still a real move.
    view.camera.panBy(4);
    view.repaint();
    assert.equal(view.governor().regime, "interaction");
  } finally {
    view.dispose();
  }
});

test("the view stops asking for frames once the settled budget converges", async () => {
  const view = await makeAdaptiveView();
  try {
    // Frames inside the settled dead band: the loop has nothing left to move,
    // so the pull signal must go quiet instead of repainting identical pixels.
    let frames = 0;
    while (view.pointCloudLodNeedsFrame(view.registry) && frames < 300) {
      view.recordPointCloudLodHostFrame(view.registry, {
        hostFrameMs: 30,
        vtkFrameMs: 20,
      });
      view.repaint();
      frames += 1;
    }
    assert.ok(frames < 40, `converged in ${frames} frames`);
    assert.equal(view.pointCloudLodNeedsFrame(view.registry), false);

    // Moving the camera puts it back to work.
    view.camera.panBy(10);
    view.repaint();
    assert.equal(view.pointCloudLodNeedsFrame(view.registry), true);
  } finally {
    view.dispose();
  }
});

function makeFakeWindow() {
  const frames = new Map();
  let nextId = 1;
  return {
    devicePixelRatio: 1,
    requestAnimationFrame(callback) {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    flush() {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

// The same cloud driven through the scene the view component owns, so the
// camera-report channel and the motion classifier are exercised together.
async function makeSyncedView() {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");
  stubFetch();
  const camera = makeCamera();
  camera.getFocalPoint = () => [0, 0, 0];
  camera.getViewUp = () => [0, 0, 1];
  camera.getClippingRange = () => [1, 1000];
  const { anchorMapper, renderer, renderWindow } = makeRenderer(camera);
  // Only synced renderers carry the scene, and only they are searched for
  // anchors.
  renderer.get = () => ({ remoteId: "5" });
  renderWindow.getRenderers = () => [renderer];
  renderWindow.getRenderersByReference = () => [renderer];
  renderWindow.getViews = () => [
    {
      getSize: () => [1600, 900],
      getCanvas: () => ({
        style: {},
        getBoundingClientRect: () => ({ left: 0, top: 0 }),
        addEventListener() {},
        removeEventListener() {},
      }),
    },
  ];

  const events = [];
  const blockHandlers = new Map();
  const scene = useSceneSync(
    {
      client: {},
      emit: (name, payload) => events.push({ name, payload }),
      getRenderWindow: () => renderWindow,
      renderScene() {},
      motionDebounceMs: DEBOUNCE_MS,
    },
    {
      createManagedSyncContext: () => ({
        synchronizerContext: {},
        syncRenderWindow: renderWindow,
        cleanup() {},
      }),
      createReconciler: () => ({
        registerBlockHandler: (key, handler) => blockHandlers.set(key, handler),
        teardown() {},
        flushDeferredProps() {},
      }),
      createSceneEngine: () => ({
        start() {},
        stop() {},
        getSeq: () => 3,
        getDiagnostics: () => ({}),
        onCommand: () => () => {},
      }),
    },
  );
  scene.initialize({
    contextName: "point-cloud-lod-motion",
    renderWindowId: 1,
    onRenderNeeded() {},
  });
  blockHandlers.get("pointCloudLod")("42", BLOCK, anchorMapper);
  scene.updatePointCloudLods();
  await settle();
  return {
    scene,
    camera,
    events,
    cameraReports: () => events.filter((event) => event.name === "camera"),
  };
}

test("a server-applied camera drives quality without being reported back", async () => {
  const previousWindow = globalThis.window;
  const fakeWindow = makeFakeWindow();
  globalThis.window = fakeWindow;
  const view = await makeSyncedView();
  try {
    view.scene.enableCameraReports({ during: "interaction", terminal: true });

    // Locked playback: the server pushes a camera per frame and the view
    // repaints it. Nothing here is a user gesture.
    for (let frame = 0; frame < 6; frame += 1) {
      view.camera.panBy(4);
      view.scene.updatePointCloudLods();
      await sleep(30);
    }
    const moving = view.scene.getSyncDiagnostics().pointCloudLod.governor;
    assert.equal(moving.regime, "interaction", "the classifier saw the camera");
    assert.equal(moving.motion.source, "inferred");
    fakeWindow.flush();
    assert.deepEqual(view.cameraReports(), [], "no camera echoed upstream");

    // Not on the way out of motion either.
    await sleep(DEBOUNCE_MS + 80);
    fakeWindow.flush();
    assert.deepEqual(view.cameraReports(), []);

    // The channel is live: a real gesture over the same camera does report.
    view.scene.beginCameraInteraction();
    view.scene.cameraInteraction();
    fakeWindow.flush();
    assert.equal(view.cameraReports().length, 1);
    view.scene.endCameraInteraction();
  } finally {
    view.scene.cleanup();
    globalThis.window = previousWindow;
  }
});

test("overlapping motion sources end the regime only with the last one", async () => {
  const view = await makeAdaptiveView();
  try {
    // A wheel timer and a pointer drag each hold their own explicit reference.
    view.beginPointCloudLodInteraction(view.registry);
    view.beginPointCloudLodInteraction(view.registry);
    // Playback and a programmatic fly-to both reach LOD as rendered-camera
    // motion, so they share the one inferred reference.
    view.camera.panBy(6);
    view.repaint();
    view.camera.panBy(60);
    view.repaint();

    let stats = view.governor();
    assert.equal(stats.motion.source, "both");
    assert.equal(stats.motion.explicitReferences, 2);
    assert.equal(stats.motion.inferredReferences, 1);

    // The wheel stops. The pointer and the camera are still going.
    view.endPointCloudLodInteraction(view.registry);
    assert.equal(view.governor().regime, "interaction");

    // The camera stops too; the pointer alone keeps quality responsive.
    await sleep(DEBOUNCE_MS + 80);
    stats = view.governor();
    assert.equal(stats.motion.inferredReferences, 0);
    assert.equal(stats.motion.source, "explicit");
    assert.equal(stats.regime, "interaction");
    assert.equal(stats.targetFrameTimeMs, 16);

    // The camera moves again before the pointer lifts, so releasing the last
    // explicit reference cannot settle the view either.
    view.camera.panBy(6);
    view.repaint();
    view.endPointCloudLodInteraction(view.registry);
    stats = view.governor();
    assert.equal(stats.motion.explicitReferences, 0);
    assert.equal(stats.motion.source, "inferred");
    assert.equal(stats.regime, "interaction");

    // Only once the last source has stopped does the view settle.
    await sleep(DEBOUNCE_MS + 80);
    assert.equal(view.governor().motion.settling, true);
    assert.equal(view.governor().regime, "interaction");
    await sleep(SETTLE_MS + 150);
    stats = view.governor();
    assert.equal(stats.regime, "stationary");
    assert.equal(stats.targetFrameTimeMs, 33);
  } finally {
    view.dispose();
  }
});
