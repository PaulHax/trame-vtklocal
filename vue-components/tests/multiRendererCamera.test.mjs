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
    setViewMatrix(value) {
      this.viewMatrix = value;
    },
    setProjectionMatrix(value) {
      this.projectionMatrix = value;
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
  };
}

test("client camera authority shares one camera across renderer layers", async () => {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");
  const primaryCamera = makeCamera();
  const primary = makeRenderer(1, primaryCamera);
  const underlay = makeRenderer(2, makeCamera());
  const renderWindow = {
    getRenderers: () => [primary, underlay],
    getRenderersByReference: () => [primary, underlay],
    getViews: () => [],
  };
  const scene = useSceneSync({
    client: {},
    emit() {},
    getRenderWindow: () => renderWindow,
    renderScene() {},
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
