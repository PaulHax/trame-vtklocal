import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";
import { createSession, mountScene } from "./sceneHarness.mjs";

after(async () => {
  await closeModuleLoader();
});

const pointsBlob = (values) =>
  new Uint8Array(new Float32Array(values).buffer.slice(0));

const pointsNode = (ref) => ({
  type: "vtkPolyData",
  arrays: {
    points: {
      ref,
      dataType: "Float32Array",
      size: 3,
      numberOfComponents: 3,
      registration: "setPoints",
      vtkClass: "vtkPoints",
    },
  },
});

const PICKABLE = { pickable: { grabPx: 8, preview: "screen" } };

function boundPoints(scene, nodeId) {
  const { content } = scene.getAppliedSceneState().nodes[nodeId].arrays.points;
  const bytes = Buffer.from(content, "base64");
  return Array.from(
    new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
  );
}

// A drag preview writes into the rendered points array. The array a pickable
// previews must not be the blob cache's copy, or the preview leaks into every
// node that later binds the same blob.
test("a rebuilt pickable mapper's preview points stay out of the blob cache", async () => {
  const { default: vtkRenderWindow } = await loadModule(
    "/node_modules/@kitware/vtk.js/Rendering/Core/RenderWindow.js",
  );
  const renderWindow = vtkRenderWindow.newInstance();
  const session = createSession({
    seq: 1,
    nodes: {
      1: { type: "vtkRenderWindow", refs: { renderers: ["2"] } },
      2: { type: "vtkRenderer", refs: { viewProps: ["actor"] } },
      actor: { type: "vtkActor", refs: { mapper: "mapper" } },
      mapper: {
        type: "vtkGlyph3DMapper",
        refs: { inputs: ["points"] },
        blocks: PICKABLE,
      },
      points: pointsNode("c:first"),
    },
    blobs: { "c:first": pointsBlob([0, 0, 0]) },
  });
  const { scene } = await mountScene({
    session,
    getRenderWindow: () => renderWindow,
  });

  // The server replaces the mapper with a new type drawing new points.
  session.broadcast({
    ops: [
      { op: "upsert", id: "rebuilt", node: pointsNode("c:second") },
      {
        op: "upsert",
        id: "mapper",
        node: {
          type: "vtkMapper",
          refs: { inputs: ["rebuilt"] },
          blocks: PICKABLE,
        },
      },
      { op: "remove", id: "points" },
    ],
    blobs: { "c:second": pointsBlob([1, 2, 3]) },
  });
  const actor = renderWindow.getRenderers()[0].getViewProps()[0];
  const previewed = actor.getMapper().getInputData().getPoints().getData();
  previewed[0] = 99;

  // A node arriving later binds the same blob from the client's cache.
  session.broadcast({
    ops: [{ op: "upsert", id: "later", node: pointsNode("c:second") }],
  });

  assert.deepEqual(boundPoints(scene, "rebuilt"), [99, 2, 3]);
  assert.deepEqual(boundPoints(scene, "later"), [1, 2, 3]);
  scene.cleanup();
});
