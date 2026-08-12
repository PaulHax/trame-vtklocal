import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { glMatrixDir, vtkJsDir } from "./scripts/glMatrixDir.mjs";

const tiles3dWorkerSource = fileURLToPath(
  new URL(
    "./node_modules/pointcloud-lod/dist/tiles3dDecodeWorker.classic.js",
    import.meta.url,
  ),
);

const tiles3dCodecSources = new Map(
  [
    "draco_wasm_wrapper.js",
    "draco_decoder.wasm",
    "basis_encoder.js",
    "basis_encoder.wasm",
  ].map((name) => [
    name,
    fileURLToPath(
      new URL(
        `./node_modules/pointcloud-lod/dist/tiles3d-codecs/${name}`,
        import.meta.url,
      ),
    ),
  ]),
);

const stageTiles3dRuntime = {
  name: "stage-tiles3d-runtime",
  writeBundle(outputOptions) {
    copyFileSync(
      tiles3dWorkerSource,
      resolve(outputOptions.dir, "tiles3dDecodeWorker.classic.js"),
    );
    const codecDirectory = resolve(outputOptions.dir, "../wasm/tiles3d");
    mkdirSync(codecDirectory, { recursive: true });
    for (const [name, source] of tiles3dCodecSources) {
      copyFileSync(source, resolve(codecDirectory, name));
    }
  },
};

export default {
  base: "./",
  plugins: [stageTiles3dRuntime],
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
