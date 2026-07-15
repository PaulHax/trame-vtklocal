// Registers the vtk.js core vtkPointGaussianMapper with the state-sync object
// manager so serialized scenes can carry the dense-point mapper type. The
// OpenGL override (vtkOpenGLPointGaussianMapper) registers itself through the
// Geometry profile that VtkJsLocal.js / VtkJsShared.js already import, so it is
// intentionally not duplicated here — only the renderable-construction mapping
// belongs on the client. The mapper's props (scaleFactor, scalarVisibility,
// colorMode, ...) live in serialized state, so genericUpdater rebuilds it with
// no reapply hook, exactly like a plain vtkMapper.
import vtkPointGaussianMapper from "@kitware/vtk.js/Rendering/Core/PointGaussianMapper";
import vtkObjectManager from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/ObjectManager";

vtkObjectManager.setTypeMapping(
  "vtkPointGaussianMapper",
  vtkPointGaussianMapper.newInstance,
  vtkObjectManager.genericUpdater,
);

export default { newInstance: vtkPointGaussianMapper.newInstance };
