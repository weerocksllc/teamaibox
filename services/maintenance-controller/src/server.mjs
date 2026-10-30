import https from "node:https";
import { readFile } from "node:fs/promises";

import { ReleaseSlotService } from "./release-slot-service.mjs";
import { protectedOfficeMaintenanceSignerFromEnvironment } from "./protected-office-maintenance-signer.mjs";

async function bytes(path, name) { if (typeof path !== "string" || !path.startsWith("/")) throw new TypeError(`${name} is invalid`); const value = await readFile(path); if (value.byteLength < 1 || value.byteLength > 1 << 20) throw new TypeError(`${name} is invalid`); return value; }
async function jsonFile(path, name) { const raw = await bytes(path, name); try { return JSON.parse(raw.toString("utf8")); } finally { raw.fill(0); } }
function respond(response, status, body) { const payload = Buffer.from(JSON.stringify(body)); response.writeHead(status, { "content-type": "application/json", "content-length": payload.byteLength, "cache-control": "no-store" }); response.end(payload); }
async function body(request) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.byteLength; if (size > 32 << 10) throw Object.assign(new Error("request too large"), { code: "update_request_invalid" }); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }

export async function start(environment = process.env) {
  const config = await jsonFile(environment.MAINTENANCE_CONTROLLER_CONFIG_FILE, "MAINTENANCE_CONTROLLER_CONFIG_FILE");
  const identity = await jsonFile(environment.MAINTENANCE_CONTROLLER_NODE_IDENTITY_FILE, "MAINTENANCE_CONTROLLER_NODE_IDENTITY_FILE");
  if (config?.schemaVersion !== 1 || !Array.isArray(config.candidates) || !config.baseline) throw new TypeError("maintenance controller configuration is invalid");
  const service = new ReleaseSlotService({ nodeId: identity.nodeId, root: environment.MAINTENANCE_CONTROLLER_STATE_ROOT, candidates: config.candidates, baseline: config.baseline });
  await service.initialize();
  const protectedOfficeSigner = protectedOfficeMaintenanceSignerFromEnvironment(environment);
  const [ca, cert, key] = await Promise.all([bytes(environment.MAINTENANCE_CONTROLLER_CA_FILE, "maintenance controller CA"), bytes(environment.MAINTENANCE_CONTROLLER_TLS_CERT_FILE, "maintenance controller certificate"), bytes(environment.MAINTENANCE_CONTROLLER_TLS_KEY_FILE, "maintenance controller private key")]);
  const server = https.createServer({ ca, cert, key, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }, async (request, response) => {
    try {
      if (!request.socket.authorized) { respond(response, 401, { error: { code: "update_mtls_required" } }); return; }
      if (request.method === "GET" && request.url === "/health/ready") { respond(response, 200, { status: "ready" }); return; }
      if (request.method === "POST" && request.url === "/v1/protected-office/sign") {
        if (!protectedOfficeSigner) { respond(response, 503, { error: { code: "protected_maintenance_signer_unavailable" } }); return; }
        const context = await protectedOfficeSigner.sign(await body(request));
        respond(response, 200, { schemaVersion: 1, status: "passed", context }); return;
      }
      const match = /^\/v1\/platform\/(stage|apply|postcheck|rollback)$/.exec(request.url ?? "");
      if (request.method !== "POST" || !match) { respond(response, 404, { error: { code: "not_found" } }); return; }
      const value = await service[match[1]](await body(request)); respond(response, 200, value);
    } catch (error) {
      const invalid = error instanceof TypeError || new Set(["update_request_invalid"]).has(error?.code);
      respond(response, invalid ? 400 : 409, { error: { code: typeof error?.code === "string"
        ? error.code : invalid ? "protected_maintenance_request_invalid" : "update_controller_failed" } });
    }
  });
  const port = Number(environment.MAINTENANCE_CONTROLLER_PORT || "9446");
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const close = () => server.close(); process.once("SIGTERM", close); process.once("SIGINT", close); return server;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) start().catch((error) => { process.stderr.write(`maintenance controller failed: ${error.message}\n`); process.exitCode = 1; });
