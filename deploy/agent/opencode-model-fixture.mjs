import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import http from "node:http";

const TOKEN_PATH = "/run/secrets/teamaibox-model-token";
const UPSTREAM = "http://teamaibox-model-qwen36-nvfp4:8000";
const ALIAS = "agent.default";
const SERVED_MODEL = "qwen3.6-35b-a3b-nvfp4";
const MAX_BODY = 4 * 1024 * 1024;
const state = { requestCount: 0, streamRequestCount: 0, toolRequestCount: 0, modelMappedCount: 0 };

async function token() {
  const raw = await readFile(TOKEN_PATH);
  try { return raw.toString("utf8").trim(); } finally { raw.fill(0); }
}

async function authorized(request) {
  const supplied = /^Bearer ([A-Za-z0-9._~-]{32,4096})$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
  const expected = await token();
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  try { return left.length === right.length && timingSafeEqual(left, right); }
  finally { left.fill(0); right.fill(0); }
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  response.end(body);
}

async function body(request) {
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of request) {
      length += chunk.byteLength;
      if (length > MAX_BODY) throw new Error("too_large");
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const path = new URL(request.url ?? "/", "http://compute-gateway.invalid").pathname;
    if (request.method === "GET" && path === "/healthz") return json(response, 200, { status: "ok" });
    if (!await authorized(request)) return json(response, 401, { error: { message: "invalid credential", type: "authentication_error" } });
    if (request.method === "GET" && path === "/facts") return json(response, 200, { ...state });
    if (request.method !== "POST" || !new Set(["/v1/chat/completions", "/v1/responses"]).has(path)) {
      return json(response, 404, { error: { message: "route unavailable", type: "invalid_request_error" } });
    }
    const value = await body(request);
    if (value.model !== ALIAS) return json(response, 403, { error: { message: "model alias denied", type: "permission_error" } });
    state.requestCount += 1;
    if (value.stream === true) state.streamRequestCount += 1;
    if (Array.isArray(value.tools) && value.tools.length > 0) state.toolRequestCount += 1;
    state.modelMappedCount += 1;
    value.model = SERVED_MODEL;
    const upstream = await fetch(UPSTREAM + path, {
      method: "POST",
      headers: { accept: request.headers.accept ?? "application/json", "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
      ...(upstream.headers.get("x-request-id") ? { "x-request-id": upstream.headers.get("x-request-id") } : {}),
    });
    if (!upstream.body) return response.end();
    for await (const chunk of upstream.body) {
      if (!response.write(chunk)) await once(response, "drain");
    }
    response.end();
  } catch {
    if (!response.headersSent) json(response, 502, { error: { message: "model fixture unavailable", type: "server_error" } });
    else response.destroy();
  }
});
server.listen(8080, "0.0.0.0");
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  server.close(() => process.exit());
  server.closeAllConnections?.();
}
process.once("SIGTERM", close);
process.once("SIGINT", close);
