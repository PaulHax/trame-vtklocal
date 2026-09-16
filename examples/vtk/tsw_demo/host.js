/* MapLibre owns the canvas and camera; both VTK views share frame commands. */
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  while (
    !window.trameVtklocal?.whenView ||
    !window.maplibregl ||
    !window.glMatrix
  ) {
    await sleep(50);
  }
  const shared = await window.trameVtklocal.whenView("demoMap");
  const local = await window.trameVtklocal.whenView("demoLocal");
  while (!document.getElementById("map")) await sleep(50);
  const { mat4 } = glMatrix;
  const origin = maplibregl.MercatorCoordinate.fromLngLat([-74.006, 40.7128]);
  const scale = origin.meterInMercatorCoordinateUnits();
  const model = new Float64Array([
    scale,
    0,
    0,
    0,
    0,
    -scale,
    0,
    0,
    0,
    0,
    scale,
    0,
    origin.x,
    origin.y,
    0,
    1,
  ]);
  let styleGeneration = 0;
  const style = () => ({
    version: 8,
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: {
          "background-color": styleGeneration % 2 ? "#344337" : "#263345",
        },
      },
    ],
  });
  const map = new maplibregl.Map({
    container: "map",
    style: style(),
    center: [-74.006, 40.7128],
    zoom: 20,
    pitch: 45,
    bearing: 0,
    antialias: true,
  });
  const frames = { demoMap: null, demoLocal: null };
  const paints = { demoMap: null, demoLocal: null };
  const operations = { patchArray: 0 };
  let currentMapCamera = { bearing: 0, pitch: 45 };
  let initialized = false;
  let error = null;
  const detach = [];
  const decodedFrames = new Map();
  const timers = new Map();
  let textureDelayMs = 80;
  let mismatchedPaints = 0;
  const frameKey = (payload) => payload.frame + ":" + payload.generation;
  function stage(view, payload) {
    const source = decodedFrames.get(frameKey(payload));
    if (!source) {
      view.removeTexture("demo-video");
      return;
    }
    if (!view.uploadTexture("demo-video", source, { token: payload })) {
      error = "Texture staging failed";
    }
  }
  function requestTexture(payload) {
    const key = frameKey(payload);
    if (decodedFrames.has(key) || timers.has(key)) return;
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = payload.frame % 2 ? "#15b8bc" : "#ae4fc8";
        ctx.fillRect(0, 0, 256, 256);
        ctx.fillStyle = "#fff";
        ctx.font = "bold 90px sans-serif";
        ctx.fillText(String(payload.frame), 20, 150);
        decodedFrames.set(key, canvas);
        while (decodedFrames.size > 8)
          decodedFrames.delete(decodedFrames.keys().next().value);
        for (const view of [shared, local]) {
          view.retrySceneGate();
          const applied = view.getAppliedCommand("demo.frame");
          if (applied && frameKey(applied) === key) stage(view, applied);
        }
        local.getRenderWindow()?.render();
        map.triggerRepaint();
      }, textureDelayMs),
    );
  }
  for (const [name, view] of [
    ["demoMap", shared],
    ["demoLocal", local],
  ]) {
    detach.push(
      view.registerSceneGate((message) => {
        const payload = message.commands?.find(
          (c) => c.name === "demo.frame",
        )?.payload;
        if (!payload || decodedFrames.has(frameKey(payload))) return false;
        requestTexture(payload);
        return true;
      }),
    );
    detach.push(
      view.onCommand("demo.frame", (payload) => {
        frames[name] = payload;
        requestTexture(payload);
        stage(view, payload);
        map.triggerRepaint();
      }),
    );
    detach.push(
      view.onPaintCompleted((event) => {
        paints[name] = event;
        for (const texture of event.textures || []) {
          if (
            texture.key === "demo-video" &&
            texture.token &&
            frames[name] &&
            frameKey(texture.token) !== frameKey(frames[name])
          )
            mismatchedPaints += 1;
        }
        updateStatus();
      }),
    );
    detach.push(
      view.onSceneApplied((event) => {
        // Event shape is intentionally not used as proof of rendered pixels.
        operations.patchArray +=
          event?.ops?.filter((op) => op.op === "patchArray").length || 0;
      }),
    );
  }
  detach.push(
    shared.onCommand("demo.camera", (payload) => {
      currentMapCamera = payload;
      map.jumpTo(payload);
    }),
  );
  function updateStatus() {
    const el = document.getElementById("status");
    if (!el) return;
    const frame = frames.demoMap?.frame ?? "–";
    const texture = paints.demoMap?.textures?.find(
      (item) => item.key === "demo-video",
    );
    el.textContent =
      error ||
      "Geometry frame " +
        frame +
        " · painted texture " +
        (texture?.token?.frame ?? "–") +
        "\nDrag to orbit · scroll to zoom · inset shares the same actors";
  }
  shared.setRepaintCallback(() => map.triggerRepaint());
  shared.onRenderRequested(() => map.triggerRepaint());
  const layer = {
    id: "vtk-demo",
    type: "custom",
    renderingMode: "3d",
    onAdd(_map, gl) {
      // MapLibre style replacement re-adds the layer, but retains its GL context.
      if (!initialized) {
        shared.initializeForExternalContext(map.getCanvas(), gl);
        initialized = true;
        bindPointer(shared, map.getCanvas());
      }
    },
    render(gl, args) {
      const renderer = shared.getRenderer();
      if (!renderer) return;
      const cameraMerc = maplibregl.MercatorCoordinate.fromLngLat(
        map.transform.getCameraLngLat(),
        map.transform.getCameraAltitude(),
      );
      const target = maplibregl.MercatorCoordinate.fromLngLat(map.getCenter());
      const toScene = (p) => [
        (p.x - origin.x) / scale,
        -(p.y - origin.y) / scale,
        p.z / scale,
      ];
      const view = new Float64Array(16);
      const inverse = new Float64Array(16);
      const projection = new Float64Array(16);
      const combined = new Float64Array(16);
      mat4.lookAt(view, toScene(cameraMerc), toScene(target), [0, 0, 1]);
      mat4.invert(inverse, view);
      mat4.multiply(combined, args.defaultProjectionData.mainMatrix, model);
      mat4.multiply(projection, combined, inverse);
      shared.setRenderedCamera({
        viewMatrix: view,
        projectionMatrix: projection,
        clippingRange: [0.01, 10000],
        physicalScale: 30,
      });
      const front = gl.getParameter(gl.FRONT_FACE);
      try {
        shared.renderExternal();
      } finally {
        gl.frontFace(front);
      }
      shared.requestFrameIfNeeded();
    },
  };
  function bindPointer(view, canvas) {
    canvas.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button === 0) view.startTargetDrag(event);
      },
      true,
    );
    canvas.addEventListener("click", (event) => view.emitTargetClick(event));
  }
  map.on("style.load", () => {
    if (!map.getLayer(layer.id)) map.addLayer(layer);
    map.triggerRepaint();
  });
  map.on("error", (event) => {
    error = event.error?.message || String(event.error);
    updateStatus();
  });
  map.on("movestart", () => shared.beginCameraInteraction());
  map.on("move", () => shared.cameraInteraction());
  map.on("moveend", () => shared.endCameraInteraction());
  const localCanvas = () => document.querySelector("#inspector canvas");
  while (!localCanvas()) await sleep(50);
  bindPointer(local, localCanvas());
  window.tswDemo = {
    views: { demoMap: shared, demoLocal: local },
    map,
    diagnostics: () => ({
      frames,
      paints,
      error,
      operations,
      mismatchedPaints,
      map: shared.getSyncDiagnostics(),
      local: local.getSyncDiagnostics(),
    }),
    setTextureDelay(ms) {
      textureDelayMs = Math.max(0, Math.min(5000, ms));
    },
    reloadStyle() {
      styleGeneration += 1;
      map.setStyle(style());
    },
    armCloudPick() {
      shared.setArmedCloudPick({
        generation: Date.now(),
        asset_id: "demo-cloud",
        token: "demo",
      });
    },
    resetCamera() {
      map.jumpTo(currentMapCamera);
    },
  };
  window.addEventListener(
    "pagehide",
    () => {
      timers.forEach(clearTimeout);
      detach.forEach((fn) => fn());
      for (const view of [shared, local]) view.removeTexture("demo-video");
      map.remove();
    },
    { once: true },
  );
  window.trame.trigger("demo.ready");
})();
