import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

test("useSceneSync buffers partial updates until queued states are ready", async () => {
  const { useSceneSync } = await loadModule("/src/components/useSceneSync.js");

  const appliedStates = [];
  const appliedPartials = [];
  const partialAppliedEvents = [];
  const fullState = { id: "rw", mtime: 1 };
  const partialUpdate = { instanceId: "1", arrayPath: "points", offset: 0 };
  const syncContext = { name: "sync-context" };

  let queuedStatesBlocked = true;
  let queuedStates = [fullState];
  let resyncCount = 0;

  const sync = {
    cleanup() {},
    requestResync() {
      resyncCount += 1;
    },
    getQueueLength() {
      return queuedStatesBlocked ? 1 : queuedStates.length;
    },
    drainReadyQueue() {
      if (queuedStatesBlocked) {
        return [];
      }
      const readyStates = queuedStates;
      queuedStates = [];
      return readyStates;
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
        synchronizeSync(state) {
          appliedStates.push(state);
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
  assert.equal(appliedPartials.length, 0);

  queuedStatesBlocked = false;
  const didSync = scene.applyQueuedStateSync();

  assert.equal(didSync, true);
  assert.deepEqual(appliedStates, [fullState]);
  assert.deepEqual(appliedPartials, [{ update: partialUpdate, ctx: syncContext }]);
  assert.deepEqual(partialAppliedEvents, [
    { update: partialUpdate, ctx: syncContext, applied: true },
  ]);
});
