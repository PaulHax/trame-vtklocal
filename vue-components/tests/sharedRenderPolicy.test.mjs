import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

// WebGL enum constants used by the policy. Values match the WebGL spec.
const GL = {
  FRONT_FACE: 0x0b46,
  CW: 0x0900,
  CCW: 0x0901,
  DEPTH_BUFFER_BIT: 0x00000100,
};

// A fake GL context that records the ordered sequence of calls the policy
// makes, and reports a host-owned starting winding via getParameter.
function makeFakeGl(initialFrontFace = GL.CCW) {
  const calls = [];
  return {
    ...GL,
    _calls: calls,
    getParameter(pname) {
      calls.push(["getParameter", pname]);
      if (pname === GL.FRONT_FACE) return initialFrontFace;
      return null;
    },
    frontFace(mode) {
      calls.push(["frontFace", mode]);
    },
    depthMask(flag) {
      calls.push(["depthMask", flag]);
    },
    clearDepth(depth) {
      calls.push(["clearDepth", depth]);
    },
    clear(mask) {
      calls.push(["clear", mask]);
    },
  };
}

async function loadPolicy() {
  return loadModule("/src/components/sharedRenderPolicy.js");
}

test("defaults clear the depth buffer and set CW winding, then restore host winding", async () => {
  const { applySharedRenderPolicy } = await loadPolicy();
  const gl = makeFakeGl(GL.CCW);
  let rendered = false;

  applySharedRenderPolicy(gl, () => {
    // The render runs after depth is cleared and before winding is restored.
    assert.deepEqual(gl._calls.at(-1), ["clear", GL.DEPTH_BUFFER_BIT]);
    rendered = true;
  });

  assert.ok(rendered);
  // Winding is set to CW before the render and restored to the host's original
  // CCW afterward; depth is wiped to 1.0 before the render.
  assert.deepEqual(gl._calls, [
    ["getParameter", GL.FRONT_FACE],
    ["frontFace", GL.CW],
    ["depthMask", true],
    ["clearDepth", 1.0],
    ["clear", GL.DEPTH_BUFFER_BIT],
    ["frontFace", GL.CCW],
  ]);
});

test("clearDepth false skips the depth wipe but still manages winding", async () => {
  const { applySharedRenderPolicy } = await loadPolicy();
  const gl = makeFakeGl(GL.CCW);
  let rendered = false;

  applySharedRenderPolicy(gl, () => {
    rendered = true;
  }, { clearDepth: false });

  assert.ok(rendered);
  assert.deepEqual(gl._calls, [
    ["getParameter", GL.FRONT_FACE],
    ["frontFace", GL.CW],
    ["frontFace", GL.CCW],
  ]);
});

test("frontFace 'CCW' sets counter-clockwise winding for the render", async () => {
  const { applySharedRenderPolicy } = await loadPolicy();
  const gl = makeFakeGl(GL.CW);

  applySharedRenderPolicy(gl, () => {}, { frontFace: "CCW" });

  assert.deepEqual(gl._calls, [
    ["getParameter", GL.FRONT_FACE],
    ["frontFace", GL.CCW],
    ["depthMask", true],
    ["clearDepth", 1.0],
    ["clear", GL.DEPTH_BUFFER_BIT],
    ["frontFace", GL.CW],
  ]);
});

test("falsy frontFace leaves host winding untouched (no getParameter/frontFace)", async () => {
  const { applySharedRenderPolicy } = await loadPolicy();
  const gl = makeFakeGl(GL.CCW);

  applySharedRenderPolicy(gl, () => {}, { frontFace: null });

  assert.deepEqual(gl._calls, [
    ["depthMask", true],
    ["clearDepth", 1.0],
    ["clear", GL.DEPTH_BUFFER_BIT],
  ]);
});

test("host winding is restored even if the render throws", async () => {
  const { applySharedRenderPolicy } = await loadPolicy();
  const gl = makeFakeGl(GL.CCW);

  assert.throws(() =>
    applySharedRenderPolicy(gl, () => {
      throw new Error("boom");
    }),
  );

  // Last call restores the host's original winding.
  assert.deepEqual(gl._calls.at(-1), ["frontFace", GL.CCW]);
});

test("no gl still runs the render (no-op policy)", async () => {
  const { applySharedRenderPolicy } = await loadPolicy();
  let rendered = false;

  applySharedRenderPolicy(null, () => {
    rendered = true;
  });

  assert.ok(rendered);
});
