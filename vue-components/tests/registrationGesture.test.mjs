import assert from "node:assert/strict";
import { test } from "node:test";
import { createRegistrationGesture } from "../src/components/registrationGesture.js";

test("delayed arm and disarm never replace newer captured state", () => {
  const gesture = createRegistrationGesture();
  gesture.set({ generation: 1, token: "first", asset_id: "A" });
  const captured = gesture.capture();
  gesture.set({ generation: 3, token: "third", asset_id: "B" });
  gesture.set({ generation: 2, token: null, asset_id: null });
  gesture.set({ generation: 1, token: "first", asset_id: "A" });
  assert.equal(gesture.capture().token, "third");
  assert.equal(captured.token, "first");
});
