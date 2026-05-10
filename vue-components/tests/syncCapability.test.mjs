import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

function createRenderWindowStub() {
  let synchronizedViewId = null;
  const propertySets = [];

  return {
    propertySets,
    set(values) {
      if (Object.hasOwn(values, "synchronizedViewId")) {
        synchronizedViewId = values.synchronizedViewId;
        return;
      }
      propertySets.push(values);
    },
    get(name) {
      if (name === "synchronizedViewId") {
        return { synchronizedViewId };
      }
      return {};
    },
    render() {},
  };
}

test("prepared push states apply even when root mtime is unchanged", async () => {
  const { withSyncCapability } = await loadModule(
    "/src/components/sync/syncCapability.js",
  );

  const renderWindow = createRenderWindowStub();
  const context = {
    setActiveViewId() {},
    incrementMTime() {},
  };

  const synchronize = withSyncCapability(renderWindow, context, {}, new Map());

  const firstState = {
    id: "rw",
    mtime: 1,
    properties: { marker: "first" },
  };
  const secondState = {
    id: "rw",
    mtime: 1,
    properties: { marker: "second" },
  };

  assert.equal(synchronize(firstState, true), true);
  assert.equal(synchronize(secondState, true), true);
  assert.deepEqual(renderWindow.propertySets, [
    { marker: "first" },
    { marker: "second" },
  ]);
});

test("walkArrayDescriptors visits descriptors but not their content", async () => {
  const { walkArrayDescriptors } = await loadModule(
    "/src/components/sync/walk.js",
  );

  const descriptors = [];
  const objects = [];
  const state = {
    id: "rw",
    type: "vtkRenderWindow",
    properties: {
      points: {
        hash: "h-points",
        dataType: "Float32Array",
        // simulate a binary content payload — must not be descended into
        content: new Uint8Array([1, 2, 3]).buffer,
      },
      list: [
        { hash: "h-nested", dataType: "Uint16Array" },
      ],
    },
    dependencies: [
      { id: "child", type: "vtkActor" },
    ],
  };

  walkArrayDescriptors(state, {
    onObject(value) {
      objects.push(value.id ?? "(no id)");
    },
    onDescriptor(d) {
      descriptors.push(d.hash);
    },
  });

  assert.deepEqual(descriptors.sort(), ["h-nested", "h-points"]);
  assert.ok(objects.includes("rw"));
  assert.ok(objects.includes("child"));
});


test("createDataSetUpdateSync does not mutate the input state", async () => {
  const { createDataSetUpdateSync } = await loadModule(
    "/src/components/sync/syncUpdaters.js",
  );

  const updater = createDataSetUpdateSync(["points"]);

  const fakeFieldData = {
    getNumberOfArrays: () => 0,
    getArrays: () => [],
    removeArray() {},
  };
  const instance = {
    getPointData: () => fakeFieldData,
    getCellData: () => fakeFieldData,
    set() {
      return true;
    },
    getReferenceByName: () => null,
  };

  const pointsMeta = {
    hash: "points-hash",
    dataType: "Float32Array",
    numberOfComponents: 3,
    size: 3,
  };
  const state = Object.freeze({
    id: "polydata",
    type: "vtkPolyData",
    properties: Object.freeze({
      points: pointsMeta,
      fields: Object.freeze([]),
    }),
  });

  const stateSnapshot = JSON.parse(JSON.stringify(state));

  const pushCache = new Map([
    ["points-hash", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])],
  ]);
  // Even if the underlying genericUpdaterSync throws (no real vtk instance),
  // the input state must not have been mutated up to the point of failure.
  try {
    updater(
      instance,
      state,
      { setActiveViewId() {}, incrementMTime() {} },
      null,
      pushCache,
    );
  } catch (_err) {
    // expected - we only care that the input wasn't mutated
  }

  assert.deepEqual(JSON.parse(JSON.stringify(state)), stateSnapshot);
  assert.equal(state.arrays, undefined);
  assert.equal(pointsMeta.registration, undefined);
});


test("array validation finds descriptors nested in arbitrary state objects", async () => {
  const { allArraysHaveInlineData } = await loadModule(
    "/src/components/sync/syncCapability.js",
  );

  const state = {
    id: "rw",
    properties: {
      custom: {
        arbitrary: {
          payload: {
            hash: "nested-hash",
            dataType: "Float32Array",
            numberOfComponents: 3,
            size: 3,
          },
        },
      },
    },
  };

  assert.equal(allArraysHaveInlineData(state, new Map()), false);
  assert.equal(
    allArraysHaveInlineData(
      state,
      new Map([["nested-hash", new Float32Array([1, 2, 3])]]),
    ),
    true,
  );
});
