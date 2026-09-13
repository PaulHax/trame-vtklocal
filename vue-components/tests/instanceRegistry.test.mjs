import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

function liveInstance(name) {
  return { name, isDeleted: () => false };
}

test("applied records stay stable until removal and revisions track identity", async () => {
  const { createInstanceRegistry } = await loadModule(
    "/src/components/engine/instanceRegistry.js",
  );
  const registry = createInstanceRegistry();
  const first = liveInstance("first");
  const replacement = liveInstance("replacement");

  const record = registry.beginDesired("7", "vtkFirst");
  assert.equal("desiredType" in record, false);
  registry.register("7", first, "vtkFirst");
  registry.markLive("7", "vtkFirst");
  assert.equal(record.revision, 1);
  assert.equal(registry.instanceRevision(), 1);

  registry.register("7", first, "vtkFirst");
  registry.markLive("7", "vtkFirst");
  assert.equal(
    record.revision,
    1,
    "registering the same instance is not revision noise",
  );

  registry.beginDesired("7", "vtkReplacement");
  assert.equal(record.status, "pending");
  registry.register("7", replacement, "vtkReplacement");
  registry.markLive("7", "vtkReplacement");
  assert.equal(registry.getRecord(7), record);
  assert.equal(record.revision, 2);
  assert.equal(record.instance, replacement);
  assert.equal(registry.getInstance(7), replacement);
  assert.equal(registry.getInstanceId(replacement), "7");
  assert.equal(
    registry.getInstanceId(first),
    null,
    "a replaced instance no longer resolves to the id",
  );

  registry.remove("7");
  assert.equal(registry.getRecord("7"), null);
  assert.equal(record.revision, 3);
  assert.equal(record.instance, null);
  assert.equal(record.status, "removed");
  assert.equal(record.appliedType, null);
  assert.equal(registry.getInstanceId(replacement), null);

  const recreated = registry.beginDesired("7", "vtkReplacement");
  registry.register("7", replacement, "vtkReplacement");
  registry.markLive("7", "vtkReplacement");
  assert.notEqual(recreated, record);
  assert.equal(registry.getRecord("7"), recreated);
  assert.equal(recreated.revision, 1);
  assert.equal(registry.instanceRevision(), 4);
});

test("applied diagnostics omit desired state and raw instances", async () => {
  const { createInstanceRegistry } = await loadModule(
    "/src/components/engine/instanceRegistry.js",
  );
  const registry = createInstanceRegistry();
  const record = registry.markPending(
    "late",
    "vtkUnavailable",
    "cannot build type vtkUnavailable",
  );

  assert.deepEqual(registry.describe(), {
    instanceRevision: 0,
    records: [
      {
        id: "late",
        appliedType: null,
        revision: 0,
        status: "pending",
        pendingReason: "cannot build type vtkUnavailable",
        live: false,
      },
    ],
  });

  registry.clear();
  assert.equal(record.instance, null);
  assert.equal(record.status, "removed");
  assert.deepEqual(registry.describe().records, []);
});
