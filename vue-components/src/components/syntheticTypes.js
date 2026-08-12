// Serialized synthetic types are registered in one place so their wire
// identity cannot drift from the renderable class instantiated by sync.
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkPointGaussianMapper from "@kitware/vtk.js/Rendering/Core/PointGaussianMapper";
import vtkObjectManager from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/ObjectManager";

import { newInstance as newProjectedTextureMapper } from "./projectedTextureMapper";

vtkObjectManager.setTypeMapping(
  "vtkStreamedSceneActor",
  vtkActor.newInstance,
  vtkObjectManager.genericUpdater,
);
vtkObjectManager.setTypeMapping(
  "vtkProjectedTextureMapper",
  newProjectedTextureMapper,
  vtkObjectManager.genericUpdater,
);
vtkObjectManager.setTypeMapping(
  "vtkPointGaussianMapper",
  vtkPointGaussianMapper.newInstance,
  vtkObjectManager.genericUpdater,
);
