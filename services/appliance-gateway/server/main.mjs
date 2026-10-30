import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { signManagedNodeGatewayIdentity } from "../../../packages/authorization/src/managed-node-gateway-identity.mjs";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const MANAGED_ROUTE = /^\/api\/v1\/appliance\/(heartbeat|metrics)$/;
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const IDENTITY_HEADERS = new Set([
  "x-teamaibox-node-timestamp", "x-teamaibox-node-nonce", "x-teamaibox-node-id",
  "x-teamaibox-node-certificate-fingerprint", "x-teamaibox-node-signature",
]);

function path(value, name) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
  return value;
}

function integer(value, fallback, minimum, maximum, name) {
  const selected = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) throw new TypeError(`${name} is invalid`);
  return selected;
}

async function signingKey(filename) {
  const raw = await readFile(path(filename, "APPLIANCE_GATEWAY_SIGNING_KEY_FILE"));
  try {
    const encoded = raw.toString("utf8").trim(), value = Buffer.from(encoded, "base64url");
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || value.byteLength < 32 || value.byteLength > 128 || value.toString("base64url") !== encoded) {
      value.fill(0); throw new TypeError("appliance gateway signing key is invalid");
    }
    return value;
  } finally { raw.fill(0); }
}

function platformOrigin(value) {
  let result;
  try { result = new URL(value); } catch { throw new TypeError("APPLIANCE_PLATFORM_ORIGIN is invalid"); }
  if (result.protocol !== "http:" || result.username || result.password || result.pathname !== "/" || result.search || result.hash) {
    throw new TypeError("APPLIANCE_PLATFORM_ORIGIN must be an internal HTTP origin");
  }
  return result;
}

export async function gatewayConfiguration(environment = process.env) {
  const [certificate, privateKey, clientCa, key] = await Promise.all([
    readFile(path(environment.APPLIANCE_GATEWAY_TLS_CERT_FILE, "APPLIANCE_GATEWAY_TLS_CERT_FILE")),
    readFile(path(environment.APPLIANCE_GATEWAY_TLS_KEY_FILE, "APPLIANCE_GATEWAY_TLS_KEY_FILE")),
    readFile(path(environment.APPLIANCE_GATEWAY_CLIENT_CA_FILE, "APPLIANCE_GATEWAY_CLIENT_CA_FILE")),
    signingKey(environment.APPLIANCE_GATEWAY_SIGNING_KEY_FILE),
  ]);
  return Object.freeze({
    host: "127.0.0.1",
    localNodeId: environment.PLATFORM_APPLIANCE_NODE_ID,
    port: integer(environment.APPLIANCE_GATEWAY_PORT, 9444, 1, 65535, "APPLIANCE_GATEWAY_PORT"),
    platformOrigin: platformOrigin(environment.APPLIANCE_PLATFORM_ORIGIN),
    requestTimeoutMs: integer(environment.APPLIANCE_GATEWAY_REQUEST_TIMEOUT_MS, 20_000, 1_000, 60_000, "APPLIANCE_GATEWAY_REQUEST_TIMEOUT_MS"),
    certificate, privateKey, clientCa, signingKey: key,
  });
}

export function verifiedNodeIdentity(socket) {
  if (socket?.encrypted !== true || socket.authorized !== true || typeof socket.getPeerCertificate !== "function") return null;
  const certificate = socket.getPeerCertificate(false);
  const match = /(?:^|,\s*)URI:spiffe:\/\/teamaibox\.local\/node\/([0-9a-f-]{36})(?:,|$)/i.exec(String(certificate?.subjectaltname ?? ""));
  const fingerprint = String(certificate?.fingerprint256 ?? "").replaceAll(":", "").toLowerCase();
  if (!match || !/^[0-9a-f]{64}$/.test(fingerprint)) return null;
  return Object.freeze({ subjectNodeId: match[1].toLowerCase(), certificateFingerprint: `sha256:${fingerprint}` });
}

function json(response, status, body) {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

function forwardedHeaders(request, origin) {
  const result = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const normalized = name.toLowerCase();
    if (HOP_HEADERS.has(normalized) || IDENTITY_HEADERS.has(normalized) || normalized.startsWith("x-forwarded-")) continue;
    result[normalized] = value;
  }
  result.host = origin.host;
  result["x-forwarded-proto"] = "https";
  return result;
}

function proxy(request, response, config, identity = null) {
  const target = new URL(request.url, config.platformOrigin), headers = forwardedHeaders(request, config.platformOrigin);
  if (identity) {
    const timestamp = new Date().toISOString(), nonce = randomBytes(24).toString("base64url");
    Object.assign(headers, {
      "x-teamaibox-node-timestamp": timestamp,
      "x-teamaibox-node-nonce": nonce,
      "x-teamaibox-node-id": identity.subjectNodeId,
      "x-teamaibox-node-certificate-fingerprint": identity.certificateFingerprint,
      "x-teamaibox-node-signature": signManagedNodeGatewayIdentity({ key: config.signingKey, method: request.method, pathname: target.pathname, timestamp, nonce, ...identity }),
    });
  }
  const upstream = httpRequest({ hostname: target.hostname, port: target.port || 80, method: request.method, path: target.pathname + target.search, headers }, (incoming) => {
    const responseHeaders = {};
    for (const [name, value] of Object.entries(incoming.headers)) if (!HOP_HEADERS.has(name.toLowerCase())) responseHeaders[name] = value;
    response.writeHead(incoming.statusCode ?? 502, responseHeaders);
    incoming.pipe(response);
  });
  upstream.setTimeout(config.requestTimeoutMs, () => upstream.destroy(new Error("platform request timed out")));
  upstream.on("error", () => { if (!response.headersSent) json(response, 502, { error: { code: "platform_unavailable", message: "Platform API is unavailable" } }); else response.destroy(); });
  request.pipe(upstream);
}

export function createApplianceGateway(config) {
  if (!new RegExp("^" + UUID + "$", "i").test(config.localNodeId ?? "")) throw new TypeError("Local appliance identity is required");
  const server = createServer({
    cert: config.certificate,
    key: config.privateKey,
    ca: config.clientCa,
    minVersion: "TLSv1.3",
    requestCert: true,
    rejectUnauthorized: false,
  }, (request, response) => {
    let pathname;
    try { pathname = new URL(request.url || "/", "https://gateway.invalid").pathname; } catch { json(response, 400, { error: { code: "invalid_request" } }); return; }
    if (request.method === "GET" && pathname === "/health/ready") { json(response, 200, { status: "ready" }); return; }
    if (request.method !== "POST") { json(response, 405, { error: { code: "method_not_allowed" } }); return; }
    const managed = MANAGED_ROUTE.exec(pathname);
    if (!managed) { json(response, 404, { error: { code: "not_found" } }); return; }
    const identity = verifiedNodeIdentity(request.socket);
    if (!identity || identity.subjectNodeId !== config.localNodeId) {
      json(response, 401, { error: { code: "managed_node_mtls_required", message: "Verified mutual TLS node identity is required" } }); return;
    }
    proxy(request, response, config, identity);
  });
  server.once("close", () => { config.signingKey.fill(0); config.privateKey.fill(0); });
  return server;
}

export async function startApplianceGateway(environment = process.env) {
  const config = await gatewayConfiguration(environment), server = createApplianceGateway(config);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.host, resolve); });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startApplianceGateway().catch((error) => { console.error(JSON.stringify({ level: "error", event: "appliance_gateway.start_failed", message: error.message })); process.exitCode = 1; });
}
