import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadModule, closeModuleLoader } from "./loadModule.mjs";

after(closeModuleLoader);

async function setup() {
  const { bindArrayEntry } = await loadModule(
    "/src/components/engine/arrayBinding.js",
  );
  const { default: vtkPolyData } = await loadModule(
    "@kitware/vtk.js/Common/DataModel/PolyData",
  );
  const dataset = vtkPolyData.newInstance();
  const entry = {
    ref: "c:probe",
    dataType: "Float32Array",
    size: 6,
    name: "probe",
    location: "pointData",
    numberOfComponents: 1,
  };
  return {
    bindArrayEntry,
    dataset,
    entry,
    values: new Float32Array([1, 2, 3, 4, 5, 6]),
  };
}

test("existing field arrays can become and cease being active without new bytes", async () => {
  const { bindArrayEntry, dataset, entry, values } = await setup();
  const array = bindArrayEntry(dataset, entry, values);
  const active = { ...entry, registration: "setScalars" };
  bindArrayEntry(dataset, active, values, entry);
  assert.equal(dataset.getPointData().getScalars(), array);
  bindArrayEntry(dataset, entry, values, active);
  assert.equal(dataset.getPointData().getScalars(), null);
  assert.equal(dataset.getPointData().getArray("probe"), array);
});

test("metadata-only component changes update the existing vtk array", async () => {
  const { bindArrayEntry, dataset, entry, values } = await setup();
  const array = bindArrayEntry(dataset, entry, values);
  bindArrayEntry(dataset, { ...entry, numberOfComponents: 3 }, values, entry);
  assert.equal(array.getNumberOfComponents(), 3);
  assert.equal(array.getNumberOfTuples(), 2);
});

test("demotion cannot clear a sibling assigned earlier in the same pass", async () => {
  const { bindArrayEntry, dataset, entry, values } = await setup();
  const active = { ...entry, registration: "setScalars" };
  bindArrayEntry(dataset, active, values);
  const second = bindArrayEntry(
    dataset,
    { ...active, name: "second" },
    values.slice(),
  );
  bindArrayEntry(dataset, entry, values, active);
  assert.equal(dataset.getPointData().getScalars(), second);
});
