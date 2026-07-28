import { glMatrixDir, vtkJsDir } from "./scripts/glMatrixDir.mjs";

export default {
  base: "./",
  // Resolve the bare "gl-matrix" specifier (used by src/glMatrix.js and vtk.js
  // itself) to the single copy vtk.js depends on. Dedupe @kitware/vtk.js so
  // linked packages (pointcloud-lod) resolve the same build this package
  // uses — the fork symlinked at node_modules/@kitware/vtk.js — instead of a
  // copy in their own tree.
  resolve: {
    alias: {
      "gl-matrix": glMatrixDir,
      "@kitware/vtk.js": vtkJsDir,
    },
    dedupe: ["@kitware/vtk.js"],
  },
  ssr: {
    noExternal: ["pointcloud-lod"],
  },
  build: {
    lib: {
      entry: "./src/main.js",
      name: "trame_vtklocal",
      formats: ["umd"],
      fileName: "trame_vtklocal",
    },
    rollupOptions: {
      external: ["vue"],
      output: {
        globals: {
          vue: "Vue",
        },
      },
    },
    outDir: "../src/trame_vtklocal/module/serve/js",
    assetsDir: ".",
  },
};
