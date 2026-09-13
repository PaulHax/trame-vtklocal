// Camera gesture tracking and the "camera" reports a view emits for them.
//
// Camera interaction is a stack, not a boolean: overlapping gesture sources
// (e.g. a wheel-idle timer and a drag) each begin/end independently, and the
// shared camera channel must stay live until the LAST one ends. A boolean
// would let one source's end silence another's in-flight reports. Each entry
// carries its own `report` flag, so an end can only retract what its begin
// pushed — the two can never drift apart.

export function createCameraReports({
  readReport = () => null,
  emit = () => {},
  onInteractionStart = () => {},
  onInteractionEnd = () => {},
} = {}) {
  // One entry per open camera gesture, holding that gesture's `report` flag.
  const interactionStack = [];
  let options = { during: "none", terminal: true };
  let pending = false;
  let frame = 0;

  function cancel() {
    if (frame) {
      globalThis.window?.cancelAnimationFrame?.(frame);
    }
    frame = 0;
    pending = false;
  }

  function emitReport(terminal) {
    const report = readReport();
    if (!report) return false;
    emit({ ...report, terminal: !!terminal });
    return true;
  }

  function flush() {
    frame = 0;
    if (!pending) return;
    pending = false;
    emitReport(false);
  }

  function report({ terminal = false } = {}) {
    if (terminal) {
      cancel();
      return options.terminal ? emitReport(true) : false;
    }
    if (options.during !== "interaction") return false;
    pending = true;
    if (!frame) {
      frame = globalThis.window?.requestAnimationFrame?.(flush) || 0;
    }
    return true;
  }

  function enable({ during = "none", terminal = true } = {}) {
    if (!["interaction", "none"].includes(during)) {
      throw new Error("camera report 'during' must be 'interaction' or 'none'");
    }
    options = { during, terminal: !!terminal };
    if (during === "none") cancel();
  }

  function begin({ report: reported = true } = {}) {
    interactionStack.push(!!reported);
    if (interactionStack.length === 1) onInteractionStart();
  }

  function interaction() {
    if (interactionStack.includes(true)) report();
  }

  // End the most recently opened camera gesture.
  function end() {
    if (interactionStack.length === 0) return;
    const reported = interactionStack.pop();
    if (reported && !interactionStack.includes(true)) {
      report({ terminal: true });
    }
    if (interactionStack.length > 0) return;
    onInteractionEnd();
  }

  function reset() {
    interactionStack.length = 0;
    cancel();
  }

  return {
    begin,
    interaction,
    end,
    report,
    enable,
    cancel,
    reset,
    isInteracting: () => interactionStack.length > 0,
  };
}

export default { createCameraReports };
