import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

test("camera props defer during interaction and latest server state wins at end", async () => {
  const { createReconciler } = await loadModule(
    "/src/components/engine/reconcile.js",
  );
  const { createMirrorStore } = await loadModule(
    "/src/components/engine/mirrorStore.js",
  );
  const applied = [];
  const camera = {
    set: (props) => applied.push({ ...props }),
    isDeleted: () => false,
  };
  const instances = new Map([["camera", camera]]);
  let interacting = false;
  const reconciler = createReconciler({
    buildInstance: (_type, id) => instances.get(String(id)) ?? null,
    rootId: "root",
    rootInstance: null,
    shouldDeferProps: (_id, node) => interacting && node.type === "vtkCamera",
  });
  const mirror = createMirrorStore();
  mirror.applyOp({
    op: "upsert",
    id: "camera",
    node: { type: "vtkCamera", props: { parallelScale: 1 } },
  });

  interacting = true;
  reconciler.applyMessage(
    [
      {
        op: "upsert",
        id: "camera",
        node: { type: "vtkCamera", props: { parallelScale: 2 } },
      },
    ],
    mirror,
    new Map(),
  );
  reconciler.applyMessage(
    [
      {
        op: "upsert",
        id: "camera",
        node: { type: "vtkCamera", props: { parallelScale: 3 } },
      },
    ],
    mirror,
    new Map(),
  );

  assert.deepEqual(applied, []);
  assert.equal(mirror.get("camera").props.parallelScale, 3);

  interacting = false;
  reconciler.flushDeferredProps();
  assert.deepEqual(applied, [{ parallelScale: 3 }]);
});
