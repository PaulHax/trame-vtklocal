import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

let registry;

beforeEach(async () => {
  registry = await loadModule("/src/components/viewRegistry.js");
  registry.resetViewRegistry();
});

after(async () => {
  await closeModuleLoader();
});

test("registerView exposes the api under every key and coerces to strings", () => {
  const { registerView, getView } = registry;
  const api = { name: "shared-view" };

  registerView(["vtkMapView_map", 7], api);

  assert.equal(getView("vtkMapView_map"), api);
  assert.equal(getView("7"), api);
  // A numeric render-window id resolves through the same string key.
  assert.equal(getView(7), api);
  // Nullish keys are ignored, and unknown keys return null.
  assert.equal(getView("unknown"), null);
  assert.equal(getView(null), null);
});

test("whenView resolves immediately when the view is already registered", async () => {
  const { registerView, whenView } = registry;
  const api = { name: "already-mounted" };
  registerView(["vtkMapView_map"], api);

  const resolved = await whenView("vtkMapView_map");
  assert.equal(resolved, api);
});

test("whenView resolves after the view registers (await before mount)", async () => {
  const { registerView, whenView } = registry;
  const api = { name: "mounts-later" };

  // Two consumers await before anything is registered.
  const pendingA = whenView("vtkMapView_second");
  const pendingB = whenView("vtkMapView_second");

  registerView(["vtkMapView_second", 12], api);

  assert.equal(await pendingA, api);
  assert.equal(await pendingB, api);
  // And a lookup by the render-window id the same registration used.
  assert.equal(await whenView(12), api);
});

test("unregisterView drops the view so later lookups miss until remount", async () => {
  const { registerView, unregisterView, getView, whenView } = registry;
  const api = { name: "unmounts" };
  registerView(["vtkMapView_map", 7], api);

  unregisterView(["vtkMapView_map", 7], api);

  assert.equal(getView("vtkMapView_map"), null);
  assert.equal(getView("7"), null);

  // A fresh whenView now waits for the next registration.
  let resolvedWith = null;
  const pending = whenView("vtkMapView_map").then((v) => {
    resolvedWith = v;
  });
  assert.equal(resolvedWith, null);

  const next = { name: "remounted" };
  registerView(["vtkMapView_map"], next);
  await pending;
  assert.equal(resolvedWith, next);
});

test("unregisterView with a stale api does not clobber a remounted view", () => {
  const { registerView, unregisterView, getView } = registry;
  const stale = { name: "stale" };
  const fresh = { name: "fresh" };

  registerView(["vtkMapView_map"], stale);
  // Remount registered the new api first...
  registerView(["vtkMapView_map"], fresh);
  // ...then the old instance's onBeforeUnmount fires: it must not remove fresh.
  unregisterView(["vtkMapView_map"], stale);

  assert.equal(getView("vtkMapView_map"), fresh);
});
