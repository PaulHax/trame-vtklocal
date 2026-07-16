import { createServer } from "vite";

import { glMatrixDir, vtkJsDir } from "../scripts/glMatrixDir.mjs";

let viteServer = null;

export async function loadModule(modulePath) {
  if (!viteServer) {
    viteServer = await createServer({
      configFile: false,
      root: process.cwd(),
      // Match vite.config.js so a bare "gl-matrix" import resolves to vtk.js's
      // copy under ssrLoadModule too, and linked packages with vtk.js as an
      // optional peer (vtk-pointcloud-lod) resolve this package's vtk.js.
      resolve: {
        alias: {
          "gl-matrix": glMatrixDir,
          "@kitware/vtk.js": vtkJsDir,
        },
        dedupe: ["@kitware/vtk.js"],
      },
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: "custom",
    });
  }

  return viteServer.ssrLoadModule(modulePath);
}

export async function closeModuleLoader() {
  if (viteServer) {
    await viteServer.close();
    viteServer = null;
  }
}
