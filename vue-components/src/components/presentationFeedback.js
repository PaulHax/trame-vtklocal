// Paint bookkeeping for one view: the prepared/completed frame serials, the
// scene seq a paint still owes, and the presentation-interval feedback that
// drives the streamed-scene adaptive budget.

import { peekExternalTextures } from "./externalTextures";

// Above any real refresh period, below the pause that separates one burst of
// painting from the next. An interval longer than this spans idle time even
// when the paint inside it was cheap.
const IDLE_PRESENTATION_GAP_MS = 80;

export function createPresentationFeedback({
  getRenderWindow = () => null,
  getStreamedSceneHost = () => null,
  getSceneSeq = () => -1,
  requestRender = () => {},
} = {}) {
  // Streamed members publish their selected/drawn state from beforeRender().
  // Keep an explicit public paint boundary so support clients can distinguish
  // that prepared state from pixels which have actually reached the canvas.
  let preparedFrameSerial = 0;
  let completedFrameSerial = 0;
  let completedPreparedFrameSerial = 0;
  let sceneSeqAtLastPaint = -1;
  // Unlike the transport cursor, this advances only for a message that can
  // change pixels. Empty ops messages deliberately do not request a paint, so
  // consumers waiting for visual currency must compare against this watermark
  // rather than mySeq.
  let sceneSeqRequiringPaint = -1;
  const paintCompletedCallbacks = new Set();
  // Once the host reports whole-frame metrics, the view's own presentation
  // measurement stops being fed to the budget loop so the same frame is never
  // counted twice.
  let hostFrameFeedbackSeen = false;
  // Presentation bookkeeping for the frames this view measures itself.
  let presentationFrame = 0;
  let pendingPaintMs = null;
  let lastPresentedAt = null;

  function requireScenePaint(message) {
    const seq = Number(message?.seq);
    if (Number.isFinite(seq)) {
      sceneSeqRequiringPaint = Math.max(sceneSeqRequiringPaint, seq);
    }
  }

  // vtk.js can notify RenderEvent from inside a view's explicit pre-paint
  // hook. Both calls prepare the same paint, so retain one serial until that
  // paint is reported complete. The coordinator uses this serial to make its
  // admission drain idempotent.
  function preparePaint() {
    if (preparedFrameSerial === completedPreparedFrameSerial) {
      preparedFrameSerial += 1;
      peekExternalTextures(getRenderWindow())?.beginPaint();
    }
    return preparedFrameSerial;
  }

  function onPaintCompleted(callback) {
    paintCompletedCallbacks.add(callback);
    return () => paintCompletedCallbacks.delete(callback);
  }

  function notePaintCompleted() {
    completedFrameSerial += 1;
    completedPreparedFrameSerial = preparedFrameSerial;
    sceneSeqAtLastPaint = getSceneSeq();
    const event = {
      frameSerial: completedFrameSerial,
      sceneSeq: sceneSeqAtLastPaint,
      textures:
        peekExternalTextures(getRenderWindow())?.paintedTextures() || [],
    };
    paintCompletedCallbacks.forEach((callback) => callback(event));
  }

  // The adaptive budget never schedules a frame of its own: the host paints,
  // reports the frame, and asks whether the view still owes the user another
  // one. Without this the settled regime would stop measuring the moment the
  // host went idle, and quality would freeze wherever motion left it.
  function requestFrameIfNeeded() {
    if (getStreamedSceneHost()?.needsFrame()) requestRender();
  }

  function cancelPresentationReport() {
    if (presentationFrame) {
      globalThis.window?.cancelAnimationFrame?.(presentationFrame);
    }
    presentationFrame = 0;
    pendingPaintMs = null;
    lastPresentedAt = null;
  }

  // `hostFrameMs` is the interval between presentations, not how long a frame
  // took to build. The budget loop reads the shortest intervals it sees as the
  // display's refresh period, so a build duration teaches it a quantum far
  // below the real one; it also cannot say whether a frame reached the
  // display. So the report waits for the next presentation tick and carries
  // the interval measured there.
  //
  // No `vtkFrameMs` accompanies it. That sibling names the streamed sub-pass
  // inside a larger host frame and is divided by the fraction of a frame
  // budgeted to it; this view's paint is the whole frame's work, so passing it
  // there would inflate every measurement by the reciprocal of that fraction.
  function schedulePresentationReport() {
    if (presentationFrame) return;
    presentationFrame =
      globalThis.window?.requestAnimationFrame?.((presentedAt) => {
        presentationFrame = 0;
        const paintMs = pendingPaintMs ?? 0;
        pendingPaintMs = null;
        const interval =
          lastPresentedAt === null ? null : presentedAt - lastPresentedAt;
        lastPresentedAt = presentedAt;
        // An interval far longer than the work inside it spans idle time: a
        // view that painted, sat still, and painted again has not slowed down,
        // and reporting the gap as a frame cost drives quality to the floor.
        const contiguous = Math.max(IDLE_PRESENTATION_GAP_MS, paintMs * 4);
        const usable =
          interval !== null && interval > 0 && interval <= contiguous;
        if (usable && !hostFrameFeedbackSeen) {
          getStreamedSceneHost()?.recordHostFrame({
            hostFrameMs: interval,
            now: presentedAt,
          });
        }
        // Asked on every presentation, including one whose interval was
        // rejected: the budget loop only keeps measuring while something keeps
        // painting, so a frame dropped for spanning idle time must still renew
        // the request or the loop stops here.
        requestFrameIfNeeded();
      }) || 0;
  }

  // The view measures each paint's wall-time and reports it here; it feeds the
  // adaptive-quality budget loop for any streamed LOD cloud (a no-op when no
  // cloud has adaptive enabled).
  function recordFrameDuration(durationMs) {
    if (hostFrameFeedbackSeen) return;
    // Paints that coalesce into one presentation all count: the interval has
    // to cover the work of every paint inside it.
    pendingPaintMs = (pendingPaintMs ?? 0) + (durationMs || 0);
    schedulePresentationReport();
  }

  function recordPaintDuration(durationMs) {
    notePaintCompleted();
    recordFrameDuration(durationMs);
  }

  function recordHostFrame(metrics) {
    hostFrameFeedbackSeen = true;
    cancelPresentationReport();
    getStreamedSceneHost()?.recordHostFrame(metrics);
    requestFrameIfNeeded();
  }

  // A scene re-initialization forgets host feedback; serials and paint
  // listeners belong to the view and survive it.
  function reset() {
    hostFrameFeedbackSeen = false;
    cancelPresentationReport();
  }

  function dispose() {
    reset();
    paintCompletedCallbacks.clear();
  }

  function describe() {
    return {
      preparedFrameSerial,
      completedFrameSerial,
      completedPreparedFrameSerial,
      sceneSeqAtLastPaint,
      sceneSeqRequiringPaint,
    };
  }

  return {
    requireScenePaint,
    preparePaint,
    onPaintCompleted,
    recordFrameDuration,
    recordPaintDuration,
    recordHostFrame,
    requestFrameIfNeeded,
    reset,
    dispose,
    describe,
  };
}

export default { createPresentationFeedback };
