import vtkObjectManager from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/ObjectManager";

import {
  createManagedSyncContext,
  getPrimaryRenderer,
  getSyncedRenderers,
  applyCameraParams,
  extractCameraParams,
} from "./vtkJsSync";
import { createMirrorStore } from "./engine/mirrorStore";
import { createReconciler } from "./engine/reconcile";
import { createSceneEngine } from "./engine/sceneEngine";
import { dumpAppliedScene } from "./dumpAppliedScene";
import {
  applyDistanceToCameraBlock,
  createDistanceToCameraGlyphRegistry,
  describeDistanceToCameraGlyphRegistry,
  updateDistanceToCameraGlyphs,
  DISTANCE_TO_CAMERA_BLOCK_KEY,
} from "./distanceToCameraGlyphs";
import {
  applyPickableBlock,
  createPickableRegistry,
  describePickableRegistry,
  getDevicePixelRatio,
  getViewportMetrics,
  pickAt as pickAtRegistry,
  PICKABLE_BLOCK_KEY,
} from "./pickables";
import {
  applyPointCloudLodBlock,
  // --- phase0-bench (removable; see app/telesculptor_web/app/bench/README.md) ---
  describePointCloudLodRegistry,
  // --- end phase0-bench ---
  disposePointCloudLods,
  beginPointCloudLodInteraction,
  endPointCloudLodInteraction,
  recordPointCloudLodFrame,
  recordPointCloudLodHostFrame,
  updatePointCloudLods,
  POINT_CLOUD_LOD_BLOCK_KEY,
} from "./pointCloudLod";
import {
  applyPointCloudPresentationBlock,
  updatePointCloudPresentations,
  POINT_CLOUD_PRESENTATION_BLOCK_KEY,
} from "./pointCloudPresentation";
import { createPickableGestures } from "./pickableGestures";
import { createDragPreview } from "./dragPreview";
import { getExternalTextures, peekExternalTextures } from "./externalTextures";

const PROJECTED_TEXTURE_BLOCK_KEY = "projectedTexture";

export function useSceneSync(
  { client, emit, getRenderWindow, renderScene, cameraAuthority = "server" },
  dependencies = {},
) {
  const {
    createManagedSyncContext:
      createManagedSyncContextImpl = createManagedSyncContext,
    createMirrorStore: createMirrorStoreImpl = createMirrorStore,
    createReconciler: createReconcilerImpl = createReconciler,
    createSceneEngine: createSceneEngineImpl = createSceneEngine,
    vtkObjectManager: vtkObjectManagerImpl = vtkObjectManager,
  } = dependencies;

  let managedSyncContext = null;
  let engine = null;
  let reconciler = null;
  let mirror = null;
  let blobCache = null;
  let disposed = false;
  let messageAppliedCallback = null;
  let renderRequestCallback = null;
  const sceneAppliedCallbacks = new Set();
  const commandRegistrations = new Set(); // { name, callback } — survive re-init
  let syncedRootId = null;
  let renderedCamera = null;
  let clientCamera = null;
  let cameraInteractionDepth = 0;
  let cameraReportInteractionDepth = 0;
  let cameraReportOptions = { during: "none", terminal: true };
  let pendingCameraReport = false;
  let cameraReportFrame = 0;
  const distanceToCameraGlyphs = createDistanceToCameraGlyphRegistry();
  const pickables = createPickableRegistry();
  const pointCloudLods = new Map();
  const pointCloudPresentations = new Map();
  // --- phase0-bench (removable; see app/telesculptor_web/app/bench/README.md) ---
  // Most recent paint wall-time reported by the view, surfaced through
  // getSyncDiagnostics(). Assignment only — no work added to the render path.
  let lastVtkPaintMs = null;
  let lastVtkPaintAt = null;
  let vtkPaintSequence = 0;
  let hostFrameFeedbackSeen = false;
  // --- end phase0-bench ---

  function getRenderer() {
    return getPrimaryRenderer(getRenderWindow?.() || null);
  }

  function getRenderers() {
    return getSyncedRenderers(getRenderWindow?.() || null);
  }

  function bindPrimaryCameraToRenderers() {
    const renderer = getRenderer();
    let camera = renderer?.getActiveCamera?.();
    if (!renderer || !camera) {
      return { renderer: null, camera: null };
    }

    if (cameraAuthority !== "client") {
      return { renderer, camera };
    }

    if (clientCamera?.isDeleted?.()) {
      clientCamera = null;
    }
    if (!clientCamera) {
      clientCamera = camera;
    }
    camera = clientCamera;

    for (const sibling of getRenderers()) {
      if (
        sibling.getActiveCamera?.() !== camera &&
        typeof sibling.setActiveCamera === "function"
      ) {
        sibling.setActiveCamera(camera);
      }
    }
    return { renderer, camera };
  }

  function noteMessageApplied(message) {
    if (!message) return;
    messageAppliedCallback?.(message);
    sceneAppliedCallbacks.forEach((callback) => callback(message));
  }

  function onSceneApplied(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    sceneAppliedCallbacks.add(callback);
    return () => {
      sceneAppliedCallbacks.delete(callback);
    };
  }

  // Register a handler for server commands riding scene.ops broadcasts.
  // Registrations survive re-initialization of the underlying engine.
  function onCommand(name, callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const registration = { name, callback, detach: null };
    commandRegistrations.add(registration);
    if (engine) {
      registration.detach = engine.onCommand(name, callback);
    }
    return () => {
      commandRegistrations.delete(registration);
      registration.detach?.();
      registration.detach = null;
    };
  }

  function getInstance(id) {
    if (id === undefined || id === null) return null;
    return (
      managedSyncContext?.synchronizerContext?.getInstance?.(String(id)) ?? null
    );
  }

  // Stage a texture source for this view's external-texture registry;
  // vtkProjectedTextureMapper instances resolve it by textureKey at render
  // time. Upload happens on the next render — triggering that render stays
  // the caller's job.
  function uploadTexture(key, source, options = {}) {
    const registry = getExternalTextures(getRenderWindow?.() || null);
    if (!registry || key == null) {
      return false;
    }
    registry.setSource(key, source, options);
    return true;
  }

  function requestResync(reason = "scene-sync") {
    engine?.resync?.(reason);
  }

  function getQueueLength() {
    return engine?.getDiagnostics?.().bufferLength ?? 0;
  }

  function setCamera(params) {
    const { camera } = bindPrimaryCameraToRenderers();
    if (!camera) return;
    renderedCamera = null;
    applyCameraParams(camera, params);
    renderScene?.();
  }

  function applyCameraIntent(params) {
    const { camera } = bindPrimaryCameraToRenderers();
    if (!camera || !params) return false;
    reconciler?.flushDeferredProps?.();
    renderedCamera = null;
    applyCameraParams(camera, params);
    camera.modified?.();
    return true;
  }

  function matrixCopy16(value) {
    if (!value || value.length !== 16) return null;
    const copy = Array.from(value, Number);
    return copy.every((v) => Number.isFinite(v)) ? copy : null;
  }

  function setRenderedCamera({
    viewMatrix,
    projectionMatrix,
    clippingRange,
    physicalScale,
  } = {}) {
    const { camera } = bindPrimaryCameraToRenderers();
    const recordedViewMatrix = matrixCopy16(viewMatrix);
    const recordedProjectionMatrix = matrixCopy16(projectionMatrix);
    if (!camera || !recordedViewMatrix || !recordedProjectionMatrix)
      return false;

    renderedCamera = {
      viewMatrix: recordedViewMatrix,
      projectionMatrix: recordedProjectionMatrix,
    };
    camera.setViewMatrix(recordedViewMatrix.slice());
    camera.setProjectionMatrix(recordedProjectionMatrix.slice());
    if (
      Array.isArray(clippingRange) &&
      clippingRange.length >= 2 &&
      Number.isFinite(clippingRange[0]) &&
      Number.isFinite(clippingRange[1]) &&
      clippingRange[1] > clippingRange[0]
    ) {
      camera.setClippingRange?.(clippingRange[0], clippingRange[1]);
    }
    if (Number.isFinite(physicalScale)) {
      camera.setPhysicalScale?.(physicalScale);
    }
    camera.modified?.();
    return true;
  }

  function getRenderedCamera() {
    if (!renderedCamera) return null;
    const rendererViewport = getRenderer()?.getViewport?.();
    const views = getRenderWindow?.()?.getViews?.() || [];
    const view = views.length > 0 ? views[0] : null;
    const size = view?.getSize?.();
    return {
      viewMatrix: renderedCamera.viewMatrix.slice(),
      projectionMatrix: renderedCamera.projectionMatrix.slice(),
      rendererViewport: rendererViewport
        ? Array.from(rendererViewport, Number)
        : null,
      size: size ? Array.from(size, Number) : null,
    };
  }

  function resetCamera() {
    const { renderer } = bindPrimaryCameraToRenderers();
    if (!renderer) return;
    renderedCamera = null;
    renderer.resetCamera();
    renderScene?.();
  }

  function applyCameraResetIntent() {
    const { renderer } = bindPrimaryCameraToRenderers();
    if (!renderer) return false;
    reconciler?.flushDeferredProps?.();
    renderedCamera = null;
    renderer.resetCamera();
    return true;
  }

  function cleanupSyncContext() {
    engine?.stop?.();
    engine = null;
    reconciler?.teardown?.();
    reconciler = null;
    mirror = null;
    blobCache = null;
    messageAppliedCallback = null;
    renderRequestCallback = null;
    syncedRootId = null;
    clientCamera = null;
    cameraInteractionDepth = 0;
    renderedCamera = null;
    cancelCameraReport();
    distanceToCameraGlyphs.clear();
    pickables.clear();
    disposePointCloudLods(pointCloudLods);
    pointCloudPresentations.clear();
    // --- phase0-bench (removable; see app/telesculptor_web/app/bench/README.md) ---
    lastVtkPaintMs = null;
    lastVtkPaintAt = null;
    vtkPaintSequence = 0;
    hostFrameFeedbackSeen = false;
    // --- end phase0-bench ---
    managedSyncContext?.cleanup?.();
    managedSyncContext = null;
  }

  function initialize({
    contextName,
    renderWindowId,
    onRenderNeeded,
    onMessageApplied,
  }) {
    disposed = false;
    cleanupSyncContext();
    messageAppliedCallback = onMessageApplied || null;
    renderRequestCallback = onRenderNeeded || null;
    syncedRootId = renderWindowId !== undefined ? String(renderWindowId) : null;

    managedSyncContext = createManagedSyncContextImpl(
      contextName,
      getRenderWindow(),
    );
    const { synchronizerContext, syncRenderWindow } = managedSyncContext;

    mirror = createMirrorStoreImpl();
    blobCache = new Map();
    reconciler = createReconcilerImpl({
      synchronizerContext,
      objectManager: vtkObjectManagerImpl,
      rootId: syncedRootId,
      rootInstance: syncRenderWindow,
      shouldDeferProps: (_id, node) =>
        cameraAuthority === "server" &&
        cameraInteractionDepth > 0 &&
        node?.type === "vtkCamera",
    });

    reconciler.registerBlockHandler(
      PICKABLE_BLOCK_KEY,
      (nodeId, block, instance) => {
        if (!block) {
          gestures.cancelForNode(nodeId);
          if (dragPreview.targets(nodeId)) dragPreview.end();
        }
        return applyPickableBlock(pickables, nodeId, block, instance);
      },
    );
    reconciler.registerBlockHandler(
      DISTANCE_TO_CAMERA_BLOCK_KEY,
      (nodeId, block, instance) =>
        applyDistanceToCameraBlock(
          distanceToCameraGlyphs,
          nodeId,
          block,
          instance,
          synchronizerContext,
        ),
    );
    // Projected-texture props ride the block; the instance is already the
    // fork's mapper subclass (the node's type selects it).
    reconciler.registerBlockHandler(
      PROJECTED_TEXTURE_BLOCK_KEY,
      (nodeId, block, instance) => {
        if (block && typeof instance?.set === "function") {
          instance.set(block);
        }
      },
    );
    reconciler.registerBlockHandler(
      POINT_CLOUD_LOD_BLOCK_KEY,
      (nodeId, block, instance) =>
        applyPointCloudLodBlock(pointCloudLods, nodeId, block, instance, () =>
          renderRequestCallback?.(),
        ),
    );
    reconciler.registerBlockHandler(
      POINT_CLOUD_PRESENTATION_BLOCK_KEY,
      (nodeId, block, instance) =>
        applyPointCloudPresentationBlock(
          pointCloudPresentations,
          nodeId,
          block,
          instance,
        ),
    );

    engine = createSceneEngineImpl({
      client,
      rwId: syncedRootId,
      reconciler,
      mirror,
      cache: blobCache,
      callbacks: {
        beforeSnapshot() {
          if (!disposed) emit?.("beforeSceneLoaded");
        },
        afterSnapshot() {
          if (!disposed) emit?.("afterSceneLoaded");
        },
        onSnapshotApplied(snapshot) {
          if (disposed) return;
          bindPrimaryCameraToRenderers();
          updateDistanceToCameraGlyphsForRender();
          updatePointCloudLodsForRender();
          dragPreview.reapply();
          emit?.("updated");
          noteMessageApplied({ kind: "snapshot", seq: snapshot.seq });
          if (!snapshot.commands?.some((command) => command?.render === true)) {
            renderRequestCallback?.();
          }
        },
        onApplied(message) {
          if (disposed) return;
          bindPrimaryCameraToRenderers();
          updateDistanceToCameraGlyphsForRender();
          updatePointCloudLodsForRender();
          dragPreview.reapply();
          noteMessageApplied(message);
          if (!Array.isArray(message?.ops) || message.ops.length) {
            renderRequestCallback?.();
          }
        },
        onRenderRequested() {
          if (!disposed) renderRequestCallback?.();
        },
        onCommand(name, payload) {
          if (!disposed) emit?.("command", { name, payload });
        },
      },
    });
    engine.onCommand("camera.set", applyCameraIntent);
    engine.onCommand("camera.reset", applyCameraResetIntent);
    for (const registration of commandRegistrations) {
      registration.detach = engine.onCommand(
        registration.name,
        registration.callback,
      );
    }
    engine.start();
    gestures.bindHoverCanvas();
  }

  function cleanup() {
    disposed = true;
    // Force-end any drag in flight so its window listeners and pointer capture
    // don't outlive the view.
    gestures.teardown();
    cancelCameraReport();
    dragPreview.end();
    // The GL context is shared across views and outlives this one, so its
    // textures must be deleted explicitly, before the render window goes away.
    peekExternalTextures(getRenderWindow?.() || null)?.clear();
    cleanupSyncContext();
    sceneAppliedCallbacks.clear();
  }

  function getSyncDiagnostics() {
    const {
      mySeq = -1,
      live = false,
      cacheSize = 0,
      mirrorSize = 0,
      lastAppliedOp = null,
      bufferLength = 0,
    } = engine?.getDiagnostics?.() ?? {};
    let cacheBytes = 0;
    if (blobCache) {
      for (const value of blobCache.values()) {
        if (value && typeof value.byteLength === "number") {
          cacheBytes += value.byteLength;
        }
      }
    }
    return {
      mySeq,
      live,
      cacheSize,
      cacheBytes,
      mirrorSize,
      lastAppliedOp,
      queueLength: bufferLength,
      syncedRootId,
      distanceToCamera: describeDistanceToCameraGlyphRegistry(
        distanceToCameraGlyphs,
      ),
      pickables: describePickableRegistry(pickables),
      externalTextures: peekExternalTextures(
        getRenderWindow?.() || null,
      )?.describe() ?? { size: 0, entries: [] },
      // --- phase0-bench (removable; see app/telesculptor_web/app/bench/README.md) ---
      pointCloudLod: describePointCloudLodRegistry(pointCloudLods),
      lastVtkPaintMs,
      lastVtkPaintAt,
      vtkPaintSequence,
      // --- end phase0-bench ---
    };
  }

  function getAppliedSceneState(rwId) {
    const id = rwId !== undefined ? String(rwId) : syncedRootId;
    if (!id || !mirror || !managedSyncContext?.synchronizerContext) return null;
    return dumpAppliedScene(
      id,
      mirror,
      managedSyncContext.synchronizerContext,
      reconciler?.getBoundArray,
    );
  }

  function updateDistanceToCameraGlyphsForRender() {
    // No cache invalidation here: the pickable projection cache is keyed on
    // viewport size, points mtime, and the world-to-clip matrix, so a render
    // that changed any of them misses the cache on its own — and a render
    // that changed none of them (server playback under a hovering pointer)
    // must keep the hit-test cache warm.
    return updateDistanceToCameraGlyphs(distanceToCameraGlyphs, {
      renderer: getRenderer(),
      renderWindow: getRenderWindow?.(),
      synchronizerContext: managedSyncContext?.synchronizerContext,
    });
  }

  function updatePointCloudLodsForRender() {
    // Camera + anchor-actor fan-out for streamed LOD point clouds; the
    // controller debounces selection internally, so per-message and
    // per-interactor-render calls stay cheap.
    updatePointCloudPresentations(pointCloudPresentations);
    return updatePointCloudLods(pointCloudLods, {
      renderers: getRenderers(),
      renderWindow: getRenderWindow?.(),
      scheduleRender: () => renderRequestCallback?.(),
    });
  }

  // The view measures each paint's wall-time and reports it here; it feeds the
  // adaptive-quality budget loop for any streamed LOD cloud (a no-op when no
  // cloud has adaptive enabled).
  function recordFrameDuration(durationMs) {
    // --- phase0-bench (removable; see app/telesculptor_web/app/bench/README.md) ---
    if (Number.isFinite(durationMs)) {
      lastVtkPaintMs = durationMs;
      lastVtkPaintAt = performance.now();
      vtkPaintSequence += 1;
    }
    // --- end phase0-bench ---
    if (!hostFrameFeedbackSeen) {
      recordPointCloudLodFrame(pointCloudLods, durationMs);
    }
  }

  function recordHostFrame(metrics) {
    hostFrameFeedbackSeen = true;
    if (Number.isFinite(metrics?.vtkFrameMs)) {
      lastVtkPaintMs = metrics.vtkFrameMs;
      lastVtkPaintAt = performance.now();
      vtkPaintSequence += 1;
    }
    recordPointCloudLodHostFrame(pointCloudLods, metrics);
  }

  // Answer "what pickable glyph point is under (cssX, cssY)" from what this
  // view actually rendered. Coordinates are canvas CSS px, top-left origin.
  function pickAt(cssX, cssY) {
    return pickAtRegistry(pickables, cssX, cssY, {
      renderer: getRenderer(),
      renderWindow: getRenderWindow?.(),
      synchronizerContext: managedSyncContext?.synchronizerContext,
    });
  }

  // The camera matrices this view last rendered with, in the flat layout the
  // consuming server already speaks (the same arrays setRenderedCamera stored).
  // Null until a rendered camera has been pushed. Read at event time so a
  // gesture payload is self-contained — it carries its own frame.
  function readGestureCamera() {
    const rendered = getRenderedCamera();
    if (rendered) {
      return {
        viewMatrix: rendered.viewMatrix,
        projectionMatrix: rendered.projectionMatrix,
      };
    }
    const camera = bindPrimaryCameraToRenderers().camera;
    const metrics = getViewportMetrics(getRenderer(), getRenderWindow?.());
    const view = matrixCopy16(camera?.getViewMatrix?.());
    const projection = matrixCopy16(
      camera?.getProjectionMatrix?.(metrics?.aspect ?? 1, -1, 1),
    );
    return view && projection
      ? { viewMatrix: view, projectionMatrix: projection }
      : null;
  }

  // The applied scene seq (the engine's cursor). Stamped onto every upstream
  // event at build time so the server can run its generic staleness check;
  // null (stale by construction) until the engine exists.
  function getSeq() {
    return engine?.getSeq?.() ?? null;
  }

  // The rendered viewport in canvas CSS px plus its device-pixel ratio, matching
  // the space pickAt measures pointer coordinates in.
  function readGestureViewport() {
    const metrics = getViewportMetrics(getRenderer(), getRenderWindow?.());
    if (!metrics) return null;
    return {
      width: metrics.width,
      height: metrics.height,
      dpr: getDevicePixelRatio(),
    };
  }

  function getViewCanvas() {
    const view = getRenderWindow?.()?.getViews?.()?.[0];
    return view?.getCanvas?.() ?? null;
  }

  function requestFrame(callback) {
    return globalThis.window?.requestAnimationFrame?.(callback) || 0;
  }

  function cancelCameraReport() {
    if (cameraReportFrame) {
      globalThis.window?.cancelAnimationFrame?.(cameraReportFrame);
    }
    cameraReportFrame = 0;
    pendingCameraReport = false;
  }

  function emitCameraReport(terminal = false) {
    const camera = bindPrimaryCameraToRenderers().camera;
    if (!camera) return false;
    emit?.("camera", {
      ...extractCameraParams(camera),
      seq: getSeq(),
      viewport: readGestureViewport(),
      terminal: !!terminal,
    });
    return true;
  }

  function flushCameraReport() {
    cameraReportFrame = 0;
    if (!pendingCameraReport) return;
    pendingCameraReport = false;
    emitCameraReport(false);
  }

  function reportCamera({ terminal = false } = {}) {
    if (terminal) {
      cancelCameraReport();
      return cameraReportOptions.terminal ? emitCameraReport(true) : false;
    }
    if (cameraReportOptions.during !== "interaction") return false;
    pendingCameraReport = true;
    if (!cameraReportFrame) cameraReportFrame = requestFrame(flushCameraReport);
    return true;
  }

  function enableCameraReports({ during = "none", terminal = true } = {}) {
    if (!["interaction", "none"].includes(during)) {
      throw new Error("camera report 'during' must be 'interaction' or 'none'");
    }
    cameraReportOptions = { during, terminal: !!terminal };
    if (during === "none") cancelCameraReport();
  }

  // Camera interaction is reference-counted: overlapping gesture sources (e.g.
  // a wheel-idle timer and a drag) each begin/end independently, and the shared
  // camera channel must stay live until the LAST one ends. A boolean would let
  // one source's end silence another's in-flight reports.
  function beginCameraInteraction({ report = true } = {}) {
    cameraInteractionDepth += 1;
    if (report) cameraReportInteractionDepth += 1;
    if (cameraInteractionDepth === 1) {
      beginPointCloudLodInteraction(pointCloudLods);
    }
  }

  function cameraInteraction() {
    if (cameraReportInteractionDepth > 0) reportCamera();
  }

  function endCameraInteraction({ report = true } = {}) {
    if (cameraInteractionDepth === 0) return;
    cameraInteractionDepth -= 1;
    const reportEnded = report && cameraReportInteractionDepth > 0;
    if (reportEnded) cameraReportInteractionDepth -= 1;
    if (reportEnded && cameraReportInteractionDepth === 0) {
      reportCamera({ terminal: true });
    }
    if (cameraInteractionDepth > 0) return;
    endPointCloudLodInteraction(pointCloudLods);
    reconciler?.flushDeferredProps?.();
    renderRequestCallback?.();
  }

  const dragPreview = createDragPreview({
    getCamera: () => bindPrimaryCameraToRenderers().camera,
    getViewportMetrics: () =>
      getViewportMetrics(getRenderer(), getRenderWindow?.()),
    getBoundArray: (id, key) => reconciler?.getBoundArray?.(id, key),
    getInstance,
    getPickableIds: (nodeId) => pickables.get(nodeId)?.ids ?? null,
    requestRender: () => renderRequestCallback?.(),
  });

  // The drag/click gesture state machine. It emits semantic pointer events as a
  // Vue "pointerEvent"; each payload carries the pick, the pointer (grab-offset
  // applied on drags), and the camera/viewport/seq it was measured against.
  const gestures = createPickableGestures({
    pick: (cssX, cssY) => pickAt(cssX, cssY),
    readCamera: readGestureCamera,
    readViewport: readGestureViewport,
    readSeq: getSeq,
    getCanvas: getViewCanvas,
    emit: (payload) => emit?.("pointerEvent", payload),
    onDragStart: dragPreview.start,
    onDragMove: dragPreview.move,
    onDragEnd: dragPreview.end,
  });

  return {
    initialize,
    cleanup,
    requestResync,
    getQueueLength,
    getRenderWindow,
    getRenderer,
    getRenderers,
    setCamera,
    setRenderedCamera,
    getRenderedCamera,
    resetCamera,
    enableCameraReports,
    reportCamera,
    beginCameraInteraction,
    cameraInteraction,
    endCameraInteraction,
    onSceneApplied,
    onCommand,
    getInstance,
    getSeq,
    uploadTexture,
    pickAt,
    startTargetDrag: gestures.startTargetDrag,
    emitTargetClick: gestures.emitTargetClick,
    setPointerContext: gestures.setPointerContext,
    setEmitBackgroundClick: gestures.setEmitBackgroundClick,
    setShouldGrab: gestures.setShouldGrab,
    setHoverEnabled: gestures.setHoverEnabled,
    updateDistanceToCameraGlyphs: updateDistanceToCameraGlyphsForRender,
    updatePointCloudLods: updatePointCloudLodsForRender,
    recordFrameDuration,
    recordHostFrame,
    getSyncDiagnostics,
    getAppliedSceneState,
  };
}
