import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

async function loadRegistryModule() {
  return loadModule("/src/components/externalTextures.js");
}

function createMockGL() {
  let nextTexture = 1;
  const gl = {
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
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
    calls: [],
    deleted: [],
    pixelStore: {},
    createTexture() {
      const handle = { id: nextTexture++ };
      gl.calls.push(["createTexture", handle.id]);
      return handle;
    },
    deleteTexture(handle) {
      gl.deleted.push(handle.id);
    },
    bindTexture(target, handle) {
      gl.calls.push(["bindTexture", handle?.id ?? null]);
    },
    texParameteri() {},
    pixelStorei(param, value) {
      gl.pixelStore[param] = value;
    },
    texImage2D(...args) {
      gl.calls.push(["texImage2D", args]);
    },
    activeTexture() {},
  };
  return gl;
}

function uploads(gl) {
  return gl.calls.filter(([name]) => name === "texImage2D");
}

test("registry identity follows the render window", async () => {
  const { getExternalTextures } = await loadRegistryModule();
  const renderWindowA = {};
  const renderWindowB = {};

  assert.equal(
    getExternalTextures(renderWindowA),
    getExternalTextures(renderWindowA),
  );
  assert.notEqual(
    getExternalTextures(renderWindowA),
    getExternalTextures(renderWindowB),
  );
  assert.equal(getExternalTextures(null), null);
});

test("bind with no source creates a transparent placeholder once", async () => {
  const { getExternalTextures } = await loadRegistryModule();
  const registry = getExternalTextures({});
  const gl = createMockGL();

  assert.ok(registry.bindTexture("video", gl));
  // create + placeholder upload
  assert.equal(gl.calls.filter(([n]) => n === "createTexture").length, 1);
  assert.equal(uploads(gl).length, 1);
  const placeholderArgs = uploads(gl)[0][1];
  assert.equal(placeholderArgs[3], 1); // width
  assert.equal(placeholderArgs[4], 1); // height

  registry.bindTexture("video", gl);
  assert.equal(gl.calls.filter(([n]) => n === "createTexture").length, 1);
  assert.equal(uploads(gl).length, 1);
});

test("setSource uploads once on next bind with explicit unpack state", async () => {
  const { getExternalTextures } = await loadRegistryModule();
  const registry = getExternalTextures({});
  const gl = createMockGL();

  registry.bindTexture("video", gl);
  const before = uploads(gl).length;

  const canvasLike = { width: 64, height: 32 };
  registry.setSource("video", canvasLike);
  registry.bindTexture("video", gl);

  const uploaded = uploads(gl);
  assert.equal(uploaded.length, before + 1);
  // TexImageSource overload: (target, level, RGBA, RGBA, UNSIGNED_BYTE, src)
  const args = uploaded[uploaded.length - 1][1];
  assert.equal(args.length, 6);
  assert.equal(args[5], canvasLike);
  assert.equal(gl.pixelStore[gl.UNPACK_FLIP_Y_WEBGL], false);
  assert.equal(gl.pixelStore[gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL], false);

  // Applied source is not re-uploaded.
  registry.bindTexture("video", gl);
  assert.equal(uploads(gl).length, uploaded.length);
});

test("typed-array sources use the raw pixel overload with dimensions", async () => {
  const { getExternalTextures } = await loadRegistryModule();
  const registry = getExternalTextures({});
  const gl = createMockGL();

  const pixels = new Uint8Array(8 * 4 * 4);
  registry.setSource("video", pixels, { width: 8, height: 4 });
  registry.bindTexture("video", gl);

  const uploaded = uploads(gl);
  // placeholder + raw upload
  const args = uploaded[uploaded.length - 1][1];
  assert.equal(args.length, 9);
  assert.equal(args[3], 8);
  assert.equal(args[4], 4);
  assert.equal(args[8], pixels);
});

test("a changed context recreates the texture", async () => {
  const { getExternalTextures } = await loadRegistryModule();
  const registry = getExternalTextures({});
  const glA = createMockGL();
  const glB = createMockGL();

  registry.bindTexture("video", glA);
  registry.bindTexture("video", glB);

  assert.equal(glB.calls.filter(([n]) => n === "createTexture").length, 1);
  // The old handle died with its context: nothing to delete on glA.
  assert.deepEqual(glA.deleted, []);
});

test("removeKey and clear delete live GL textures", async () => {
  const { getExternalTextures } = await loadRegistryModule();
  const registry = getExternalTextures({});
  const gl = createMockGL();

  registry.bindTexture("a", gl);
  registry.bindTexture("b", gl);
  assert.equal(registry.hasSource("a"), true);

  registry.removeKey("a");
  assert.equal(registry.hasSource("a"), false);
  assert.equal(gl.deleted.length, 1);

  registry.clear();
  assert.equal(gl.deleted.length, 2);
  assert.equal(registry.describe().size, 0);
});

test("describe reports pending uploads", async () => {
  const { getExternalTextures } = await loadRegistryModule();
  const registry = getExternalTextures({});

  registry.setSource("video", { width: 640, height: 480 });
  const described = registry.describe();
  assert.equal(described.size, 1);
  assert.deepEqual(described.entries[0], {
    key: "video",
    width: 640,
    height: 480,
    needsUpload: true,
    created: false,
  });
});
