import assert from "node:assert/strict";
import { test } from "node:test";
import { observeElementVisibility } from "../src/components/elementVisibility.js";

test("visibility follows ancestor changes and reparenting, then disconnects", () => {
  const observers = [];
  class Observer {
    targets = [];
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(target) {
      this.targets.push(target);
    }
    disconnect() {
      this.targets = [];
    }
  }
  const listeners = new Map();
  const document = {
    documentElement: {},
    defaultView: {
      MutationObserver: Observer,
      ResizeObserver: Observer,
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: (name) => listeners.delete(name),
    },
  };
  const firstParent = {};
  const secondParent = {};
  let visible = true;
  const element = {
    ownerDocument: document,
    isConnected: true,
    parentElement: firstParent,
    checkVisibility: () => visible,
  };
  const changes = [];
  const lease = observeElementVisibility(element, (value) =>
    changes.push(value),
  );
  assert.deepEqual(changes, [true]);
  visible = false;
  observers[0].callback();
  observers[0].callback();
  assert.deepEqual(changes, [true, false]);
  element.parentElement = secondParent;
  visible = true;
  observers[0].callback();
  assert.ok(observers[0].targets.includes(secondParent));
  assert.ok(!observers[0].targets.includes(firstParent));
  assert.deepEqual(changes, [true, false, true]);
  element.isConnected = false;
  visible = false;
  observers[0].callback();
  assert.deepEqual(observers[0].targets, [document.documentElement]);
  lease.dispose();
  observers[0].callback();
  assert.deepEqual(
    observers.map((o) => o.targets),
    [[], []],
  );
  assert.equal(listeners.size, 0);
});

test("offscreen canvases do not acquire DOM observers", () => {
  const changes = [];
  observeElementVisibility({}, (value) => changes.push(value)).dispose();
  assert.deepEqual(changes, []);
});
