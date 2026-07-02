import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

const useSceneSyncRef = {};

function buildFullStateSyncHarness({ queuedStates, synchronizeResult = true }) {
  let queuedStatesBlocked = true;
  let remainingStates = queuedStates;
  let pushCallbacks = null;
  const markedStates = [];
  const emittedEvents = [];

  const scene = useSceneSyncRef.useSceneSync(
    {
      client: {},
      emit(eventName, payload) {
        emittedEvents.push({ eventName, payload });
      },
      getRenderWindow: () => ({ id: "render-window" }),
      renderScene() {},
      syncErrorLabel: "UseSceneSyncViewStateTest",
    },
    {
      createManagedSyncContext: () => ({
        synchronizerContext: { name: "sync-context" },
        syncRenderWindow: { id: "sync-render-window" },
        cleanup() {},
      }),
      withSyncCapability: () => () => synchronizeResult,
      createPushSync(
        _client,
        _syncRenderWindow,
        _syncCtx,
        _rwId,
        _pushCache,
        callbacks,
      ) {
        pushCallbacks = callbacks;
        return {
          cleanup() {},
          requestResync() {},
          getQueueLength() {
            return queuedStatesBlocked ? 1 : remainingStates.length;
          },
          takeNextMessage() {
            if (queuedStatesBlocked || !remainingStates.length) {
              return null;
            }
            const payload = remainingStates.shift();
            return { kind: "full", payload };
          },
          markMessageApplied(message) {
            markedStates.push(message.payload);
          },
        };
      },
      createSyncController() {
        return {
          async requestSync() {
            return false;
          },
        };
      },
    },
  );

  scene.initialize({
    contextName: "ctx",
    renderWindowId: 1,
    syncMode: "push",
  });

  return {
    scene,
    emittedEvents,
    unblock() {
      queuedStatesBlocked = false;
    },
    get pushCallbacks() {
      return pushCallbacks;
    },
    get markedStates() {
      return markedStates;
    },
  };
}

test("useSceneSync emits viewStateExtra only after queued push state is applied", async () => {
  const mod = await loadModule("/src/components/useSceneSync.js");
  useSceneSyncRef.useSceneSync = mod.useSceneSync;

  const fullState = {
    id: "rw",
    mtime: 1,
    extra: {
      orbitCamera: {
        center: [-90, 40],
        zoom: 8,
      },
    },
  };

  const harness = buildFullStateSyncHarness({ queuedStates: [fullState] });
  assert.ok(harness.pushCallbacks, "push sync callbacks should be captured");

  harness.pushCallbacks.onStateReceived(fullState);

  assert.deepEqual(
    harness.emittedEvents.filter(
      (event) => event.eventName === "viewStateExtra",
    ),
    [],
    "viewStateExtra should wait until the queued state is actually applied",
  );

  harness.unblock();
  const didSync = harness.scene.applyQueuedStateSync();

  assert.equal(didSync, true);
  assert.deepEqual(
    harness.emittedEvents.filter(
      (event) => event.eventName === "viewStateExtra",
    ),
    [{ eventName: "viewStateExtra", payload: fullState.extra }],
  );
  assert.deepEqual(harness.markedStates, [fullState]);
});

test("useSceneSync records rendered camera matrices before vtk camera mutation", async () => {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");

  let viewMatrixArgument = null;
  let projectionMatrixArgument = null;
  let modifiedCount = 0;
  const camera = {
    setViewMatrix(values) {
      viewMatrixArgument = values;
      values[0] = -999;
    },
    setProjectionMatrix(values) {
      projectionMatrixArgument = values;
    },
    modified() {
      modifiedCount += 1;
    },
  };
  const renderer = {
    getActiveCamera: () => camera,
    getViewport: () => [0, 0, 1, 1],
  };
  const renderWindow = {
    getRenderersByReference: () => [renderer],
    getViews: () => [{ getSize: () => [640, 480] }],
  };

  const viewMatrix = Array.from({ length: 16 }, (_value, index) => index + 1);
  const projectionMatrix = Array.from(
    { length: 16 },
    (_value, index) => 101 + index,
  );
  const scene = useSceneSync({
    client: {},
    emit() {},
    getRenderWindow: () => renderWindow,
    renderScene() {},
  });

  assert.equal(scene.setRenderedCamera({ viewMatrix, projectionMatrix }), true);
  assert.equal(modifiedCount, 1);
  assert.notEqual(viewMatrixArgument, viewMatrix);
  assert.notEqual(projectionMatrixArgument, projectionMatrix);
  assert.deepEqual(viewMatrix, Array.from({ length: 16 }, (_value, index) => index + 1));

  projectionMatrixArgument[1] = -888;
  const reported = scene.getRenderedCamera();
  assert.deepEqual(reported.viewMatrix, viewMatrix);
  assert.deepEqual(reported.projectionMatrix, projectionMatrix);
  assert.deepEqual(reported.rendererViewport, [0, 0, 1, 1]);
  assert.deepEqual(reported.size, [640, 480]);

  reported.viewMatrix[0] = -777;
  assert.deepEqual(scene.getRenderedCamera().viewMatrix, viewMatrix);
});

test("useSceneSync emits viewStateExtra when ready push state has stale mtime", async () => {
  const mod = await loadModule("/src/components/useSceneSync.js");
  useSceneSyncRef.useSceneSync = mod.useSceneSync;

  const fullState = {
    id: "rw",
    mtime: 1,
    extra: {
      orbitCamera: {
        center: [-90, 40],
        zoom: 8,
      },
    },
  };

  const harness = buildFullStateSyncHarness({
    queuedStates: [fullState],
    synchronizeResult: false,
  });
  assert.ok(harness.pushCallbacks, "push sync callbacks should be captured");

  harness.pushCallbacks.onStateReceived(fullState);
  harness.unblock();
  const didSync = harness.scene.applyQueuedStateSync();

  assert.equal(didSync, false);
  assert.deepEqual(
    harness.emittedEvents.filter(
      (event) => event.eventName === "viewStateExtra",
    ),
    [{ eventName: "viewStateExtra", payload: fullState.extra }],
  );
  // synchronizePreparedStateSync returning false is contractually a no-op
  // (e.g. stale mtime), so the ordered API consumes the envelope and advances
  // the per-client cursor. Real failures throw and don't reach mark-applied.
  assert.deepEqual(harness.markedStates, [fullState]);
});

test("useSceneSync does not emit viewStateExtra when full state has no extra", async () => {
  const mod = await loadModule("/src/components/useSceneSync.js");
  useSceneSyncRef.useSceneSync = mod.useSceneSync;

  const fullState = { id: "rw", mtime: 1 };

  const harness = buildFullStateSyncHarness({ queuedStates: [fullState] });
  harness.pushCallbacks.onStateReceived(fullState);
  harness.unblock();
  harness.scene.applyQueuedStateSync();

  assert.deepEqual(
    harness.emittedEvents.filter(
      (event) => event.eventName === "viewStateExtra",
    ),
    [],
    "viewStateExtra should not emit when state carries no extra",
  );
});

test("useSceneSync computes distance-to-camera arrays after queued full state", async () => {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");

  const pointValues = new Float32Array([0, 0, 0]);
  const points = {
    getData: () => pointValues,
    getNumberOfPoints: () => 1,
    getMTime: () => 1,
  };
  const arrays = [];
  let scalars = null;
  const pointData = {
    getArray: (name) => arrays.find((array) => array.getName?.() === name),
    getArrayByName: (name) => arrays.find((array) => array.getName?.() === name),
    getNumberOfArrays: () => arrays.length,
    getArrayByIndex: (index) => arrays[index],
    getScalars: () => scalars,
    setScalars(array) {
      scalars = array;
      if (!arrays.includes(array)) {
        arrays.push(array);
      }
    },
    addArray(array) {
      arrays.push(array);
    },
    modified() {},
  };
  const input = {
    getPoints: () => points,
    getPointData: () => pointData,
    getMTime: () => 1,
    modified() {},
  };
  let mapperInput = null;
  let scaleArray = null;
  const mapper = {
    getInputData: () => mapperInput,
    setInputData(value) {
      mapperInput = value;
    },
    setScaleArray(value) {
      scaleArray = value;
    },
    modified() {},
  };
  const instances = new Map([
    ["mapper", mapper],
    ["input", input],
  ]);
  const synchronizerContext = {
    getInstance: (id) => instances.get(String(id)),
  };
  const camera = {
    getMTime: () => 1,
    getPhysicalScale: () => 1,
    getCompositeProjectionMatrix: () => {
      const matrix = new Array(16).fill(0);
      matrix[0] = 1;
      matrix[5] = 1;
      matrix[10] = 1;
      matrix[15] = 1;
      return matrix;
    },
  };
  const renderer = {
    getActiveCamera: () => camera,
    getViewport: () => [0, 0, 1, 1],
  };
  const renderWindow = {
    getRenderersByReference: () => [renderer],
    getViews: () => [{ getSize: () => [1000, 500] }],
  };
  const fullState = {
    id: "rw",
    type: "vtkRenderWindow",
    dependencies: [
      {
        id: "mapper",
        type: "vtkGlyph3DMapper",
        distanceToCamera: {
          arrayName: "DistanceToCamera",
          screenSize: 20,
          inputDataObjectId: "input",
        },
      },
    ],
  };
  let nextMessage = { kind: "full", payload: fullState };

  const scene = useSceneSync(
    {
      client: {},
      emit() {},
      getRenderWindow: () => renderWindow,
      renderScene() {},
      syncErrorLabel: "UseSceneSyncDistanceToCameraTest",
    },
    {
      createManagedSyncContext: () => ({
        synchronizerContext,
        syncRenderWindow: { id: "sync-render-window" },
        cleanup() {},
      }),
      withSyncCapability: () => () => true,
      createPushSync() {
        return {
          cleanup() {},
          requestResync() {},
          getQueueLength() {
            return nextMessage ? 1 : 0;
          },
          takeNextMessage() {
            const message = nextMessage;
            nextMessage = null;
            return message;
          },
          markMessageApplied() {},
        };
      },
      createSyncController() {
        return {
          async requestSync() {
            return false;
          },
        };
      },
    },
  );

  scene.initialize({
    contextName: "ctx",
    renderWindowId: 1,
    syncMode: "push",
  });

  const didSync = scene.applyQueuedStateSync();

  assert.equal(didSync, true);
  assert.equal(mapperInput, input);
  assert.equal(scaleArray, "DistanceToCamera");
  assert.ok(pointData.getScalars());
  assert.equal(pointData.getScalars().getName(), "DistanceToCamera");
  assert.ok(pointData.getScalars().getData()[0] > 0);
});

test("useSceneSync keeps partial updates buffered until the full-state queue drains", async () => {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");

  const appliedStates = [];
  const appliedPartials = [];
  const readyState = { id: "rw", mtime: 1 };
  const blockedState = { id: "rw", mtime: 2 };
  const partialUpdate = { instanceId: "1", arrayPath: "points", offset: 0 };
  const syncContext = { name: "sync-context" };

  const queuedStates = [readyState, blockedState];
  let bufferedPartialUpdates = [partialUpdate];
  let blockedStateCount = 1;

  const scene = useSceneSync(
    {
      client: {},
      emit() {},
      getRenderWindow: () => ({ id: "render-window" }),
      renderScene() {},
      syncErrorLabel: "UseSceneSyncOrderingTest",
    },
    {
      createManagedSyncContext: () => ({
        synchronizerContext: syncContext,
        syncRenderWindow: { id: "sync-render-window" },
        cleanup() {},
      }),
      withSyncCapability: () => (state) => {
        appliedStates.push(state);
        return true;
      },
      createPushSync() {
        return {
          cleanup() {},
          requestResync() {},
          getQueueLength() {
            return queuedStates.length + bufferedPartialUpdates.length;
          },
          takeNextMessage() {
            const readyFullCount = Math.max(
              queuedStates.length - blockedStateCount,
              0,
            );
            if (readyFullCount > 0) {
              return { kind: "full", payload: queuedStates.shift() };
            }
            // Partial updates only become ready once the full-state queue drains.
            if (queuedStates.length) {
              return null;
            }
            if (bufferedPartialUpdates.length) {
              const updates = bufferedPartialUpdates;
              bufferedPartialUpdates = [];
              return { kind: "arrayPartial", payload: { updates } };
            }
            return null;
          },
          markMessageApplied() {},
        };
      },
      applyPartialArrayUpdate(update, ctx) {
        appliedPartials.push({ update, ctx });
        return true;
      },
      createSyncController() {
        return {
          async requestSync() {
            return false;
          },
        };
      },
    },
  );

  scene.initialize({
    contextName: "ctx",
    renderWindowId: 1,
    syncMode: "push",
  });

  const firstDidSync = scene.applyQueuedStateSync();
  assert.equal(firstDidSync, true);
  assert.deepEqual(appliedStates, [readyState]);
  assert.deepEqual(
    appliedPartials,
    [],
    "partial update should remain buffered while a newer full state is still queued",
  );

  blockedStateCount = 0;
  const didSync = scene.applyQueuedStateSync();

  assert.equal(didSync, true);
  assert.deepEqual(appliedStates, [readyState, blockedState]);
  assert.deepEqual(appliedPartials, [
    { update: partialUpdate, ctx: syncContext },
  ]);
});

test("useSceneSync applies ordered property patches and emits patch extras", async () => {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");

  const syncContext = { name: "sync-context" };
  const patchMessage = {
    kind: "patch",
    payload: {
      kind: "patch",
      ops: [
        {
          op: "setProperties",
          id: "actor",
          properties: { visibility: true },
        },
      ],
      extra: { mapCamera: { zoom: 9 } },
    },
  };
  const appliedPatches = [];
  const markedMessages = [];
  const emittedExtras = [];

  let nextMessage = patchMessage;

  const scene = useSceneSync(
    {
      client: {},
      emit(eventName, payload) {
        if (eventName === "viewStateExtra") {
          emittedExtras.push(payload);
        }
      },
      getRenderWindow: () => ({ id: "render-window" }),
      renderScene() {},
      syncErrorLabel: "UseSceneSyncPatchTest",
    },
    {
      createManagedSyncContext: () => ({
        synchronizerContext: syncContext,
        syncRenderWindow: { id: "sync-render-window" },
        cleanup() {},
      }),
      withSyncCapability: () => () => {
        throw new Error("Patch messages should not full-sync");
      },
      createPushSync() {
        return {
          cleanup() {},
          requestResync() {},
          getQueueLength() {
            return nextMessage ? 1 : 0;
          },
          takeNextMessage() {
            const message = nextMessage;
            nextMessage = null;
            return message;
          },
          markMessageApplied(message) {
            markedMessages.push(message);
          },
        };
      },
      applyPatchUpdate(patch, ctx) {
        appliedPatches.push({ patch, ctx });
        return true;
      },
      createSyncController() {
        return {
          async requestSync() {
            return false;
          },
        };
      },
    },
  );

  scene.initialize({
    contextName: "ctx",
    renderWindowId: 1,
    syncMode: "push",
  });

  const didSync = scene.applyQueuedStateSync();

  assert.equal(didSync, false);
  assert.deepEqual(appliedPatches, [
    { patch: patchMessage.payload, ctx: syncContext },
  ]);
  assert.deepEqual(emittedExtras, [patchMessage.payload.extra]);
  assert.deepEqual(markedMessages, [patchMessage]);
});

test("useSceneSync emits full-state viewStateExtra before partial viewStateExtra so newer partial extras win", async () => {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");

  const fullState = { id: "rw", mtime: 1, extra: { marker: "full" } };
  const partialUpdate = {
    instanceId: "1",
    arrayPath: "points",
    offset: 0,
    extra: { marker: "partial" },
  };
  const syncContext = { name: "sync-context" };
  const emittedExtras = [];

  let remainingStates = [fullState];
  let remainingPartials = [partialUpdate];

  const scene = useSceneSync(
    {
      client: {},
      emit(eventName, payload) {
        if (eventName === "viewStateExtra") {
          emittedExtras.push(payload);
        }
      },
      getRenderWindow: () => ({ id: "render-window" }),
      renderScene() {},
      syncErrorLabel: "UseSceneSyncOrderingExtraTest",
    },
    {
      createManagedSyncContext: () => ({
        synchronizerContext: syncContext,
        syncRenderWindow: { id: "sync-render-window" },
        cleanup() {},
      }),
      withSyncCapability: () => () => true,
      createPushSync() {
        return {
          cleanup() {},
          requestResync() {},
          getQueueLength() {
            return remainingStates.length + remainingPartials.length;
          },
          takeNextMessage() {
            if (remainingStates.length) {
              return { kind: "full", payload: remainingStates.shift() };
            }
            if (remainingPartials.length) {
              const updates = remainingPartials;
              remainingPartials = [];
              return { kind: "arrayPartial", payload: { updates } };
            }
            return null;
          },
          markMessageApplied() {},
        };
      },
      applyPartialArrayUpdate() {
        return true;
      },
      createSyncController() {
        return {
          async requestSync() {
            return false;
          },
        };
      },
    },
  );

  scene.initialize({
    contextName: "ctx",
    renderWindowId: 1,
    syncMode: "push",
  });

  scene.applyQueuedStateSync();

  assert.deepEqual(emittedExtras, [fullState.extra, partialUpdate.extra]);
});

test("useSceneSync onSceneApplied fires on applied message and unsubscribe stops it", async () => {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");

  let nextMessage = null;

  const scene = useSceneSync(
    {
      client: {},
      emit() {},
      getRenderWindow: () => ({ id: "render-window" }),
      renderScene() {},
      syncErrorLabel: "UseSceneSyncOnSceneAppliedTest",
    },
    {
      createManagedSyncContext: () => ({
        synchronizerContext: { name: "sync-context" },
        syncRenderWindow: { id: "sync-render-window" },
        cleanup() {},
      }),
      withSyncCapability: () => () => true,
      createPushSync() {
        return {
          cleanup() {},
          requestResync() {},
          getQueueLength() {
            return nextMessage ? 1 : 0;
          },
          takeNextMessage() {
            const message = nextMessage;
            nextMessage = null;
            return message;
          },
          markMessageApplied() {},
        };
      },
      createSyncController() {
        return {
          async requestSync() {
            return false;
          },
        };
      },
    },
  );

  scene.initialize({
    contextName: "ctx",
    renderWindowId: 1,
    syncMode: "push",
  });

  const appliedMessages = [];
  const unsubscribe = scene.onSceneApplied((message) => {
    appliedMessages.push(message);
  });
  assert.equal(typeof unsubscribe, "function");

  nextMessage = { kind: "full", payload: { id: "rw", mtime: 1 } };
  scene.applyQueuedStateSync();

  assert.equal(appliedMessages.length, 1);
  assert.equal(appliedMessages[0].kind, "full");

  unsubscribe();

  nextMessage = { kind: "full", payload: { id: "rw", mtime: 2 } };
  scene.applyQueuedStateSync();

  assert.equal(
    appliedMessages.length,
    1,
    "unsubscribe should stop further onSceneApplied callbacks",
  );
});
