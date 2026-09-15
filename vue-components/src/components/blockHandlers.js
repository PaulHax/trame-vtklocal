// The feature blocks a view understands, each routed to the registry that
// applies it. Handlers receive (nodeId, block | null, instance); a null block
// means the node lost the block or left the scene.

import {
  applyDistanceToCameraBlock,
  DISTANCE_TO_CAMERA_BLOCK_KEY,
} from "./distanceToCameraGlyphs";
import { applyPickableBlock, PICKABLE_BLOCK_KEY } from "./pickables";
import {
  applyPointCloudPresentationBlock,
  POINT_CLOUD_PRESENTATION_BLOCK_KEY,
} from "./pointCloudPresentation";
import { STREAMED_SCENE_BLOCK_KEY } from "./streamedSceneHost";
import {
  createCoincidentTopologyHandler,
  COINCIDENT_TOPOLOGY_BLOCK_KEY,
} from "./coincidentTopology";

const PROJECTED_TEXTURE_BLOCK_KEY = "projectedTexture";

export function registerBlockHandlers(
  reconciler,
  {
    pickables,
    onPickableRemoved = () => {},
    distanceToCameraGlyphs,
    pointCloudPresentations,
    getStreamedSceneHost,
    ensureStreamedSceneHost,
  },
) {
  const coincidentTopology = createCoincidentTopologyHandler();
  reconciler.registerBlockHandler(
    PICKABLE_BLOCK_KEY,
    (nodeId, block, instance) => {
      if (!block) onPickableRemoved(nodeId);
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
    COINCIDENT_TOPOLOGY_BLOCK_KEY,
    (_nodeId, block, instance) => coincidentTopology.apply(block, instance),
  );
  reconciler.registerBlockHandler(
    STREAMED_SCENE_BLOCK_KEY,
    (nodeId, block, instance) => {
      // No host and nothing to apply means there is also nothing to remove.
      if (!block && !getStreamedSceneHost()) return;
      ensureStreamedSceneHost().applyBlock(nodeId, block, instance);
    },
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
  return () => coincidentTopology.clear();
}

export default { registerBlockHandlers };
