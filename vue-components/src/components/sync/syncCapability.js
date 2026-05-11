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
 *   const synchronizePreparedStateSync = withSyncCapability(
 *     renderWindow, synchronizerContext, objectManager, pushCache,
 *   );
 *   synchronizePreparedStateSync(state) - synchronous application for
 *                                         push-queue-prepared states.
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
 * Bind a SynchronizableRenderWindow to a synchronous-apply function.
 *
 * @param {Object} renderWindow         a vtkSynchronizableRenderWindow instance
 * @param {Object} synchronizerContext  the synchronizer context
 * @param {Object} objectManager        vtkObjectManager for building instances
 * @param {Map}    pushCache            Map<hash, TypedArray> owned by the caller
 * @returns {Function} synchronizePreparedStateSync(state, skipRender?) -> boolean
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

  // A renderWindow re-used across cleanup/reinitialize keeps any prior
  // synchronizedViewId. Without resetting it, the first state from a new
  // view would fail the id check below, throw, trigger requestResync, and
  // loop indefinitely (resync resends the same state). Claim fresh.
  setSynchronizedViewId(null);

  function applyStateSync(state, skipRender = false, options = {}) {
    const { force = false } = options;
    if (!getSynchronizedViewId()) {
      setSynchronizedViewId(state.id);
    }

    if (getSynchronizedViewId() !== state.id) {
      // Real failure: this renderer is bound to a different view's state.
      // The caller (ordered push queue) translates throws into requestResync.
      throw new Error(
        `synchronizedViewId mismatch: bound=${getSynchronizedViewId()}, ` +
          `state=${state.id}`,
      );
    }

    const mtime = state.mtime || 0;
    if (force || lastMtime < mtime) {
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
   * returns false only for stale-mtime no-ops (the ordered push queue
   * consumes the envelope and advances the per-client cursor). View-id
   * mismatches and other real failures throw.
   */
  return function synchronizePreparedStateSync(state, skipRender = false) {
    // Push states are server-authoritative; array hashes/counts can change
    // even when the root render-window mtime is unchanged.
    return applyStateSync(state, skipRender, { force: true });
  };
}

export default {
  withSyncCapability,
  allArraysHaveInlineData,
};
