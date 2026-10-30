import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createStaticApplicationPluginServer } from "../../../packages/application-plugin-runtime/src/static-server.mjs";

export function createDrawingPluginServer() {
  return createStaticApplicationPluginServer({
    pluginId: "official.drawing",
    version: "0.1.0",
    publicRoot: resolve(dirname(fileURLToPath(import.meta.url)), "public"),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createDrawingPluginServer().listen(port, "0.0.0.0");
}
