import vtkObjectManager from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/ObjectManager";

import {
  createManagedSyncContext,
  getPrimaryRenderer,
  applyCameraParams,
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
import { createPickableGestures } from "./pickableGestures";
import { getExternalTextures, peekExternalTextures } from "./externalTextures";

const PROJECTED_TEXTURE_BLOCK_KEY = "projectedTexture";

export function useSceneSync(
  { client, emit, getRenderWindow, renderScene },
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
  const distanceToCameraGlyphs = createDistanceToCameraGlyphRegistry();
  const pickables = createPickableRegistry();

  function getRenderer() {
    return getPrimaryRenderer(getRenderWindow?.() || null);
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

  // State applies on message arrival; update() survives as a render request
  // for callers that used it to flush the v1 queue.
  function update() {
    renderRequestCallback?.();
    return Promise.resolve(false);
  }

  function setCamera(params) {
    const camera = getRenderer()?.getActiveCamera?.();
    if (!camera) return;
    applyCameraParams(camera, params);
    renderScene?.();
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
    const camera = getRenderer()?.getActiveCamera?.();
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
    const renderer = getRenderer();
    if (!renderer) return;
    renderer.resetCamera();
    renderScene?.();
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
    distanceToCameraGlyphs.clear();
    pickables.clear();
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
    });

    reconciler.registerBlockHandler(
      PICKABLE_BLOCK_KEY,
      (nodeId, block, instance) =>
        applyPickableBlock(pickables, nodeId, block, instance),
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
          updateDistanceToCameraGlyphsForRender();
          emit?.("updated");
          noteMessageApplied({ kind: "snapshot", seq: snapshot.seq });
          renderRequestCallback?.();
        },
        onApplied(message) {
          if (disposed) return;
          updateDistanceToCameraGlyphsForRender();
          noteMessageApplied(message);
          renderRequestCallback?.();
        },
        onCommand(name, payload) {
          if (!disposed) emit?.("command", { name, payload });
        },
      },
    });
    for (const registration of commandRegistrations) {
      registration.detach = engine.onCommand(
        registration.name,
        registration.callback,
      );
    }
    engine.start();
  }

  function cleanup() {
    disposed = true;
    // Force-end any drag in flight so its window listeners and pointer capture
    // don't outlive the view.
    gestures.teardown();
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
    return updateDistanceToCameraGlyphs(distanceToCameraGlyphs, {
      renderer: getRenderer(),
      renderWindow: getRenderWindow?.(),
      synchronizerContext: managedSyncContext?.synchronizerContext,
    });
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
    if (!rendered) return null;
    return {
      viewMatrix: rendered.viewMatrix,
      projectionMatrix: rendered.projectionMatrix,
    };
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
  });

  return {
    initialize,
    cleanup,
    update,
    requestResync,
    getQueueLength,
    getRenderWindow,
    getRenderer,
    setCamera,
    setRenderedCamera,
    getRenderedCamera,
    resetCamera,
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
    updateDistanceToCameraGlyphs: updateDistanceToCameraGlyphsForRender,
    getSyncDiagnostics,
    getAppliedSceneState,
  };
}
