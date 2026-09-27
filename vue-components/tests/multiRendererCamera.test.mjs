import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";
import { createSession, mountScene } from "./sceneHarness.mjs";

after(async () => {
  await closeModuleLoader();
});

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const rendererNode = (layer) => ({ type: "vtkRenderer", props: { layer } });
const rootNode = (renderers) => ({
  type: "vtkRenderWindow",
  refs: { renderers },
});

async function newRenderWindow() {
  const { default: vtkRenderWindow } = await loadModule(
    "/node_modules/@kitware/vtk.js/Rendering/Core/RenderWindow.js",
  );
  return vtkRenderWindow.newInstance();
}

test("the view shares one client camera across renderer layers", async () => {
  const renderWindow = await newRenderWindow();
  const session = createSession({
    seq: 1,
    nodes: {
      1: rootNode(["2", "3"]),
      2: rendererNode(0),
      3: rendererNode(1),
    },
  });
  const { scene } = await mountScene({
    session,
    getRenderWindow: () => renderWindow,
  });
  const [primary, underlay] = renderWindow.getRenderers();

  const projectionMatrix = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1];
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(
      scene.setRenderedCamera({ viewMatrix: IDENTITY, projectionMatrix }),
      true,
    );
  } finally {
    console.warn = warn;
  }

  assert.equal(scene.getRenderer(), primary);
  assert.equal(underlay.getActiveCamera(), primary.getActiveCamera());
  assert.deepEqual(
    Array.from(primary.getActiveCamera().getViewMatrix()),
    IDENTITY,
  );
  assert.deepEqual(
    scene.getRenderedCamera().projectionMatrix,
    projectionMatrix,
  );
  scene.cleanup();
});

test("the client camera binds initial, added, and replaced renderers before repaint", async () => {
  const renderWindow = await newRenderWindow();
  const session = createSession({
    seq: 1,
    nodes: {
      1: rootNode(["2", "3"]),
      2: rendererNode(0),
      3: rendererNode(1),
    },
  });
  let repaintCount = 0;
  const sharesOneCamera = () => {
    const [primary, ...siblings] = renderWindow.getRenderers();
    return siblings.every(
      (sibling) => sibling.getActiveCamera() === primary.getActiveCamera(),
    );
  };
  const { scene } = await mountScene({
    session,
    getRenderWindow: () => renderWindow,
    onRenderNeeded() {
      assert.ok(
        sharesOneCamera(),
        "every renderer is bound to the shared camera before repaint",
      );
      repaintCount += 1;
    },
  });
  assert.equal(repaintCount, 1);
  const clientCamera = renderWindow.getRenderers()[0].getActiveCamera();

  session.broadcast({
    ops: [
      { op: "upsert", id: "4", node: rendererNode(2) },
      { op: "upsert", id: "1", node: rootNode(["2", "3", "4"]) },
    ],
  });
  assert.equal(renderWindow.getRenderers().length, 3);
  assert.equal(repaintCount, 2);

  session.broadcast({
    ops: [
      { op: "upsert", id: "5", node: rendererNode(0) },
      { op: "upsert", id: "1", node: rootNode(["5"]) },
      { op: "remove", id: "2" },
      { op: "remove", id: "3" },
      { op: "remove", id: "4" },
    ],
  });
  const [replacement] = renderWindow.getRenderers();
  assert.equal(renderWindow.getRenderers().length, 1);
  assert.equal(replacement.getActiveCamera(), clientCamera);
  assert.equal(repaintCount, 3);
  scene.cleanup();
});
