import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function makeCamera() {
  const state = {
    position: [0, 0, 5],
    focalPoint: [0, 0, 0],
    viewUp: [0, 1, 0],
    viewAngle: 30,
    parallelProjection: false,
    parallelScale: 1,
    clippingRange: [0.1, 100],
  };
  const camera = {
    state,
    getViewMatrix: () => IDENTITY,
    getProjectionMatrix: () => IDENTITY,
    getCompositeProjectionMatrix: () => IDENTITY,
    getDirectionOfProjection: () => [0, 0, -1],
    modified() {},
  };
  const vectorFields = ["position", "focalPoint", "viewUp", "clippingRange"];
  for (const field of vectorFields) {
    const suffix = field[0].toUpperCase() + field.slice(1);
    camera[`get${suffix}`] = () => state[field].slice();
    camera[`set${suffix}`] = (...value) => {
      state[field] = value;
    };
  }
  for (const field of ["viewAngle", "parallelProjection", "parallelScale"]) {
    const suffix = field[0].toUpperCase() + field.slice(1);
    camera[`get${suffix}`] = () => state[field];
    camera[`set${suffix}`] = (value) => {
      state[field] = value;
    };
  }
  return camera;
}

function makeWindow() {
  let nextRaf = 1;
  const raf = new Map();
  return {
    devicePixelRatio: 1,
    requestAnimationFrame(callback) {
      const id = nextRaf++;
      raf.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      raf.delete(id);
    },
    flush() {
      const callbacks = [...raf.values()];
      raf.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

async function makeScene() {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");
  const camera = makeCamera();
  const renderer = {
    get: () => ({}),
    getActiveCamera: () => camera,
    getViewport: () => [0, 0, 1, 1],
    resetCamera() {},
  };
  const canvas = {
    style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    addEventListener() {},
    removeEventListener() {},
  };
  const renderWindow = {
    getRenderers: () => [renderer],
    getRenderersByReference: () => [renderer],
    getViews: () => [{ getSize: () => [800, 400], getCanvas: () => canvas }],
  };
  const events = [];
  const commandHandlers = new Map();
  let engineCallbacks = null;
  const scene = useSceneSync(
    {
      client: {},
      emit: (name, payload) => events.push({ name, payload }),
      getRenderWindow: () => renderWindow,
      renderScene() {},
    },
    {
      createManagedSyncContext: () => ({
        synchronizerContext: {},
        syncRenderWindow: renderWindow,
        cleanup() {},
      }),
      createReconciler: () => ({
        registerBlockHandler() {},
        teardown() {},
        flushDeferredProps() {},
      }),
      createSceneEngine: ({ callbacks }) => {
        engineCallbacks = callbacks;
        return {
          start() {},
          stop() {},
          resync() {},
          getSeq: () => 7,
          getDiagnostics: () => ({}),
          onCommand(name, callback) {
            commandHandlers.set(name, callback);
            return () => commandHandlers.delete(name);
          },
        };
      },
    },
  );
  scene.initialize({
    contextName: "camera-sync-test",
    renderWindowId: 1,
    onRenderNeeded() {},
  });
  return { scene, camera, events, commandHandlers, engineCallbacks };
}

test("camera.set command applies parameters through the built-in handler", async () => {
  const harness = await makeScene();
  harness.commandHandlers.get("camera.set")({
    position: [1, 2, 3],
    parallelScale: 8,
  });
  assert.deepEqual(harness.camera.state.position, [1, 2, 3]);
  assert.equal(harness.camera.state.parallelScale, 8);
});

test("camera reports coalesce moves and force a terminal report", async () => {
  const previousWindow = globalThis.window;
  const fakeWindow = makeWindow();
  globalThis.window = fakeWindow;
  try {
    const { scene, events } = await makeScene();
    scene.enableCameraReports({ during: "interaction", terminal: true });
    scene.beginCameraInteraction();
    scene.cameraInteraction();
    scene.cameraInteraction();
    scene.cameraInteraction();
    assert.equal(events.filter((event) => event.name === "camera").length, 0);

    fakeWindow.flush();
    let cameraEvents = events.filter((event) => event.name === "camera");
    assert.equal(cameraEvents.length, 1);
    assert.equal(cameraEvents[0].payload.terminal, false);
    assert.deepEqual(cameraEvents[0].payload.viewport, {
      width: 800,
      height: 400,
      dpr: 1,
    });

    scene.cameraInteraction();
    scene.endCameraInteraction();
    fakeWindow.flush();
    cameraEvents = events.filter((event) => event.name === "camera");
    assert.equal(cameraEvents.length, 2);
    assert.equal(cameraEvents[1].payload.terminal, true);
    assert.equal(cameraEvents[1].payload.seq, 7);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("camera interaction is reference-counted across overlapping sources", async () => {
  const previousWindow = globalThis.window;
  const fakeWindow = makeWindow();
  globalThis.window = fakeWindow;
  try {
    const { scene, events } = await makeScene();
    scene.enableCameraReports({ during: "interaction", terminal: true });

    // Two overlapping sources begin; one ends while the other is still active.
    scene.beginCameraInteraction();
    scene.beginCameraInteraction();
    scene.endCameraInteraction();

    // The inner end must NOT emit a terminal report — depth is still > 0.
    assert.equal(events.filter((event) => event.name === "camera").length, 0);

    // The still-active source keeps reporting after the inner end.
    scene.cameraInteraction();
    fakeWindow.flush();
    assert.equal(events.filter((event) => event.name === "camera").length, 1);

    // The outermost end emits exactly one terminal report.
    scene.endCameraInteraction();
    fakeWindow.flush();
    const cameraEvents = events.filter((event) => event.name === "camera");
    assert.equal(cameraEvents.length, 2);
    assert.equal(cameraEvents[1].payload.terminal, true);

    // An unmatched extra end at depth 0 is a no-op — no terminal report.
    scene.endCameraInteraction();
    fakeWindow.flush();
    assert.equal(events.filter((event) => event.name === "camera").length, 2);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("re-initializing during a gesture does not silence later terminal reports", async () => {
  const previousWindow = globalThis.window;
  const fakeWindow = makeWindow();
  globalThis.window = fakeWindow;
  try {
    const { scene, events } = await makeScene();
    scene.enableCameraReports({ during: "interaction", terminal: true });

    // The host re-initializes the view while a gesture is open: the gesture's
    // end then lands on a counter that was already reset.
    scene.beginCameraInteraction();
    scene.initialize({
      contextName: "camera-sync-test",
      renderWindowId: 1,
      onRenderNeeded() {},
    });
    scene.endCameraInteraction();

    // Every later gesture must still report its moves and its end.
    scene.beginCameraInteraction();
    scene.cameraInteraction();
    fakeWindow.flush();
    scene.endCameraInteraction();
    fakeWindow.flush();
    const cameraEvents = events.filter((event) => event.name === "camera");
    assert.equal(cameraEvents.length, 2);
    assert.equal(cameraEvents[0].payload.terminal, false);
    assert.equal(cameraEvents[1].payload.terminal, true);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("programmatic interaction shares lifecycle without reporting camera echo", async () => {
  const previousWindow = globalThis.window;
  const fakeWindow = makeWindow();
  globalThis.window = fakeWindow;
  try {
    const { scene, events } = await makeScene();
    scene.enableCameraReports({ during: "interaction", terminal: true });
    scene.beginCameraInteraction({ report: false });
    scene.cameraInteraction();
    scene.endCameraInteraction();
    fakeWindow.flush();
    assert.equal(events.filter((event) => event.name === "camera").length, 0);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("a reporting gesture is retracted by its end whatever the caller says", async () => {
  const previousWindow = globalThis.window;
  const fakeWindow = makeWindow();
  globalThis.window = fakeWindow;
  try {
    const { scene, events } = await makeScene();
    scene.enableCameraReports({ during: "interaction", terminal: true });

    // The end carries the wrong flag for the gesture that is open. The
    // gesture's own flag rides the stack, so it is still the one retracted:
    // the terminal report fires and nothing stays owed.
    scene.beginCameraInteraction();
    scene.endCameraInteraction({ report: false });
    fakeWindow.flush();
    assert.equal(events.filter((event) => event.name === "camera").length, 1);

    // A later, non-reporting gesture is unaffected by the mismatched pair.
    scene.beginCameraInteraction({ report: false });
    scene.cameraInteraction();
    scene.endCameraInteraction();
    fakeWindow.flush();
    assert.equal(events.filter((event) => event.name === "camera").length, 1);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("gesture payload derives camera matrices from the live local camera", async () => {
  const { scene, events } = await makeScene();
  scene.emitTargetClick({ clientX: 10, clientY: 20 });
  const pointer = events.find((event) => event.name === "pointerEvent");
  assert.deepEqual(pointer.payload.camera, {
    viewMatrix: IDENTITY,
    projectionMatrix: IDENTITY,
  });
});
