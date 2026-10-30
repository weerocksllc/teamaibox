import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readFile } from "node:fs/promises";

const ALLOWED_PATHS = new Set(["/v1/chat/completions", "/v1/responses"]);
const DEFAULT_TOKEN_FILE = "/run/secrets/teamaibox-model-token";

function safeOrigin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.pathname !== "/"
    || parsed.search || parsed.hash || !/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(parsed.hostname)) {
    throw new TypeError("Agent model proxy upstream must be an internal HTTP origin");
  }
  return parsed.origin;
}

async function tokenFromFile(filename = DEFAULT_TOKEN_FILE) {
  const raw = await readFile(filename);
  try {
    const token = raw.toString("utf8").trim();
    if (token.length < 32 || token.length > 8192 || /[\s\0]/.test(token)) {
      throw new Error("agent_model_credential_unavailable");
    }
    return token;
  } finally {
    raw.fill(0);
  }
}

function json(response, status, code) {
  const body = JSON.stringify({ error: { code, message: "Agent model route is unavailable" } });
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

export function createRotatingModelCredentialProxy({
  upstreamOrigin = "http://compute-gateway:8080",
  credentialProvider = tokenFromFile,
  fetchImplementation = globalThis.fetch,
} = {}) {
  const upstream = safeOrigin(upstreamOrigin);
  if (typeof credentialProvider !== "function" || typeof fetchImplementation !== "function") {
    throw new TypeError("Agent model proxy dependencies are incomplete");
  }
  return http.createServer(async (request, response) => {
    const controller = new AbortController();
    const close = () => controller.abort("downstream_closed");
    request.once("aborted", close);
    response.once("close", close);
    try {
      const url = new URL(request.url ?? "/", "http://agent-model-proxy.invalid");
      if (request.method === "GET" && url.pathname === "/healthz" && !url.search) {
        return json(response, 200, "ready");
      }
      if (request.method !== "POST" || !ALLOWED_PATHS.has(url.pathname) || url.search) {
        return json(response, 404, "agent_model_route_not_found");
      }
      let credential = await credentialProvider();
      if (typeof credential !== "string" || credential.length < 32 || credential.length > 8192 || /[\s\0]/.test(credential)) {
        throw new Error("agent_model_credential_unavailable");
      }
      const result = await fetchImplementation(upstream + url.pathname, {
        method: "POST",
        signal: controller.signal,
        redirect: "manual",
        headers: {
          accept: String(request.headers.accept ?? "application/json").slice(0, 256),
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: Readable.toWeb(request),
        duplex: 'half',
      });
      credential = "[REDACTED]";
      response.writeHead(result.status, {
        "cache-control": "no-store",
        "content-type": result.headers.get("content-type") ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
      });
      if (!result.body) return response.end();
      await pipeline(Readable.fromWeb(result.body), response, {signal:controller.signal});
    } catch {
      if (!response.headersSent) json(response, 503, "agent_model_proxy_unavailable");
      else if (!response.writableEnded) response.destroy();
    } finally {
      request.off("aborted", close);
      response.off("close", close);
    }
  });
}

export const rotatingModelCredentialProxyContract = Object.freeze({
  listenHost: "127.0.0.1",
  listenPort: 4095,
  upstreamOrigin: "http://compute-gateway:8080",
  credentialFile: DEFAULT_TOKEN_FILE,
  allowedPaths: Object.freeze([...ALLOWED_PATHS]),
  maxRequestBytes: null,
  requestTransfer: 'streaming',
});
