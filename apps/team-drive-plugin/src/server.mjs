import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createStaticApplicationPluginServer } from "../../../packages/application-plugin-runtime/src/static-server.mjs";

export function createTeamDrivePluginServer() {
  return createStaticApplicationPluginServer({
    pluginId: "official.team-drive",
    version: "0.1.0",
    publicRoot: resolve(dirname(fileURLToPath(import.meta.url)), "public"),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createTeamDrivePluginServer().listen(Number.parseInt(process.env.PORT || "8080", 10), "0.0.0.0");
}
