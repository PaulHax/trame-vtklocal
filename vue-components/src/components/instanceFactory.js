// Builds the vtk.js instance for a node's wire type. Synthetic types are named
// here so their wire identity cannot drift from the class they instantiate;
// every other type is a stock vtk.js class in vtk.js's own type table.
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkPointGaussianMapper from "@kitware/vtk.js/Rendering/Core/PointGaussianMapper";
import vtkObjectManager from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/ObjectManager";

import { newInstance as newProjectedTextureMapper } from "./projectedTextureMapper";

const SYNTHETIC_FACTORIES = Object.freeze({
  vtkStreamedSceneActor: vtkActor.newInstance,
  vtkProjectedTextureMapper: newProjectedTextureMapper,
  vtkPointGaussianMapper: vtkPointGaussianMapper.newInstance,
});

export function buildInstance(type) {
  const factory = SYNTHETIC_FACTORIES[type];
  return factory ? factory() : (vtkObjectManager.build(type) ?? null);
}

export default { buildInstance };
