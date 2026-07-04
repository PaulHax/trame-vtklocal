import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

// WebGL enum constants used by the policy. Values match the WebGL spec.
const GL = {
  DEPTH_BUFFER_BIT: 0x00000100,
};

// A fake GL context that records the ordered sequence of calls the policy
// makes. getParameter is instrumented so the tests can assert the policy
// never reads GL state back (each readback is a synchronous CPU/GPU stall;
// MapLibre re-establishes its own state after every custom-layer render).
function makeFakeGl() {
  const calls = [];
  return {
    ...GL,
    _calls: calls,
    getParameter(pname) {
      calls.push(["getParameter", pname]);
      return null;
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
  return loadModule("/src/components/externalRenderPolicy.js");
}

test("defaults clear the depth buffer before the render, with no readbacks", async () => {
  const { applyExternalRenderPolicy } = await loadPolicy();
  const gl = makeFakeGl();
  let rendered = false;

  applyExternalRenderPolicy(gl, () => {
    // The render runs after depth is wiped to 1.0.
    assert.deepEqual(gl._calls.at(-1), ["clear", GL.DEPTH_BUFFER_BIT]);
    rendered = true;
  });

  assert.ok(rendered);
  assert.deepEqual(gl._calls, [
    ["depthMask", true],
    ["clearDepth", 1.0],
    ["clear", GL.DEPTH_BUFFER_BIT],
  ]);
});

test("clearDepth false makes the policy a pure pass-through", async () => {
  const { applyExternalRenderPolicy } = await loadPolicy();
  const gl = makeFakeGl();
  let rendered = false;

  applyExternalRenderPolicy(
    gl,
    () => {
      rendered = true;
    },
    { clearDepth: false },
  );

  assert.ok(rendered);
  assert.deepEqual(gl._calls, []);
});

test("the policy never issues GL state readbacks", async () => {
  const { applyExternalRenderPolicy } = await loadPolicy();
  const gl = makeFakeGl();

  applyExternalRenderPolicy(gl, () => {});

  assert.deepEqual(
    gl._calls.filter(([name]) => name === "getParameter"),
    [],
  );
});

test("no gl still runs the render (no-op policy)", async () => {
  const { applyExternalRenderPolicy } = await loadPolicy();
  let rendered = false;

  applyExternalRenderPolicy(null, () => {
    rendered = true;
  });

  assert.ok(rendered);
});
