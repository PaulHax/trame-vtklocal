/**
 * SyncExtension - Synchronous state synchronization for vtk.js
 *
 * Provides synchronous state application for use cases where Promise-based
 * async synchronization is not suitable (e.g., MapLibre custom layer render
 * callbacks that must be synchronous).
 *
 * Usage:
 *   import { withSyncCapability } from './SyncExtension';
 *
 *   const syncMethods = withSyncCapability(renderWindow, synchronizerContext, objectManager);
 *   syncMethods.synchronizeSync(state) - synchronous state application
 *   syncMethods.hasInlineData(state) - check if state has inline data
 */

import { allArraysHaveInlineData } from './validation';
import { updateRenderWindowSync } from './syncUpdaters';

// Re-export components for direct access
export { base64ToArrayBuffer, createTypedArray } from './base64';
export { allArraysHaveInlineData } from './validation';
export {
  genericUpdaterSync,
  updateRenderWindowSync,
  createDataSetUpdateSync,
  polydataUpdaterSync,
  imageDataUpdaterSync,
  registerSyncUpdater,
  getSyncUpdater,
} from './syncUpdaters';

/**
 * Add synchronous sync capability to a SynchronizableRenderWindow.
 *
 * @param {Object} renderWindow - A vtkSynchronizableRenderWindow instance
 * @param {Object} synchronizerContext - The synchronizer context (from getSynchronizerContext)
 * @param {Object} objectManager - The object manager (vtkObjectManager) for building instances
 * @returns {Object} Object with synchronizeSync and hasInlineData methods
 */
export function withSyncCapability(
  renderWindow,
  synchronizerContext,
  objectManager
) {
  let lastMtime = -1;
  let gcThreshold = 100;

  const setSynchronizedViewId = (synchronizedViewId) => {
    renderWindow.set({ synchronizedViewId }, true, true);
  };

  const getSynchronizedViewId = () =>
    renderWindow.get('synchronizedViewId').synchronizedViewId;

  /**
   * Synchronous state application - requires all arrays to have inline data.
   * Use this when you need to apply state in a synchronous context
   * (e.g., MapLibre render callback).
   *
   * @param {Object} state - State object with inline array data
   * @param {boolean} skipRender - If true, skip the final render call
   * @returns {boolean} - true if state was applied, false if skipped
   */
  function synchronizeSync(state, skipRender = false) {
    if (!allArraysHaveInlineData(state, synchronizerContext)) {
      throw new Error(
        'synchronizeSync requires all arrays to have inline "content" field or be previously cached. ' +
          'Use inline_arrays=True on Python side.'
      );
    }

    if (!getSynchronizedViewId()) {
      setSynchronizedViewId(state.id);
    }

    const mtime = state.mtime || 0;
    if (getSynchronizedViewId() === state.id && lastMtime < mtime) {
      lastMtime = mtime;
      synchronizerContext.setActiveViewId(state.id);
      synchronizerContext.incrementMTime();

      // Use synchronous updater - no Promises, no progress counter
      updateRenderWindowSync(
        renderWindow,
        state,
        synchronizerContext,
        objectManager
      );

      synchronizerContext.freeOldArrays(gcThreshold, synchronizerContext);

      if (!skipRender) {
        renderWindow.render();
      }
      return true;
    }

    return false;
  }

  /**
   * Check if state has all inline data required for synchronizeSync
   */
  function hasInlineData(state) {
    return allArraysHaveInlineData(state, synchronizerContext);
  }

  /**
   * Update the garbage collection threshold
   */
  function updateGarbageCollectorThreshold(v) {
    gcThreshold = v;
  }

  return {
    synchronizeSync,
    hasInlineData,
    updateGarbageCollectorThreshold,
  };
}

export default {
  withSyncCapability,
  allArraysHaveInlineData,
};
