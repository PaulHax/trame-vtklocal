import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

// VtkJsLocal.js forwards camera interaction to useSceneSync through the
// Start/End/InteractionEvent trio. Those events fire on the interactor
// STYLE; vtkRenderWindowInteractor's .d.ts declares them too, but its
// runtime never generates or invokes them, so subscribing on the
// interactor silently drops the whole camera channel.
test("camera interaction events fire on the interactor style, not the interactor", async () => {
  globalThis.requestAnimationFrame ??= () => 1;
  globalThis.cancelAnimationFrame ??= () => {};
  // newInstance() probes document for visibility tracking.
  globalThis.document ??= { addEventListener() {}, removeEventListener() {} };

  // Sequential loads: concurrent ssrLoadModule calls deadlock on the
  // interactor's circular import graph.
  const { default: vtkRenderWindowInteractor } = await loadModule(
    "/node_modules/@kitware/vtk.js/Rendering/Core/RenderWindowInteractor.js",
  );
  const { default: vtkInteractorStyleTrackballCamera } = await loadModule(
    "/node_modules/@kitware/vtk.js/Interaction/Style/InteractorStyleTrackballCamera.js",
  );

  const interactor = vtkRenderWindowInteractor.newInstance();
  const style = vtkInteractorStyleTrackballCamera.newInstance();
  interactor.setInteractorStyle(style);

  assert.equal(interactor.onStartInteractionEvent, undefined);
  assert.equal(interactor.onInteractionEvent, undefined);
  assert.equal(interactor.onEndInteractionEvent, undefined);

  const calls = [];
  const subscriptions = [
    style.onStartInteractionEvent(() => calls.push("start")),
    style.onInteractionEvent(() => calls.push("move")),
    style.onEndInteractionEvent(() => calls.push("end")),
  ];
  assert.ok(
    subscriptions.every(
      (subscription) => typeof subscription?.unsubscribe === "function",
    ),
  );

  style.startRotate();
  style.invokeInteractionEvent({ type: "InteractionEvent" });
  style.endRotate();

  assert.deepEqual(calls, ["start", "move", "end"]);

  subscriptions.forEach((subscription) => subscription.unsubscribe());
});
