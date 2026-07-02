import { createServer } from "vite";

import { glMatrixDir } from "../scripts/glMatrixDir.mjs";

let viteServer = null;

export async function loadModule(modulePath) {
  if (!viteServer) {
    viteServer = await createServer({
      configFile: false,
      root: process.cwd(),
      // Match vite.config.js so a bare "gl-matrix" import resolves to vtk.js's
      // copy under ssrLoadModule too.
      resolve: {
        alias: {
          "gl-matrix": glMatrixDir,
        },
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
