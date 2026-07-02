// Client-side drag/click gesture state machine for pickable glyphs.
//
// The app used to run this lifecycle itself (map_init.js); it now lives in the
// fork so every consumer gets the same rAF-throttled drag, a guaranteed
// terminal end, and self-contained event payloads. Each emitted event carries
// the camera matrices and viewport it was measured against, so the server needs
// no snapshot cache to resolve it: the event describes its own frame.
//
// Everything app-specific crosses as opaque data — `context` (an arbitrary
// blob set via setPointerContext) and `pick.tags` (round-tripped from the G1
// registry). The fork never interprets either.

const noop = () => {};

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function createPickableGestures({
  pick = () => null,
  readCamera = () => null,
  readViewport = () => null,
  getCanvas = () => null,
  emit = noop,
  windowRef = globalThis.window,
  emitBackgroundClick = true,
} = {}) {
  let context = null;
  let backgroundClickEnabled = !!emitBackgroundClick;

  // Active drag lifecycle state. The pick is frozen at drag start: the target
  // identity and grab offset don't change mid-drag, only the pointer moves.
  let drag = null; // { pick, grabOffset, pointerId, canvas, previousCursor }
  let pendingMove = null; // latest move payload (rAF-coalesced, last wins)
  let rafHandle = 0;

  function requestFrame(cb) {
    return windowRef?.requestAnimationFrame
      ? windowRef.requestAnimationFrame(cb)
      : 0;
  }

  function cancelFrame(handle) {
    if (handle && windowRef?.cancelAnimationFrame) {
      windowRef.cancelAnimationFrame(handle);
    }
  }

  // Convert a pointer event's client coords to canvas CSS px (top-left origin),
  // matching the space pickAt and the pickable projection both work in.
  function pointerToCanvasCss(event) {
    const canvas = getCanvas();
    if (!canvas || typeof canvas.getBoundingClientRect !== "function") {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    const x = finite(event?.clientX, NaN) - finite(rect?.left, 0);
    const y = finite(event?.clientY, NaN) - finite(rect?.top, 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    return { x, y };
  }

  function buildPayload(type, cssPointer, pickResult, grabOffset, flags = {}) {
    const offX = grabOffset ? finite(grabOffset.x) : 0;
    const offY = grabOffset ? finite(grabOffset.y) : 0;
    const pointer = cssPointer
      ? { x: cssPointer.x + offX, y: cssPointer.y + offY }
      : null;
    return {
      type,
      pointer,
      viewport: readViewport() || null,
      camera: readCamera() || null,
      pick: pickResult || null,
      context,
      ...flags,
    };
  }

  function setCursor(canvas, value) {
    if (canvas && canvas.style) {
      canvas.style.cursor = value;
    }
  }

  function addDragListeners() {
    if (!windowRef?.addEventListener) return;
    windowRef.addEventListener("pointermove", onPointerMove, true);
    windowRef.addEventListener("pointerup", onPointerUp, true);
    windowRef.addEventListener("pointercancel", onPointerCancel, true);
  }

  function removeDragListeners() {
    if (!windowRef?.removeEventListener) return;
    windowRef.removeEventListener("pointermove", onPointerMove, true);
    windowRef.removeEventListener("pointerup", onPointerUp, true);
    windowRef.removeEventListener("pointercancel", onPointerCancel, true);
  }

  function stopEvent(event) {
    event?.preventDefault?.();
    event?.stopImmediatePropagation?.();
  }

  function flushMove() {
    rafHandle = 0;
    const payload = pendingMove;
    pendingMove = null;
    if (!drag || !payload) return;
    emit(payload);
  }

  function scheduleMove(payload) {
    // Latest payload wins; at most one flush per frame.
    pendingMove = payload;
    if (!rafHandle) {
      rafHandle = requestFrame(flushMove);
    }
  }

  function onPointerMove(event) {
    if (!drag) return;
    stopEvent(event);
    const cssPointer = pointerToCanvasCss(event);
    if (!cssPointer) return;
    scheduleMove(
      buildPayload("target.drag.move", cssPointer, drag.pick, drag.grabOffset),
    );
  }

  function endDrag(event, { cancelled = false } = {}) {
    const active = drag;
    if (!active) return;
    removeDragListeners();
    stopEvent(event);
    // Force-flush a pending move so the last position lands before the terminal
    // event, then drop anything still queued.
    if (rafHandle) {
      cancelFrame(rafHandle);
      rafHandle = 0;
      flushMove();
    }
    pendingMove = null;

    const cssPointer = pointerToCanvasCss(event);
    const unresolved = !cssPointer;
    const flags = {};
    if (cancelled || unresolved) flags.cancelled = true;
    if (unresolved) flags.unresolved = true;
    // The terminal end is ALWAYS emitted so the server releases its capture and
    // clears its drag state, even when the pointer position can't be resolved.
    emit(
      buildPayload(
        "target.drag.end",
        cssPointer,
        active.pick,
        active.grabOffset,
        flags,
      ),
    );

    try {
      active.canvas?.releasePointerCapture?.(active.pointerId);
    } catch (_error) {
      // Capture may already be released (e.g. pointercancel); ignore.
    }
    setCursor(active.canvas, active.previousCursor || "");
    drag = null;
  }

  function onPointerUp(event) {
    endDrag(event, { cancelled: false });
  }

  function onPointerCancel(event) {
    endDrag(event, { cancelled: true });
  }

  // Pick at the pointer; on a hit, take pointer capture, run the drag
  // lifecycle, and return true. On a miss, do nothing and return false.
  function startTargetDrag(event) {
    if (drag) return false; // one drag at a time
    const cssPointer = pointerToCanvasCss(event);
    if (!cssPointer) return false;
    const pickResult = pick(cssPointer.x, cssPointer.y);
    if (!pickResult) return false;

    const canvas = getCanvas();
    const grabOffset = pickResult.grabOffset || { x: 0, y: 0 };
    drag = {
      pick: pickResult,
      grabOffset,
      pointerId: event?.pointerId,
      canvas,
      previousCursor: canvas?.style?.cursor || "",
    };
    stopEvent(event);
    try {
      canvas?.setPointerCapture?.(event?.pointerId);
    } catch (_error) {
      // No capture available (e.g. detached element); the drag still runs.
    }
    setCursor(canvas, "grabbing");
    addDragListeners();
    emit(buildPayload("target.drag.start", cssPointer, pickResult, grabOffset));
    return true;
  }

  // Pick at the pointer; emit target.click on a hit, or background.click on a
  // miss when background clicks are enabled. Returns whether anything emitted.
  function emitTargetClick(event) {
    const cssPointer = pointerToCanvasCss(event);
    if (!cssPointer) return false;
    const pickResult = pick(cssPointer.x, cssPointer.y);
    if (pickResult) {
      emit(buildPayload("target.click", cssPointer, pickResult, null));
      return true;
    }
    if (!backgroundClickEnabled) return false;
    emit(buildPayload("background.click", cssPointer, null, null));
    return true;
  }

  function setPointerContext(value) {
    context = value ?? null;
  }

  function setEmitBackgroundClick(enabled) {
    backgroundClickEnabled = !!enabled;
  }

  // Force-end any active drag (emitting the terminal end) and detach listeners.
  // Called on view teardown so a drag in flight can't leak listeners or capture.
  function teardown() {
    if (drag) {
      endDrag(null, { cancelled: true });
    }
    removeDragListeners();
    cancelFrame(rafHandle);
    rafHandle = 0;
    pendingMove = null;
  }

  return {
    startTargetDrag,
    emitTargetClick,
    setPointerContext,
    setEmitBackgroundClick,
    teardown,
  };
}

export default { createPickableGestures };
