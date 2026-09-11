import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeModuleLoader, loadModule } from "./loadModule.mjs";
after(closeModuleLoader);

test("candidate visibility, opacity and membership determine texture dependencies", async () => {
  const { textureGraphAfter, requiredTextures } = await loadModule(
    "/src/components/engine/textureRequirements.js",
  );
  const nodes = {
    1: { type: "vtkRenderWindow", refs: { renderers: [2] } },
    2: { type: "vtkRenderer", refs: { viewProps: [3] } },
    3: {
      type: "vtkActor",
      props: { visibility: 0 },
      refs: { mapper: 4, property: 5 },
    },
    4: {
      type: "vtkProjectedTextureMapper",
      blocks: { projectedTexture: { textureKey: "video" } },
    },
    5: { type: "vtkProperty", props: { opacity: 1 } },
  };
  const hidden = textureGraphAfter(new Map(), { nodes }, true);
  assert.deepEqual([...requiredTextures(hidden, "1")], []);
  const visible = textureGraphAfter(hidden, {
    ops: [
      { op: "upsert", id: 3, node: { ...nodes[3], props: { visibility: 1 } } },
    ],
  });
  assert.deepEqual([...requiredTextures(visible, "1")], ["video"]);
  assert.deepEqual(
    [...requiredTextures(hidden, "1")],
    [],
    "candidate does not mutate the applied scene",
  );
  const transparent = textureGraphAfter(visible, {
    ops: [
      { op: "upsert", id: 5, node: { ...nodes[5], props: { opacity: 0 } } },
    ],
  });
  assert.deepEqual([...requiredTextures(transparent, "1")], []);
  const removed = textureGraphAfter(visible, {
    ops: [
      { op: "upsert", id: 2, node: { ...nodes[2], refs: { viewProps: [] } } },
    ],
  });
  assert.deepEqual([...requiredTextures(removed, "1")], []);
  assert.equal(
    textureGraphAfter(visible, { ops: [{ op: "patchArray", id: 99 }] }),
    visible,
  );
});
