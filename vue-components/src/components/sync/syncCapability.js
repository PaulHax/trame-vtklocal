/**
 * sync - Synchronous state synchronization for vtk.js
 *
 * Provides synchronous state application for use cases where Promise-based
 * async synchronization is not suitable (e.g., MapLibre custom layer render
 * callbacks that must be synchronous).
 *
 * Usage:
 *   import { withSyncCapability } from "./sync/syncCapability";
 *
 *   const syncMethods = withSyncCapability(
 *     renderWindow, synchronizerContext, objectManager, pushCache,
 *   );
 *   syncMethods.synchronizePreparedStateSync(state) - synchronous application
 *                                                    for push-queue-prepared states
 */

import { allArraysHaveInlineData } from "./validation";
import { extractInlineArrays, updateRenderWindowSync } from "./syncUpdaters";

// Re-export components for direct access
export { base64ToArrayBuffer, createTypedArray } from "./base64";
export { allArraysHaveInlineData };
export {
  genericUpdaterSync,
  updateRenderWindowSync,
  extractInlineArrays,
  createDataSetUpdateSync,
  polydataUpdaterSync,
  imageDataUpdaterSync,
  registerSyncUpdater,
  getSyncUpdater,
} from "./syncUpdaters";

/**
 * Add synchronous sync capability to a SynchronizableRenderWindow.
 *
 * @param {Object} renderWindow         a vtkSynchronizableRenderWindow instance
 * @param {Object} synchronizerContext  the synchronizer context
 * @param {Object} objectManager        vtkObjectManager for building instances
 * @param {Map}    pushCache            Map<hash, TypedArray> owned by the caller
 * @returns {Object} sync API
 */
export function withSyncCapability(
  renderWindow,
  synchronizerContext,
  objectManager,
  pushCache
) {
  let lastMtime = -1;
  const cache = pushCache || new Map();

  const setSynchronizedViewId = (synchronizedViewId) => {
    renderWindow.set({ synchronizedViewId }, true, true);
  };

  const getSynchronizedViewId = () =>
    renderWindow.get("synchronizedViewId").synchronizedViewId;

  function applyStateSync(state, skipRender = false, options = {}) {
    const { force = false } = options;
    if (!getSynchronizedViewId()) {
      setSynchronizedViewId(state.id);
    }

    const mtime = state.mtime || 0;
    if (getSynchronizedViewId() === state.id && (force || lastMtime < mtime)) {
      lastMtime = Math.max(lastMtime, mtime);
      synchronizerContext.setActiveViewId(state.id);
      synchronizerContext.incrementMTime();

      // Capture any inline payloads from this delta into the persistent
      // push cache, then drive the synchronous updater off of it.
      extractInlineArrays(state, cache);
      updateRenderWindowSync(
        renderWindow,
        state,
        synchronizerContext,
        objectManager,
        cache
      );

      if (!skipRender) {
        renderWindow.render();
      }
      return true;
    }

    return false;
  }

  /**
   * Synchronous state application for states already prepared by the push queue.
   * The caller must ensure every referenced array is in the push cache before
   * calling this.
   *
   * Contract: returns true when the state was applied or the renderer mutated;
   * returns false when the state was a no-op (e.g. stale mtime, nothing to do).
   * A real failure to apply MUST throw — the ordered push queue treats a false
   * return as "consume the envelope and advance the per-client cursor."
   */
  function synchronizePreparedStateSync(state, skipRender = false) {
    // Push states are server-authoritative; array hashes/counts can change
    // even when the root render-window mtime is unchanged.
    return applyStateSync(state, skipRender, { force: true });
  }

  return {
    synchronizePreparedStateSync,
  };
}

export default {
  withSyncCapability,
  allArraysHaveInlineData,
};
