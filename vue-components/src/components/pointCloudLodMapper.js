// Registers the "vtkPointCloudLodMapper" state-sync type: the anchor node a
// server-side mapper marked with mark_point_cloud_lod() translates to. The
// client instance is a plain vtkPointGaussianMapper carrying the anchor's
// empty dataset (it draws nothing itself) — the streamed tiles are separate
// actors managed by pointCloudLod.js, driven by the node's `pointCloudLod`
// feature block. genericUpdater applies the ordinary mapper props; the block
// handler owns everything LOD.
import vtkPointGaussianMapper from "@kitware/vtk.js/Rendering/Core/PointGaussianMapper";
import vtkObjectManager from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/ObjectManager";

vtkObjectManager.setTypeMapping(
  "vtkPointCloudLodMapper",
  vtkPointGaussianMapper.newInstance,
  vtkObjectManager.genericUpdater,
);

export default { newInstance: vtkPointGaussianMapper.newInstance };
