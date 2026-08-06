// Rendered-camera motion classification: the adaptive quality regime must
// follow the camera the view actually renders — playback, scrubbing,
// programmatic animation and server-applied cameras included — and must never
// turn a server-provided camera into a user camera report.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";
import {
  HIERARCHY,
  POSITIONS,
  RGB,
  anchorGraph,
  makePct1,
  stubFetch,
} from "./pointCloudLodFixtures.mjs";

after(async () => {
  await closeModuleLoader();
});

const BLOCK = {
  sourceAssetId: "asset-1",
  revision: "rev1",
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
  return { anchorMapper, anchorActor, renderer, renderWindow };
}

// One adaptive cloud rendering into one view, driven exactly the way a host
// drives it: apply the block, then repaint.
async function makeAdaptiveView() {
  const module = await loadModule("/src/components/pointCloudLod.js");
  stubFetch();
  const camera = makeCamera();
  const { anchorMapper, anchorActor, renderer, renderWindow } =
    makeRenderer(camera);
  const registry = new Map();
  // The graph statement the anchor resolver reads.
  const graph = anchorGraph();
  graph.addRenderer(renderer);
  graph.setAnchor("42", anchorActor);
  const context = {
    renderers: [renderer],
    renderWindow,
    scheduleRender: () => {},
    motionDebounceMs: DEBOUNCE_MS,
    referrersOf: graph.referrersOf,
    getInstance: graph.getInstance,
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
    anchorMapper,
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

test("a cloud re-added after the camera moved starts settled", async () => {
  // While the view holds no cloud there is nothing to select for, so those
  // passes see no camera at all. Keeping the last camera from before the cloud
  // left makes the first pass after it comes back compare against it and read
  // every metre travelled since as motion — the returning cloud's opening
  // selection then runs at the responsive quality target for a gesture nobody
  // made. It self-clears one debounce later, which is exactly long enough to
  // be the frames the user is looking at.
  const view = await makeAdaptiveView();
  try {
    assert.equal(view.governor().regime, "stationary", "still to begin with");

    // The cloud goes away: a null block drops the entry, and with the last
    // adaptive cloud gone the view drops its governor too.
    view.applyPointCloudLodBlock(view.registry, "42", null, null, () => {});
    view.repaint();
    await settle();
    assert.equal(view.registry.size, 0, "the entry is gone");
    assert.equal(view.governor(), null, "no cloud, no governor");

    // The user moves the empty view a long way.
    for (let step = 0; step < 5; step += 1) {
      view.camera.panBy(250);
      view.repaint();
      await sleep(20);
    }

    view.applyPointCloudLodBlock(
      view.registry,
      "42",
      BLOCK,
      view.anchorMapper,
      () => {},
    );
    view.repaint();
    await settle();

    const stats = view.governor();
    assert.equal(
      stats.regime,
      "stationary",
      "the returning cloud read the camera's travel as motion",
    );
    assert.equal(stats.motion.source, null);
    assert.equal(stats.motion.inferredReferences, 0);
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
  const { anchorMapper, anchorActor, renderer, renderWindow } =
    makeRenderer(camera);
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
        synchronizerContext: {
          // Resolves the mirrored node ids to their live instances.
          getInstance: (id) =>
            id === "42-actor" ? anchorActor : id === "5" ? renderer : null,
        },
        syncRenderWindow: renderWindow,
        cleanup() {},
      }),
      // The mirrored graph statement the anchor resolver reads: the actor
      // node rides mapper node "42", hosted by synced renderer node "5".
      createMirrorStore: () => ({
        entries: () =>
          new Map([
            ["42-actor", { refs: { mapper: "42" } }],
            ["5", { refs: { viewProps: ["42-actor"] } }],
          ]).entries(),
        get: () => null,
        referrersOf: (id, slot) => {
          if (String(id) === "42" && slot === "mapper") return ["42-actor"];
          if (String(id) === "42-actor" && slot === "viewProps") return ["5"];
          return [];
        },
        refRevision: () => 1,
        applyOps() {},
        clear() {},
        gcBlobCache() {},
        toObject: () => ({}),
      }),
      createReconciler: () => ({
        registerBlockHandler: (key, handler) => blockHandlers.set(key, handler),
        instanceRevision: () => 0,
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
  scene.beforeRender();
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
      view.scene.beforeRender();
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

test("a cloud waiting on a retry backoff still reports pending work", async () => {
  // The two physical-operation counters the per-frame read carries both go to
  // zero while a failed tile sits in its retry backoff, so `workPending` is the
  // only thing left saying the frame is drawn on an incomplete tile set. A host
  // that never reports it lets the governor take a capacity sample from a
  // cheap, half-empty frame and raise the budget it will have to cut back.
  const module = await loadModule("/src/components/pointCloudLod.js");
  let failTiles = true;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/hierarchy/")) {
      return new Response(JSON.stringify(HIERARCHY), { status: 200 });
    }
    if (failTiles) return new Response("", { status: 503 });
    return new Response(makePct1(POSITIONS, RGB), { status: 200 });
  };

  const camera = makeCamera();
  const { anchorMapper, anchorActor, renderer, renderWindow } =
    makeRenderer(camera);
  const registry = new Map();
  const graph = anchorGraph();
  graph.addRenderer(renderer);
  graph.setAnchor("42", anchorActor);
  const context = {
    renderers: [renderer],
    renderWindow,
    scheduleRender: () => {},
    motionDebounceMs: DEBOUNCE_MS,
    referrersOf: graph.referrersOf,
    getInstance: graph.getInstance,
  };
  module.applyPointCloudLodBlock(registry, "42", BLOCK, anchorMapper, () => {});
  try {
    module.updatePointCloudLods(registry, context);
    await settle();
    // Let the failure land and the backoff arm, with nothing in flight.
    for (let i = 0; i < 10; i += 1) {
      module.updatePointCloudLods(registry, context);
      await settle();
    }

    const stats = module.describePointCloudLodGovernor(registry);
    assert.equal(
      stats.activity.workPending,
      true,
      "a tile still owed but not in flight is pending work",
    );
    assert.equal(
      stats.activity.measurementEligible,
      false,
      "so the frame is not an eligible capacity sample",
    );
  } finally {
    module.disposePointCloudLods(registry);
  }
});
