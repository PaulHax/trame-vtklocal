import {
  getPrimaryRenderer,
  getSyncedRenderers,
  applyCameraParams,
  extractCameraParams,
} from "./vtkJsSync";
import { createInstanceRegistry } from "./engine/instanceRegistry";
import { createMirrorStore } from "./engine/mirrorStore";
import { buildInstance } from "./instanceFactory";
import { createReconciler } from "./engine/reconcile";
import { createSceneEngine } from "./engine/sceneEngine";
import { dumpAppliedScene } from "./dumpAppliedScene";
import { registerBlockHandlers } from "./blockHandlers";
import { createCameraReports } from "./cameraReports";
import {
  createDistanceToCameraGlyphRegistry,
  describeDistanceToCameraGlyphRegistry,
  updateDistanceToCameraGlyphs,
} from "./distanceToCameraGlyphs";
import {
  createPickableRegistry,
  describePickableRegistry,
  pickAt as pickAtRegistry,
  resolvePickableMapper,
} from "./pickables";
import { getDevicePixelRatio, getViewportMetrics } from "./viewportMetrics";
import { createRegistrationGesture } from "./registrationGesture";
import {
  createStreamedSceneHost,
  enrichGestureWithCloudSolve,
} from "./streamedSceneHost";
import { updatePointCloudPresentations } from "./pointCloudPresentation";
import { createPickableGestures } from "./pickableGestures";
import { createDragPreview } from "./dragPreview";
import { createPresentationFeedback } from "./presentationFeedback";
import { getExternalTextures, peekExternalTextures } from "./externalTextures";

export function useSceneSync(
  {
    client,
    emit,
    getRenderWindow,
    getOpenGLRenderWindow,
    tiles3dTexturePolicy = "auto",
    tiles3dQualityPolicy = "adaptive",
  },
  dependencies = {},
) {
  const {
    createInstanceRegistry: createInstanceRegistryImpl = createInstanceRegistry,
    createMirrorStore: createMirrorStoreImpl = createMirrorStore,
    createReconciler: createReconcilerImpl = createReconciler,
    createSceneEngine: createSceneEngineImpl = createSceneEngine,
    buildInstance: buildInstanceImpl = buildInstance,
    createStreamedSceneHost:
      createStreamedSceneHostImpl = createStreamedSceneHost,
  } = dependencies;

  let instances = null;
  let engine = null;
  let reconciler = null;
  let clearCoincidentTopology = null;
  let mirror = null;
  let blobCache = null;
  let disposed = false;
  let messageAppliedCallback = null;
  let renderRequestCallback = null;
  const sceneAppliedCallbacks = new Set();
  const commandRegistrations = new Set(); // { name, callback } — survive re-init
  const sceneGates = new Set(); // hold predicates — survive re-init
  let syncedRootId = null;
  let renderedCamera = null;
  let clientCamera = null;
  let appliedCameraIntent = null;
  const distanceToCameraGlyphs = createDistanceToCameraGlyphRegistry();
  const pickables = createPickableRegistry();
  let streamedSceneHost = null;
  const pointCloudPresentations = new Map();
  // Server-pushed armed pick spec: while set, click gestures solve cloud
  // depth against this asset id instead of the picked glyph's tag. View
  // state, not scene-sync state: the server owns it and only its pushes may
  // change it, so a scene re-initialization must not silently disarm.
  const registrationGesture = createRegistrationGesture();
  const appliedCommands = new Map();
  const presentation = createPresentationFeedback({
    getRenderWindow: () => getRenderWindow?.() || null,
    getStreamedSceneHost: () => streamedSceneHost,
    getSceneSeq: () => engine?.getDiagnostics?.()?.mySeq ?? -1,
    requestRender: () => renderRequestCallback?.(),
  });
  const cameraReports = createCameraReports({
    readReport: () => {
      const camera = bindPrimaryCameraToRenderers().camera;
      if (!camera) return null;
      return {
        ...extractCameraParams(camera),
        seq: getSeq(),
        viewport: readGestureViewport(),
      };
    },
    emit: (report) => emit?.("camera", report),
    onInteractionStart: () => streamedSceneHost?.beginInteraction(),
    onInteractionEnd: () => {
      streamedSceneHost?.endInteraction();
      renderRequestCallback?.();
    },
  });

  function ensureStreamedSceneHost() {
    if (!streamedSceneHost) {
      streamedSceneHost = createStreamedSceneHostImpl({
        scheduleRender: () => renderRequestCallback?.(),
        tiles3dTexturePolicy,
        tiles3dQualityPolicy,
      });
      if (cameraReports.isInteracting()) {
        streamedSceneHost.beginInteraction();
      }
    }
    return streamedSceneHost;
  }

  function getRenderer() {
    return getPrimaryRenderer(getRenderWindow?.() || null, instances);
  }

  function getRenderers() {
    return getSyncedRenderers(getRenderWindow?.() || null, instances);
  }

  function bindPrimaryCameraToRenderers() {
    const renderer = getRenderer();
    let camera = renderer?.getActiveCamera?.();
    if (!renderer || !camera) {
      return { renderer: null, camera: null };
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

  // hold(message) answers whether an ops message must wait for a resource
  // the caller has not received yet. Held messages apply in order when the
  // caller retries, or at the engine's deadline. Disposing a gate releases
  // whatever it held.
  function registerSceneGate(hold) {
    if (typeof hold !== "function") {
      return () => {};
    }
    sceneGates.add(hold);
    return () => {
      sceneGates.delete(hold);
      engine?.retryHeld?.();
    };
  }

  function retrySceneGate() {
    engine?.retryHeld?.();
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
    return instances?.getInstance?.(String(id)) ?? null;
  }

  // Which desired nodes name `nodeId` in the given ref slot. The mirror
  // maintains the reverse index as operations land, so association queries
  // are proportional to actual referrers rather than scene size.
  function referrersOf(nodeId, slot) {
    return mirror?.referrersOf?.(nodeId, slot) || [];
  }

  function getSceneTopologyVersion() {
    return (
      (mirror?.refRevision?.() ?? 0) + (instances?.instanceRevision?.() ?? 0)
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

  // Release one caller-owned external texture without disturbing any other
  // texture in this render window.  This is the lifetime twin of
  // uploadTexture: closing one video consumer must not clear a sibling source.
  function removeTexture(key) {
    const registry = getExternalTextures(getRenderWindow?.() || null);
    if (!registry || key == null) {
      return false;
    }
    registry.removeKey(key);
    return true;
  }

  function getQueueLength() {
    return engine?.getDiagnostics?.().bufferLength ?? 0;
  }

  function applyCameraIntent(params) {
    const { camera } = bindPrimaryCameraToRenderers();
    if (!camera || !params) return false;
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

  function applyCameraResetIntent() {
    const { renderer } = bindPrimaryCameraToRenderers();
    if (!renderer) return false;
    renderedCamera = null;
    renderer.resetCamera();
    return true;
  }

  // A resync snapshot replays the retained camera command. When this sync
  // already applied that exact command, the user has since owned the camera,
  // so the replay must not snap it back.
  function cameraCommand(apply) {
    return (payload, name, { snapshot = false } = {}) => {
      const intent = JSON.stringify([name, payload ?? null]);
      if (snapshot && intent === appliedCameraIntent) return false;
      const applied = apply(payload);
      if (applied) appliedCameraIntent = intent;
      return applied;
    };
  }

  function cleanupSyncContext() {
    appliedCommands.clear();
    engine?.stop?.();
    engine = null;
    clearCoincidentTopology?.();
    clearCoincidentTopology = null;
    reconciler?.teardown?.();
    reconciler = null;
    mirror = null;
    blobCache = null;
    messageAppliedCallback = null;
    renderRequestCallback = null;
    syncedRootId = null;
    clientCamera = null;
    appliedCameraIntent = null;
    cameraReports.reset();
    renderedCamera = null;
    distanceToCameraGlyphs.clear();
    pickables.clear();
    streamedSceneHost?.dispose();
    streamedSceneHost = null;
    pointCloudPresentations.clear();
    presentation.reset();
    instances = null;
  }

  function initialize({ renderWindowId, onRenderNeeded, onMessageApplied }) {
    disposed = false;
    cleanupSyncContext();
    messageAppliedCallback = onMessageApplied || null;
    renderRequestCallback = onRenderNeeded || null;
    syncedRootId = renderWindowId !== undefined ? String(renderWindowId) : null;

    instances = createInstanceRegistryImpl();
    mirror = createMirrorStoreImpl();
    blobCache = new Map();
    reconciler = createReconcilerImpl({
      instances,
      buildInstance: buildInstanceImpl,
      rootId: syncedRootId,
      rootInstance: getRenderWindow(),
    });

    clearCoincidentTopology = registerBlockHandlers(reconciler, {
      pickables,
      onPickableRemoved: (nodeId) => {
        gestures.cancelForNode(nodeId);
        if (dragPreview.targets(nodeId)) dragPreview.end();
      },
      distanceToCameraGlyphs,
      pointCloudPresentations,
      getStreamedSceneHost: () => streamedSceneHost,
      ensureStreamedSceneHost,
    });

    engine = createSceneEngineImpl({
      client,
      rwId: syncedRootId,
      reconciler,
      mirror,
      cache: blobCache,
      gate: {
        hold: (message) => {
          for (const hold of sceneGates) {
            if (hold(message) === true) return true;
          }
          return false;
        },
      },
      callbacks: {
        beforeSnapshot() {
          appliedCommands.clear();
          dragPreview.end();
          if (!disposed) emit?.("beforeSceneLoaded");
        },
        afterSnapshot() {
          if (!disposed) emit?.("afterSceneLoaded");
        },
        onSnapshotApplied(snapshot) {
          if (disposed) return;
          afterApply(snapshot);
          emit?.("updated");
          noteMessageApplied({ kind: "snapshot", seq: snapshot.seq });
          presentation.requireScenePaint(snapshot);
          if (!snapshot.commands?.some((command) => command?.render === true)) {
            renderRequestCallback?.();
          }
        },
        onApplied(message) {
          if (disposed) return;
          afterApply(message);
          noteMessageApplied(message);
          if (!Array.isArray(message?.ops) || message.ops.length) {
            presentation.requireScenePaint(message);
            renderRequestCallback?.();
          }
        },
        onRenderRequested(message) {
          if (!disposed) {
            presentation.requireScenePaint(message);
            renderRequestCallback?.();
          }
        },
        onCommand(name, payload) {
          if (!disposed) {
            if (payload == null) appliedCommands.delete(name);
            else appliedCommands.set(name, payload);
            emit?.("command", { name, payload });
          }
        },
      },
    });
    engine.onCommand("camera.set", cameraCommand(applyCameraIntent));
    engine.onCommand("camera.reset", cameraCommand(applyCameraResetIntent));
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
    cameraReports.cancel();
    dragPreview.end();
    // The GL context is shared across views and outlives this one, so its
    // textures must be deleted explicitly, before the render window goes away.
    peekExternalTextures(getRenderWindow?.() || null)?.clear();
    cleanupSyncContext();
    sceneAppliedCallbacks.clear();
    presentation.dispose();
    sceneGates.clear();
  }

  function getSyncDiagnostics() {
    const {
      mySeq = -1,
      live = false,
      cacheSize = 0,
      mirrorSize = 0,
      lastAppliedOp = null,
      bufferLength = 0,
      heldLength = 0,
    } = engine?.getDiagnostics?.() ?? {};
    let cacheBytes = 0;
    if (blobCache) {
      for (const value of blobCache.values()) {
        if (value && typeof value.byteLength === "number") {
          cacheBytes += value.byteLength;
        }
      }
    }
    const appliedIdentity = instances?.describe?.() ?? {
      instanceRevision: 0,
      records: [],
    };
    return {
      mySeq,
      live,
      cacheSize,
      cacheBytes,
      mirrorSize,
      lastAppliedOp,
      queueLength: bufferLength,
      heldLength,
      syncedRootId,
      rendering: presentation.describe(),
      appliedIdentity: {
        ...appliedIdentity,
        records: appliedIdentity.records.map((record) => ({
          ...record,
          desiredType: mirror?.get?.(record.id)?.type ?? null,
          referrerCount: mirror?.referrerCount?.(record.id) ?? 0,
        })),
      },
      distanceToCamera: describeDistanceToCameraGlyphRegistry(
        distanceToCameraGlyphs,
      ),
      pickables: describePickableRegistry(pickables),
      streamedScene: streamedSceneHost?.describe() ?? {
        members: [],
        coordinator: null,
      },
      externalTextures: peekExternalTextures(
        getRenderWindow?.() || null,
      )?.describe() ?? { size: 0, entries: [] },
    };
  }

  function getAppliedSceneState(rwId) {
    const id = rwId !== undefined ? String(rwId) : syncedRootId;
    if (!id || !mirror || !instances) return null;
    return dumpAppliedScene(id, mirror, instances, reconciler?.getBoundArray);
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
      instances,
    });
  }

  function updateStreamedSceneForRender(frameSerial) {
    updatePointCloudPresentations(pointCloudPresentations);
    streamedSceneHost?.beforeRender({
      renderers: getRenderers(),
      renderWindow: getRenderWindow?.(),
      openGLRenderWindow: getOpenGLRenderWindow?.(),
      referrersOf,
      getInstance,
      topologyVersion: getSceneTopologyVersion(),
      frameSerial,
    });
  }

  // Move previewable point arrays onto private runtime buffers while applying
  // scene state, before a pointer can grab them. This keeps pointer moves free
  // of whole-array copies and keeps the blob cache canonical.
  function protectPreviewBindings() {
    for (const entry of pickables.values()) {
      if (!entry.preview) continue;
      const mapper = resolvePickableMapper(entry, instances);
      const points = mapper?.getInputData?.(0);
      const pointsNodeId = instances?.getInstanceId?.(points);
      if (pointsNodeId !== undefined && pointsNodeId !== null) {
        reconciler?.protectLocalWrites?.(String(pointsNodeId), "points");
      }
    }
  }

  // Apply all scene-derived render state before painting.
  function beforeRender() {
    const frameSerial = presentation.preparePaint();
    updateDistanceToCameraGlyphsForRender();
    updateStreamedSceneForRender(frameSerial);
  }

  // The post-apply pass every applied message runs, snapshot or ops. Applying
  // scene state schedules a paint through the engine callbacks; streaming work
  // belongs to that paint's pre-render pass, never to websocket message count.
  function afterApply(message) {
    bindPrimaryCameraToRenderers();
    protectPreviewBindings();
    dragPreview.reapply(message);
  }

  // Answer "what pickable glyph point is under (cssX, cssY)" from what this
  // view actually rendered. Coordinates are canvas CSS px, top-left origin.
  function pickAt(cssX, cssY) {
    return pickAtRegistry(pickables, cssX, cssY, {
      renderer: getRenderer(),
      renderWindow: getRenderWindow?.(),
      instances,
    });
  }

  // Solve cloud depth under (cssX, cssY) against the ONE streamed LOD cloud
  // whose durable sourceAssetId matches — the query is scoped, never "the
  // frontmost cloud". Null means unavailable; only an explicit
  // {status: "miss"} authorizes a caller's fallback.
  function pickCloudPoint(sourceAssetId, cssX, cssY) {
    return streamedSceneHost?.pickAsset(sourceAssetId, cssX, cssY) ?? null;
  }

  // Arm (or disarm with null) the click-time cloud-solve override. While
  // armed, the id is authoritative for target/background clicks — the app
  // has explicitly named which cloud a click means, so no glyph tag under
  // the cursor may redirect it. Drags are untouched.
  function setArmedCloudPick(spec) {
    return registrationGesture.set(spec);
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
    // Runs synchronously after rAF coalescing, on the payload's own pointer
    // (grab offset already applied): the solved ray is exactly the one the
    // server would otherwise resolve for this event.
    enrichPayload: (payload) => {
      const captured = registrationGesture.capture();
      return enrichGestureWithCloudSolve(
        { ...payload, registration_token: captured.token },
        pickCloudPoint,
        captured.asset_id,
      );
    },
    emit: (payload) => emit?.("pointerEvent", payload),
    onDragStart: dragPreview.start,
    onDragMove: dragPreview.move,
    onDragEnd: dragPreview.end,
  });

  return {
    initialize,
    cleanup,
    getQueueLength,
    getRenderWindow,
    getRenderer,
    getRenderers,
    setRenderedCamera,
    getRenderedCamera,
    enableCameraReports: cameraReports.enable,
    reportCamera: cameraReports.report,
    beginCameraInteraction: cameraReports.begin,
    cameraInteraction: cameraReports.interaction,
    endCameraInteraction: cameraReports.end,
    onSceneApplied,
    onPaintCompleted: presentation.onPaintCompleted,
    registerSceneGate,
    retrySceneGate,
    getAppliedCommand: (name) => appliedCommands.get(name),
    onCommand,
    uploadTexture,
    removeTexture,
    pickAt,
    pickCloudPoint,
    setArmedCloudPick,
    startTargetDrag: gestures.startTargetDrag,
    emitTargetClick: gestures.emitTargetClick,
    setPointerContext: gestures.setPointerContext,
    setEmitBackgroundClick: gestures.setEmitBackgroundClick,
    setShouldGrab: gestures.setShouldGrab,
    beforeRender,
    recordFrameDuration: presentation.recordFrameDuration,
    recordPaintDuration: presentation.recordPaintDuration,
    recordHostFrame: presentation.recordHostFrame,
    requestFrameIfNeeded: presentation.requestFrameIfNeeded,
    getSyncDiagnostics,
    getAppliedSceneState,
  };
}
