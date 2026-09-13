import { isLiveInstance } from "./predicates";

function getRenderWindowRenderers(renderWindow, methodName = "getRenderers") {
  if (!isLiveInstance(renderWindow)) {
    return [];
  }

  try {
    const renderers = renderWindow[methodName]?.();
    if (!Array.isArray(renderers)) {
      return [];
    }

    return renderers.filter((renderer) => isLiveInstance(renderer));
  } catch {
    return [];
  }
}

// Renderers that stand for server nodes, as opposed to ones a host added.
export function getSyncedRenderers(renderWindow, instances) {
  return getRenderWindowRenderers(renderWindow).filter(
    (renderer) => instances?.getInstanceId?.(renderer) != null,
  );
}

export function getPrimaryRenderer(renderWindow, instances) {
  return (
    getSyncedRenderers(renderWindow, instances)[0] ||
    getRenderWindowRenderers(renderWindow, "getRenderersByReference")[0] ||
    null
  );
}

const CAMERA_FIELDS = [
  {
    name: "position",
    getter: "getPosition",
    setter: "setPosition",
    spread: true,
  },
  {
    name: "focalPoint",
    getter: "getFocalPoint",
    setter: "setFocalPoint",
    spread: true,
  },
  { name: "viewUp", getter: "getViewUp", setter: "setViewUp", spread: true },
  {
    name: "viewAngle",
    getter: "getViewAngle",
    setter: "setViewAngle",
    spread: false,
  },
  {
    name: "parallelProjection",
    getter: "getParallelProjection",
    setter: "setParallelProjection",
    spread: false,
  },
  {
    name: "parallelScale",
    getter: "getParallelScale",
    setter: "setParallelScale",
    spread: false,
  },
  {
    name: "clippingRange",
    getter: "getClippingRange",
    setter: "setClippingRange",
    spread: true,
  },
];

export function extractCameraParams(camera) {
  const params = {};
  for (const { name, getter } of CAMERA_FIELDS) {
    params[name] = camera[getter]();
  }
  return params;
}

export function applyCameraParams(camera, params) {
  for (const { name, setter, spread } of CAMERA_FIELDS) {
    const value = params[name];
    if (value === undefined) continue;
    if (spread) {
      if (value) camera[setter](...value);
    } else {
      camera[setter](value);
    }
  }
}
