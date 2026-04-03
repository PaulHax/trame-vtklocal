export function createSyncController(options) {
  const {
    canSync,
    synchronize,
    beforeSync,
    onSynced,
    afterSync,
    onError,
    finalizeSync,
    rethrowError = false,
  } = options;

  let pendingSync = false;
  let activeSyncPromise = null;

  async function runSync() {
    if (!canSync()) {
      return { attempted: false, didSync: false, syncResult: null };
    }

    const syncContext = beforeSync?.();

    try {
      const syncResult = await synchronize();
      if (!canSync()) {
        return { attempted: false, didSync: false, syncResult: null };
      }

      const didSync = !!syncResult;
      if (didSync) {
        onSynced?.(syncResult);
      }
      afterSync?.(syncResult, didSync);

      return { attempted: true, didSync, syncResult };
    } catch (error) {
      if (canSync()) {
        onError?.(error);
      }

      if (rethrowError) {
        throw error;
      }

      return {
        attempted: true,
        didSync: false,
        syncResult: null,
        error,
      };
    } finally {
      finalizeSync?.(syncContext);
    }
  }

  async function flushPendingSync() {
    let didAttemptSync = false;

    while (pendingSync && canSync()) {
      pendingSync = false;
      const result = await runSync();
      didAttemptSync = result.attempted || didAttemptSync;
    }

    return didAttemptSync;
  }

  async function requestSync() {
    pendingSync = true;

    if (!activeSyncPromise) {
      activeSyncPromise = flushPendingSync();
    }

    const syncPromise = activeSyncPromise;

    try {
      return await syncPromise;
    } finally {
      if (activeSyncPromise === syncPromise) {
        activeSyncPromise = null;
      }
    }
  }

  return {
    runSync,
    requestSync,
  };
}
