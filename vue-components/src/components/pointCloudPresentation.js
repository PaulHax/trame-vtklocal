import { isLiveInstance } from "./predicates";
import { getDevicePixelRatio } from "./viewportMetrics";

export const POINT_CLOUD_PRESENTATION_BLOCK_KEY = "pointCloudPresentation";

export function applyPointCloudPresentationBlock(
  registry,
  nodeId,
  block,
  instance,
) {
  const id = String(nodeId);
  if (
    !block ||
    block.mode !== "fixed" ||
    !Number.isFinite(block.diameterCssPx) ||
    block.diameterCssPx <= 0 ||
    !isLiveInstance(instance)
  ) {
    registry.delete(id);
    return registry;
  }
  registry.set(id, { mapper: instance });
  instance.setScaleFactor?.(getDevicePixelRatio());
  return registry;
}

export function updatePointCloudPresentations(registry) {
  const ratio = getDevicePixelRatio();
  for (const [id, entry] of registry) {
    if (!isLiveInstance(entry.mapper)) {
      registry.delete(id);
      continue;
    }
    entry.mapper.setScaleFactor?.(ratio);
  }
}
