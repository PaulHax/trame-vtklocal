import { isLiveInstance } from "../predicates";

function newRecord(id) {
  return {
    id,
    appliedType: null,
    instance: null,
    revision: 0,
    status: "pending",
    pendingReason: null,
  };
}

// Applied runtime identity, kept separate from the serialized mirror. One
// record per mirrored ID answers "which vtk instance is applied for this ID,
// and is it current" — the mirror answers everything about desired state,
// including type and ref topology. Records stay stable while an ID remains
// mirrored so a held record never retains a retired instance; removal deletes
// the record (the retained object reports "removed" to any holder).
export function createAppliedRegistry({ synchronizerContext } = {}) {
  const records = new Map();
  let instanceRevision = 0;

  function ensureRecord(id) {
    id = String(id);
    let record = records.get(id);
    if (!record) {
      record = newRecord(id);
      records.set(id, record);
    }
    return record;
  }

  function noteInstance(record, instance) {
    if (record.instance === instance) return false;
    record.instance = instance;
    record.revision += 1;
    instanceRevision += 1;
    return true;
  }

  function beginDesired(id, desiredType) {
    const record = ensureRecord(id);
    record.pendingReason = null;
    if (
      !isLiveInstance(record.instance) ||
      record.appliedType !== (desiredType ?? null)
    ) {
      record.status = "pending";
    }
    return record;
  }

  // Reconciliation can inherit a widget-owned root or a test/application
  // instance registered before this registry existed. This is an observation
  // at the reconciliation boundary, not a supported out-of-band mutation path.
  function adoptRegistered(id, appliedType = null) {
    const record = ensureRecord(id);
    const instance = synchronizerContext?.getInstance?.(record.id) ?? null;
    noteInstance(record, isLiveInstance(instance) ? instance : null);
    if (record.instance) {
      record.appliedType = appliedType ?? record.appliedType;
      record.status = "live";
      record.pendingReason = null;
    } else {
      record.appliedType = null;
      record.status = "pending";
    }
    return record;
  }

  function register(id, instance, appliedType) {
    const record = ensureRecord(id);
    synchronizerContext?.registerInstance?.(record.id, instance);
    noteInstance(record, instance);
    record.appliedType = appliedType ?? null;
    record.status = "pending";
    record.pendingReason = null;
    return record;
  }

  function markLive(id, appliedType) {
    const record = ensureRecord(id);
    record.appliedType = appliedType ?? null;
    record.status = "live";
    record.pendingReason = null;
    return record;
  }

  function markPending(id, desiredType, reason) {
    const record = beginDesired(id, desiredType);
    record.status = "pending";
    record.pendingReason = reason || null;
    return record;
  }

  function detach(id, { status = "pending", reason = null } = {}) {
    const record = ensureRecord(id);
    synchronizerContext?.unregisterInstance?.(record.id);
    noteInstance(record, null);
    record.appliedType = null;
    record.status = status;
    record.pendingReason = reason;
    return record;
  }

  function remove(id) {
    const record = records.get(String(id));
    if (!record) return null;
    synchronizerContext?.unregisterInstance?.(record.id);
    noteInstance(record, null);
    record.appliedType = null;
    record.status = "removed";
    record.pendingReason = null;
    records.delete(record.id);
    return record;
  }

  function getRecord(id) {
    return records.get(String(id)) ?? null;
  }

  function getInstance(id) {
    return getRecord(id)?.instance ?? null;
  }

  function ids() {
    return [...records.keys()];
  }

  function clear() {
    for (const record of [...records.values()]) {
      remove(record.id);
    }
  }

  function describe() {
    return {
      instanceRevision,
      records: [...records.values()].map((record) => ({
        id: record.id,
        appliedType: record.appliedType,
        revision: record.revision,
        status: record.status,
        pendingReason: record.pendingReason,
        live: isLiveInstance(record.instance),
      })),
    };
  }

  return {
    beginDesired,
    adoptRegistered,
    register,
    markLive,
    markPending,
    detach,
    remove,
    getRecord,
    getInstance,
    ids,
    instanceRevision: () => instanceRevision,
    describe,
    clear,
  };
}
