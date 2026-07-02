import { glMatrixDir } from "./scripts/glMatrixDir.mjs";

export default {
  base: "./",
  // Resolve the bare "gl-matrix" specifier (used by src/glMatrix.js and vtk.js
  // itself) to the single copy vtk.js depends on.
  resolve: {
    alias: {
      "gl-matrix": glMatrixDir,
    },
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
