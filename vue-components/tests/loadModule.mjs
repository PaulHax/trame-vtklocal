import { createServer } from "vite";

let viteServer = null;

export async function loadModule(modulePath) {
  if (!viteServer) {
    viteServer = await createServer({
      configFile: false,
      root: process.cwd(),
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
