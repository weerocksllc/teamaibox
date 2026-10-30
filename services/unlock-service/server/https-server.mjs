import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = Object.freeze({
  "/": { path: resolve(ROOT, "public/index.html"), type: "text/html; charset=utf-8" },
  "/app.js": { path: resolve(ROOT, "public/app.js"), type: "text/javascript; charset=utf-8" },
  "/app.css": { path: resolve(ROOT, "public/app.css"), type: "text/css; charset=utf-8" },
});

export function createNetworkStatusProvider() {
  return Object.freeze({ async status() {
    const interfaces = [];
    for (const [name, addresses] of Object.entries(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.internal || !new Set(["IPv4", "IPv6", 4, 6]).has(address.family)) continue;
        interfaces.push({ name: String(name).slice(0, 64), family: address.family === 4 ? "IPv4" : address.family === 6 ? "IPv6" : address.family, address: address.address, scope: address.address.startsWith("169.254.") || address.address.startsWith("fe80:") ? "link" : "lan" });
      }
    }
    return Object.freeze({ status: interfaces.length ? "available" : "unavailable", interfaces: Object.freeze(interfaces.slice(0, 32)) });
  } });
}

async function body(request, maximum = 8192) {
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw Object.assign(new Error("JSON required"), { status: 415 });
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > maximum) throw Object.assign(new Error("body too large"), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("invalid JSON"), { status: 400 }); }
}

export async function createUnlockHttpsServer({ api, tls, publicAssets = ASSETS }) {
  if (!api?.handle || !tls?.key || !tls?.cert) throw new TypeError("unlock HTTPS server dependencies are incomplete");
  const loaded = new Map();
  for (const [pathname, asset] of Object.entries(publicAssets)) loaded.set(pathname, { ...asset, bytes: await readFile(asset.path) });
  return createServer({ key: tls.key, cert: tls.cert, minVersion: "TLSv1.3" }, (request, response) => { void (async () => {
    const url = new URL(request.url ?? "/", "https://unlock.invalid");
    const asset = loaded.get(url.pathname);
    if (request.method === "GET" && asset) {
      response.writeHead(200, { "content-type": asset.type, "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", "strict-transport-security": "max-age=31536000", "x-content-type-options": "nosniff", "x-frame-options": "DENY" });
      response.end(asset.bytes); return;
    }
    let parsed = null;
    if (request.method === "POST" && url.pathname === "/v1/unlock") parsed = await body(request);
    const result = await api.handle({ method: request.method, pathname: url.pathname, headers: request.headers, body: parsed, networkIdentifier: request.socket.remoteAddress ?? "unknown", secure: request.socket.encrypted === true });
    response.writeHead(result.status, result.headers); response.end(result.body);
  })().catch((error) => {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const requestId = createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 16);
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.end(JSON.stringify({ error: { code: status === 413 ? "unlock_body_too_large" : status === 415 ? "unlock_content_type_invalid" : status === 400 ? "unlock_json_invalid" : "unlock_internal_error", message: "Unlock request could not be processed", requestId } }));
  }); });
}
