// Resolve the gl-matrix package directory that vtk.js already depends on, so
// both the library build and the test module loader can alias the bare
// "gl-matrix" specifier to it. This reuses vtk.js's bundled copy instead of
// adding gl-matrix as a separate dependency of this package.
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const vtkPackageJson = require.resolve("@kitware/vtk.js/package.json");
// The vtk.js build this package resolves (a fork symlinked into
// node_modules); aliased explicitly so linked packages that declare vtk.js as
// an optional peer (pointcloud-lod) resolve this copy instead of vite's
// missing-optional-peer stub.
export const vtkJsDir = dirname(vtkPackageJson);
export const glMatrixDir = dirname(
  require.resolve("gl-matrix/package.json", { paths: [vtkJsDir] }),
);
