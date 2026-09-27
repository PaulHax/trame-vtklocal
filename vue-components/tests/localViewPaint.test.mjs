// VtkJsLocal owns its canvas and its vtk.js interactor. During a camera drag
// the interactor paints each animation frame itself, and it ignores render
// requests until the drag ends, so every paint the view makes must carry its
// own pre-render pass and be the only thing that reports a completed paint.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRenderer } from "vue";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

function fakeElement(tagName) {
  return {
    tagName,
    style: {},
    children: [],
    parentNode: null,
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child);
      child.parentNode = null;
      return child;
    },
    contains(child) {
      return this.children.includes(child);
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
  };
}

const renderer = createRenderer({
  createElement: fakeElement,
  createText: (text) => ({ text }),
  createComment: (text) => ({ text }),
  setText() {},
  setElementText() {},
  insert(child, parent) {
    parent.appendChild(child);
  },
  remove(child) {
    child.parentNode?.removeChild(child);
  },
  parentNode: (node) => node.parentNode,
  nextSibling: () => null,
  patchProp() {},
});

function fakeClient() {
  const session = {
    subscribe: () => ({}),
    unsubscribe() {},
    call: () => new Promise(() => {}),
  };
  return { getConnection: () => ({ getSession: () => session }) };
}

test("the owned-canvas view prepares every frame it paints, and only those", async () => {
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.document = {
    createElement: fakeElement,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.Image = class {
    style = {};
  };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  const { default: vtkForwardPass } = await loadModule(
    "/node_modules/@kitware/vtk.js/Rendering/OpenGL/ForwardPass.js",
  );
  const { default: VtkJsLocal } = await loadModule(
    "/src/components/VtkJsLocal.js",
  );

  // A recording pass stands in for the GL draw. It notes whether the view had
  // prepared a frame that no completed paint has claimed yet.
  let view = null;
  const paints = [];
  const recordingPass = {
    traverse() {
      const rendering = view?.getSyncDiagnostics().rendering;
      if (!rendering) return;
      paints.push(
        rendering.preparedFrameSerial > rendering.completedPreparedFrameSerial,
      );
    },
    isDeleted: () => false,
  };
  const newForwardPass = vtkForwardPass.newInstance;
  vtkForwardPass.newInstance = () => recordingPass;
  try {
    const app = renderer.createApp(VtkJsLocal, { renderWindow: 1 });
    app.provide("trame", { client: fakeClient() });
    view = app.mount(fakeElement("root"));
    const interactor = view.getRenderWindow().getInteractor();
    const completed = [];
    view.onPaintCompleted((event) => completed.push(event.frameSerial));

    paints.length = 0;
    view.render();
    assert.deepEqual(paints, [true]);
    assert.equal(completed.length, 1);

    interactor.requestAnimation("drag");
    for (let frame = 0; frame < 3; frame += 1) {
      interactor.handleAnimation();
    }
    assert.deepEqual(
      paints,
      [true, true, true, true],
      "every drag frame is prepared before it paints",
    );
    assert.equal(completed.length, 4, "every drag frame completes a paint");

    view.render();
    assert.equal(paints.length, 4, "the interactor owns painting mid-drag");
    assert.equal(
      completed.length,
      4,
      "a render request the interactor ignored completes no paint",
    );

    interactor.cancelAnimation("drag");
    app.unmount();
  } finally {
    vtkForwardPass.newInstance = newForwardPass;
  }
});
