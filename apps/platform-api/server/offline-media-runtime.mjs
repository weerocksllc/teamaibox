import { readFile } from "node:fs/promises";
import path from "node:path";

import { MountedOfflineMediaAdapter } from "../../../services/source-gateway/src/mounted-offline-media-adapter.mjs";
import { OfflineMediaEd25519Verifier } from "../../../services/source-gateway/src/offline-media-ed25519-verifier.mjs";
import { StaticOfflineMediaInventory } from "../../../services/source-gateway/src/static-offline-media-inventory.mjs";

const CONFIG = /^\/run\/teamaibox\/offline-media-config\/[A-Za-z0-9._-]+\.json$/;
const ROOT = "/run/teamaibox/offline-media";

function exact(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new TypeError(`${name} is invalid`);
  return value;
}

export async function createOfflineMediaRuntimeFromEnvironment(environment = process.env) {
  const filename = environment.PLATFORM_OFFLINE_MEDIA_CONFIG_FILE;
  if (!filename) return null;
  if (!CONFIG.test(filename) || !path.isAbsolute(filename)) throw new TypeError("PLATFORM_OFFLINE_MEDIA_CONFIG_FILE is invalid");
  const bytes = await readFile(filename);
  if (bytes.byteLength < 2 || bytes.byteLength > 1024 * 1024) throw new TypeError("Offline media runtime configuration is invalid");
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } finally { bytes.fill(0); }
  exact(value, ["schemaVersion", "root", "trustedKeyringFile", "media"], "Offline media runtime configuration");
  if (value.schemaVersion !== 1 || value.root !== ROOT) throw new TypeError("Offline media runtime configuration is invalid");
  const inventory = new StaticOfflineMediaInventory({ media: value.media });
  const signatureVerifier = new OfflineMediaEd25519Verifier({ trustedKeyringFile: value.trustedKeyringFile });
  const adapter = new MountedOfflineMediaAdapter({ inventory, signatureVerifier, root: value.root });
  return Object.freeze({ offlineMediaDiscovery: adapter, offlineMediaInspector: adapter });
}
