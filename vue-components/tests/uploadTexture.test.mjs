import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

function createMockGL() {
  let nextTexture = 1;
  const gl = {
    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812f,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    deleted: [],
    createTexture() {
      return { id: nextTexture++ };
    },
    deleteTexture(handle) {
      gl.deleted.push(handle.id);
    },
    bindTexture() {},
    texParameteri() {},
    pixelStorei() {},
    texImage2D() {},
  };
  return gl;
}

async function buildScene(renderWindow) {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");
  const scene = useSceneSync(
    {
      client: {},
      emit() {},
      getRenderWindow: () => renderWindow,
      renderScene() {},
      syncErrorLabel: "UploadTextureTest",
    },
    {
      createManagedSyncContext: () => ({
        synchronizerContext: { getInstance: () => null },
        syncRenderWindow: { id: "sync-render-window" },
        cleanup() {},
      }),
      withSyncCapability: () => () => true,
      createPushSync() {
        return {
          cleanup() {},
          requestResync() {},
          getQueueLength() {
            return 0;
          },
          takeNextMessage() {
            return null;
          },
          markMessageApplied() {},
        };
      },
      createSyncController() {
        return {
          async requestSync() {
            return false;
          },
        };
      },
    },
  );
  scene.initialize({ contextName: "ctx", renderWindowId: 1 });
  return scene;
}

test("uploadTexture stages a source in the view's registry", async () => {
  const { getExternalTextures } = await loadModule(
    "/src/components/externalTextures.js",
  );
  const renderWindow = { id: "rw-upload" };
  const scene = await buildScene(renderWindow);

  assert.equal(scene.uploadTexture("video", { width: 640, height: 480 }), true);

  const described = getExternalTextures(renderWindow).describe();
  assert.equal(described.size, 1);
  assert.equal(described.entries[0].key, "video");
  assert.equal(described.entries[0].needsUpload, true);

  assert.equal(scene.uploadTexture(null, {}), false);
});

test("uploadTexture without a render window reports failure", async () => {
  const scene = await buildScene(null);
  assert.equal(scene.uploadTexture("video", { width: 2, height: 2 }), false);
});

test("cleanup deletes the view's GL textures", async () => {
  const { getExternalTextures } = await loadModule(
    "/src/components/externalTextures.js",
  );
  const renderWindow = { id: "rw-cleanup" };
  const scene = await buildScene(renderWindow);
  const gl = createMockGL();

  scene.uploadTexture("video", { width: 4, height: 4 });
  getExternalTextures(renderWindow).bindTexture("video", gl);

  scene.cleanup();

  assert.equal(gl.deleted.length, 1);
  assert.equal(getExternalTextures(renderWindow).describe().size, 0);
});

test("sync diagnostics report the external textures", async () => {
  const renderWindow = { id: "rw-diagnostics" };
  const scene = await buildScene(renderWindow);

  assert.deepEqual(scene.getSyncDiagnostics().externalTextures, {
    size: 0,
    entries: [],
  });

  scene.uploadTexture("video", { width: 8, height: 8 });
  const described = scene.getSyncDiagnostics().externalTextures;
  assert.equal(described.size, 1);
  assert.equal(described.entries[0].key, "video");
});
