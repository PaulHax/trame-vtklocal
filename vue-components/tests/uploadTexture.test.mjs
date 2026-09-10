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

async function buildScene(renderWindow, onEngineReady = () => {}) {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");
  const scene = useSceneSync(
    {
      client: {},
      emit() {},
      getRenderWindow: () => renderWindow,
      renderScene() {},
    },
    {
      createManagedSyncContext: () => ({
        synchronizerContext: { getInstance: () => null },
        syncRenderWindow: { id: "sync-render-window" },
        cleanup() {},
      }),
      createReconciler: () => ({
        registerBlockHandler() {
          return () => {};
        },
        teardown() {},
      }),
      createSceneEngine: ({ callbacks }) => {
        onEngineReady(callbacks);
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

test("paint completion names the texture consumed, not a newer staged source", async () => {
  const { getExternalTextures } = await loadModule(
    "/src/components/externalTextures.js",
  );
  const renderWindow = {};
  const scene = await buildScene(renderWindow);
  const registry = getExternalTextures(renderWindow);
  const events = [];
  const detach = scene.onPaintCompleted((event) => events.push(event));
  scene.uploadTexture("video", { width: 2, height: 2 }, { token: "first" });
  assert.equal(events.length, 0);
  scene.beforeRender();
  registry.bindTexture("video", createMockGL());
  scene.uploadTexture("video", { width: 2, height: 2 }, { token: "second" });
  scene.recordPaintDuration(1);
  assert.deepEqual(events[0].textures, [{ key: "video", token: "first" }]);
  scene.beforeRender();
  scene.recordPaintDuration(1);
  assert.deepEqual(events[1].textures, []);
  detach();
  scene.recordPaintDuration(1);
  assert.equal(events.length, 2);
});

test("removeTexture releases only the named view texture", async () => {
  const { getExternalTextures } = await loadModule(
    "/src/components/externalTextures.js",
  );
  const renderWindow = { id: "rw-remove" };
  const scene = await buildScene(renderWindow);
  const gl = createMockGL();
  const registry = getExternalTextures(renderWindow);

  scene.uploadTexture("video-a", { width: 4, height: 4 });
  scene.uploadTexture("video-b", { width: 8, height: 8 });
  registry.bindTexture("video-a", gl);
  registry.bindTexture("video-b", gl);

  assert.equal(scene.removeTexture("video-a"), true);
  assert.deepEqual(
    registry.describe().entries.map(({ key }) => key),
    ["video-b"],
  );
  assert.equal(gl.deleted.length, 1);
  assert.equal(scene.removeTexture(null), false);
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

test("retiring a frame identity preserves live siblings and clears replay state", async () => {
  let command;
  let beforeSnapshot;
  const scene = await buildScene({ id: "rw-identities" }, (callbacks) => {
    command = callbacks.onCommand;
    beforeSnapshot = callbacks.beforeSnapshot;
  });
  const live = { slot_id: "b", frame_id: 20, seq: 2 };
  command("video.frame.a", { slot_id: "a", frame_id: 10, seq: 1 });
  command("video.frame.b", live);
  command("video.frame.a", null);
  assert.equal(scene.getAppliedCommand("video.frame.a"), undefined);
  assert.deepEqual(scene.getAppliedCommand("video.frame.b"), live);
  // A reconnect snapshot replaces the retained command set, including when
  // the client missed the removal command while disconnected.
  beforeSnapshot();
  assert.equal(scene.getAppliedCommand("video.frame.b"), undefined);
  command("video.frame.b", live);
  scene.cleanup();
  assert.equal(scene.getAppliedCommand("video.frame.b"), undefined);
});
