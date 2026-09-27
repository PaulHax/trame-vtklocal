// Fork-owned registry of mounted shared views.
//
// A view registers its public API object on mount (keyed by its trame ref name
// and its render-window id) and unregisters on unmount. Consumers resolve a
// view by awaiting `whenView(key)` (or reading it synchronously via
// `getView(key)`) instead of unwrapping the Vue component ref through
// `$.exposed`/`$.setupState` and polling with a `setTimeout` for mount timing.
//
// The store lives on the global object (`window.trameVtklocal`) so every module
// that loads the fork bundle — including app code served separately — shares one
// registry instance.

const ns = (globalThis.trameVtklocal ??= {});
ns.views ??= new Map();
ns.waiters ??= new Map();
// Public helpers on the namespace so consumers only touch window.trameVtklocal.
ns.whenView = whenView;
ns.getView = getView;

function normalizeKey(key) {
  return key == null ? null : String(key);
}

// Register `api` under every provided key (nullish keys are ignored). Resolves
// any pending `whenView` promises waiting on those keys.
export function registerView(keys, api) {
  const seen = new Set();
  for (const raw of keys) {
    const key = normalizeKey(raw);
    if (key == null || seen.has(key)) continue;
    seen.add(key);
    ns.views.set(key, api);
    const waiters = ns.waiters.get(key);
    if (waiters) {
      ns.waiters.delete(key);
      for (const resolve of waiters) resolve(api);
    }
  }
  return api;
}

// Remove the given keys. When `api` is supplied, only drop a key that still
// points at that same api (so a remount that re-registered first is not clobbered).
export function unregisterView(keys, api = null) {
  for (const raw of keys) {
    const key = normalizeKey(raw);
    if (key == null) continue;
    if (api == null || ns.views.get(key) === api) {
      ns.views.delete(key);
    }
  }
}

// Synchronous lookup; returns null when no view is registered under `key`.
export function getView(key) {
  const normalized = normalizeKey(key);
  if (normalized == null) return null;
  return ns.views.get(normalized) || null;
}

// Resolve with the view's API once it is registered under `key`; resolves
// immediately when the view is already present.
export function whenView(key) {
  const normalized = normalizeKey(key);
  if (normalized == null) {
    return Promise.reject(new Error("whenView requires a view key"));
  }
  if (ns.views.has(normalized)) {
    return Promise.resolve(ns.views.get(normalized));
  }
  return new Promise((resolve) => {
    let waiters = ns.waiters.get(normalized);
    if (!waiters) {
      waiters = new Set();
      ns.waiters.set(normalized, waiters);
    }
    waiters.add(resolve);
  });
}
