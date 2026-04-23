import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

test("useSceneSync applies immediate partial updates from pushSync", async () => {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");

  const appliedPartials = [];
  const partialAppliedEvents = [];
  const partialUpdate = { instanceId: "1", arrayPath: "points", offset: 0 };
  const syncContext = { name: "sync-context" };
  let resyncCount = 0;

  const sync = {
    cleanup() {},
    requestResync() {
      resyncCount += 1;
    },
    getQueueLength() {
      return 0;
    },
    drainReadyStates() {
      return [];
    },
    drainReadyPartialUpdates() {
      return [];
    },
  };

  let pushCallbacks = null;

  const scene = useSceneSync(
    {
      client: {},
      emit() {},
      getRenderWindow: () => ({ id: "render-window" }),
      renderScene() {},
      syncErrorLabel: "UseSceneSyncTest",
    },
    {
      createManagedSyncContext: () => ({
        synchronizerContext: syncContext,
        syncRenderWindow: { id: "sync-render-window" },
        cleanup() {},
      }),
      withSyncCapability: () => ({
        synchronizeSync() {
          return true;
        },
        updateGarbageCollectorThreshold() {},
      }),
      createPushSync(_client, _syncRenderWindow, _syncCtx, _rwId, callbacks) {
        pushCallbacks = callbacks;
        return sync;
      },
      createPullSync() {
        throw new Error("Pull sync should not be used in this test");
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
    onPartialApplied(update, ctx, applied) {
      partialAppliedEvents.push({ update, ctx, applied });
    },
  });

  assert.ok(pushCallbacks, "push sync callbacks should be captured");

  pushCallbacks.onPartialUpdate(partialUpdate, syncContext);

  assert.equal(resyncCount, 0);
  assert.deepEqual(appliedPartials, [{ update: partialUpdate, ctx: syncContext }]);
  assert.deepEqual(partialAppliedEvents, [
    { update: partialUpdate, ctx: syncContext, applied: true },
  ]);
});

test("useSceneSync emits viewStateChange only after queued push state is applied", async () => {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");

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

  let queuedStatesBlocked = true;
  let queuedStates = [fullState];
  let pushCallbacks = null;
  const emittedEvents = [];

  const scene = useSceneSync(
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
      withSyncCapability: () => ({
        synchronizeSync() {
          return true;
        },
        updateGarbageCollectorThreshold() {},
      }),
      createPushSync(_client, _syncRenderWindow, _syncCtx, _rwId, callbacks) {
        pushCallbacks = callbacks;
        return {
          cleanup() {},
          requestResync() {},
          getQueueLength() {
            return queuedStatesBlocked ? 1 : queuedStates.length;
          },
          drainReadyStates() {
            if (queuedStatesBlocked) {
              return [];
            }
            const readyStates = queuedStates;
            queuedStates = [];
            return readyStates;
          },
          drainReadyPartialUpdates() {
            return [];
          },
        };
      },
      createPullSync() {
        throw new Error("Pull sync should not be used in this test");
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

  assert.ok(pushCallbacks, "push sync callbacks should be captured");

  pushCallbacks.onStateReceived(fullState);

  assert.deepEqual(
    emittedEvents.filter((event) => event.eventName === "viewStateChange"),
    [],
    "viewStateChange should wait until the queued state is actually applied",
  );

  queuedStatesBlocked = false;
  const didSync = scene.applyQueuedStateSync();

  assert.equal(didSync, true);
  assert.deepEqual(
    emittedEvents.filter((event) => event.eventName === "viewStateChange"),
    [{ eventName: "viewStateChange", payload: fullState }],
  );
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
      withSyncCapability: () => ({
        synchronizeSync(state) {
          appliedStates.push(state);
          return true;
        },
        updateGarbageCollectorThreshold() {},
      }),
      createPushSync() {
        return {
          cleanup() {},
          requestResync() {},
          getQueueLength() {
            return queuedStates.length;
          },
          drainReadyStates() {
            const readyCount = Math.max(queuedStates.length - blockedStateCount, 0);
            return queuedStates.splice(0, readyCount);
          },
          drainReadyPartialUpdates() {
            if (queuedStates.length) {
              return [];
            }

            const readyPartials = bufferedPartialUpdates;
            bufferedPartialUpdates = [];
            return readyPartials;
          },
        };
      },
      createPullSync() {
        throw new Error("Pull sync should not be used in this test");
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
  assert.deepEqual(appliedPartials, [{ update: partialUpdate, ctx: syncContext }]);
});
