import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

function makeCamera() {
  return {
    viewMatrix: null,
    projectionMatrix: null,
    parallelScale: null,
    setViewMatrix(value) {
      this.viewMatrix = value;
    },
    setProjectionMatrix(value) {
      this.projectionMatrix = value;
    },
    setParallelScale(value) {
      this.parallelScale = value;
    },
    modified() {},
  };
}

function makeRenderer(id, camera) {
  return {
    camera,
    get(name) {
      return name === "remoteId" ? { remoteId: id } : {};
    },
    getActiveCamera() {
      return this.camera;
    },
    setActiveCamera(value) {
      this.camera = value;
    },
    resetCameraCalls: 0,
    resetCamera() {
      this.resetCameraCalls += 1;
    },
  };
}

function makeRenderWindow(renderers) {
  return {
    getRenderers: () => renderers,
    getRenderersByReference: () => renderers,
    getViews: () => [],
  };
}

test("client camera authority shares one camera across renderer layers", async () => {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");
  const primaryCamera = makeCamera();
  const primary = makeRenderer(1, primaryCamera);
  const underlay = makeRenderer(2, makeCamera());
  const renderWindow = makeRenderWindow([primary, underlay]);
  const scene = useSceneSync({
    client: {},
    emit() {},
    getRenderWindow: () => renderWindow,
    renderScene() {},
    cameraAuthority: "client",
  });

  const viewMatrix = Array.from({ length: 16 }, (_, i) => i + 1);
  const projectionMatrix = Array.from({ length: 16 }, (_, i) => 32 - i);
  assert.equal(scene.setRenderedCamera({ viewMatrix, projectionMatrix }), true);

  assert.deepEqual(scene.getRenderers(), [primary, underlay]);
  assert.equal(scene.getRenderer(), primary);
  assert.equal(underlay.getActiveCamera(), primaryCamera);
  assert.deepEqual(primaryCamera.viewMatrix, viewMatrix);
  assert.deepEqual(primaryCamera.projectionMatrix, projectionMatrix);
});

test("server camera authority preserves independent renderer cameras", async () => {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");
  const primaryCamera = makeCamera();
  const underlayCamera = makeCamera();
  const primary = makeRenderer(1, primaryCamera);
  const underlay = makeRenderer(2, underlayCamera);
  const renderWindow = makeRenderWindow([primary, underlay]);
  const scene = useSceneSync({
    client: {},
    emit() {},
    getRenderWindow: () => renderWindow,
    renderScene() {},
    cameraAuthority: "server",
  });

  scene.setCamera({ parallelScale: 4 });
  scene.setRenderedCamera({
    viewMatrix: Array(16).fill(1),
    projectionMatrix: Array(16).fill(2),
  });
  scene.resetCamera();

  assert.equal(primary.getActiveCamera(), primaryCamera);
  assert.equal(underlay.getActiveCamera(), underlayCamera);
  assert.equal(primaryCamera.parallelScale, 4);
  assert.equal(underlayCamera.parallelScale, null);
  assert.equal(primary.resetCameraCalls, 1);
});

test("client camera authority binds initial, added, and replaced renderers before repaint", async () => {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");
  const primaryCamera = makeCamera();
  const primary = makeRenderer(1, primaryCamera);
  const underlay = makeRenderer(2, makeCamera());
  const renderers = [primary, underlay];
  const renderWindow = makeRenderWindow(renderers);
  let callbacks = null;
  let repaintCount = 0;
  let rendererExpectedAtRepaint = underlay;

  const scene = useSceneSync(
    {
      client: {},
      emit() {},
      getRenderWindow: () => renderWindow,
      renderScene() {},
      cameraAuthority: "client",
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
      }),
      createSceneEngine: (options) => {
        callbacks = options.callbacks;
        return {
          start() {},
          stop() {},
          resync() {},
          onCommand() {
            return () => {};
          },
          getDiagnostics() {
            return {};
          },
        };
      },
    },
  );
  scene.initialize({
    contextName: "multi-renderer-camera",
    renderWindowId: 1,
    onRenderNeeded() {
      assert.equal(
        rendererExpectedAtRepaint.getActiveCamera(),
        primaryCamera,
        "renderer is bound to the shared camera before repaint",
      );
      repaintCount += 1;
    },
  });

  callbacks.onSnapshotApplied({ seq: 1 });
  assert.equal(underlay.getActiveCamera(), primaryCamera);
  assert.equal(repaintCount, 1);

  const lateRenderer = makeRenderer(3, makeCamera());
  renderers.push(lateRenderer);
  rendererExpectedAtRepaint = lateRenderer;
  callbacks.onApplied({ kind: "ops", seq: 2 });
  assert.equal(lateRenderer.getActiveCamera(), primaryCamera);
  assert.equal(repaintCount, 2);

  const replacementRenderer = makeRenderer(4, makeCamera());
  renderers.splice(0, renderers.length, replacementRenderer);
  rendererExpectedAtRepaint = replacementRenderer;
  callbacks.onApplied({ kind: "ops", seq: 3 });
  assert.equal(replacementRenderer.getActiveCamera(), primaryCamera);
  assert.equal(repaintCount, 3);
});
