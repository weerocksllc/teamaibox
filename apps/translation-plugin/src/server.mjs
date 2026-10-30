import { fileURLToPath } from "node:url";

import { createStaticApplicationPluginServer } from "../../../packages/application-plugin-runtime/src/static-server.mjs";

export function createTranslationPluginServer() {
  return createStaticApplicationPluginServer({
    pluginId: "official.translation",
    version: "0.1.0",
    pathPrefix: "/plugins/official.translation",
    publicRoot: fileURLToPath(new URL("./public", import.meta.url)),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  createTranslationPluginServer().listen(port, "0.0.0.0");
}
