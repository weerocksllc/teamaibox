import { readFile } from "node:fs/promises";
import { PreUnlockAuditBuffer, UnixUnlockAdapter, UnlockRateLimiter, UnlockService } from "../src/index.mjs";
import { UnlockHttpApi } from "../src/unlock-http-api.mjs";
import { createNetworkStatusProvider, createUnlockHttpsServer } from "./https-server.mjs";

function required(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }

const address = process.env.TEAMAIBOX_UNLOCK_LISTEN_ADDRESS ?? "0.0.0.0";
const port = Number(process.env.TEAMAIBOX_UNLOCK_LISTEN_PORT ?? 8443);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("unlock listen port is invalid");
const adapter = new UnixUnlockAdapter({ socketPath: process.env.TEAMAIBOX_UNLOCK_HELPER_SOCKET ?? "/run/teamaibox-unlock/helper.sock" });
const auditBuffer = new PreUnlockAuditBuffer({ path: process.env.TEAMAIBOX_UNLOCK_AUDIT_PATH ?? "/var/lib/teamaibox-unlock/audit/pending.jsonl" });
const service = new UnlockService({ adapter, auditBuffer, rateLimiter: new UnlockRateLimiter() });
const api = new UnlockHttpApi({ service, expectedOrigin: required("TEAMAIBOX_UNLOCK_ORIGIN"), networkStatusProvider: createNetworkStatusProvider() });
const server = await createUnlockHttpsServer({ api, tls: { key: await readFile(required("TEAMAIBOX_UNLOCK_TLS_KEY_FILE")), cert: await readFile(required("TEAMAIBOX_UNLOCK_TLS_CERT_FILE")) } });
server.listen(port, address);
