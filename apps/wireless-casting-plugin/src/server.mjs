import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createStaticApplicationPluginServer } from "../../../packages/application-plugin-runtime/src/static-server.mjs";

export function createWirelessCastingPluginServer() {
  return createStaticApplicationPluginServer({
    pluginId: "official.wireless-casting",
    version: "0.1.9",
    publicRoot: resolve(dirname(fileURLToPath(import.meta.url)), "public"),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createWirelessCastingPluginServer().listen(port, "0.0.0.0");
}
