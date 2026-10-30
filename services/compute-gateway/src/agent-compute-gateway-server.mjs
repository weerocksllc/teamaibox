import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { bufferedMediaResponse, reserveBufferedMedia } from "../../object-service/src/buffered-media-budget.mjs";

const ROUTES = new Set(["/v1/chat/completions", "/v1/responses"]);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;

function openAiError(response, status, code, message) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = JSON.stringify({ error: { code, message, type: "invalid_request_error", param: null } });
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function bearer(request) {
  const values = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === "authorization") values.push(request.rawHeaders[index + 1]);
  }
  const match = values.length === 1 ? /^Bearer ([^\s,]{16,4096})$/.exec(values[0]) : null;
  if (!match) throw Object.assign(new Error("invalid credential"), { status: 401, code: "invalid_credential" });
  return match[1];
}

function idempotencyKey(request, credential, pathname, projected) {
  const values = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === "idempotency-key") values.push(request.rawHeaders[index + 1]);
  }
  if (values.length > 1 || (values.length === 1 && !IDEMPOTENCY_KEY.test(values[0]))) {
    throw Object.assign(new Error("invalid idempotency key"), { status: 400, code: "invalid_idempotency_key" });
  }
  if (values.length === 1) return values[0];
  const digest = createHash("sha256").update(pathname).update("\0").update(JSON.stringify(projected)).digest("hex");
  return `agent.${credential.tokenId}.${digest}`;
}

async function jsonRequest(request, memoryBudget) {
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw Object.assign(new Error("JSON request required"), { status: 415, code: "unsupported_media_type" });
  }
  // This is an incoming request, not a fetch response: destroying its stream
  // would also destroy the socket before we can return a useful HTTP error.
  const body = { [Symbol.asyncIterator]: () => request.iterator({destroyOnReturn:false}) };
  const raw = await bufferedMediaResponse({ headers: new Headers(request.headers), body }, memoryBudget);
  try {
    const value = JSON.parse(raw.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value;
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400, code: "invalid_json" });
  } finally {
    raw.fill(0);
  }
}

function safeOrigin(value) {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.search || url.hash
      || url.pathname !== "/") throw new TypeError("Platform compute origin is invalid");
  return url.origin;
}

function safeAliasMap(value) {
  if (!(value instanceof Map) || value.size < 1) throw new TypeError("Agent model alias map is invalid");
  const result = new Map();
  for (const [source, target] of value) {
    if (typeof source !== "string" || typeof target !== "string" || !source || !target
        || /[\s\0]/.test(source) || /[\s\0]/.test(target)) throw new TypeError("Agent model alias map is invalid");
    result.set(source, target);
  }
  return result;
}

function projectBody(body, alias, target, credential) {
  const extensions = body.x_teamaibox?.extensions;
  if (extensions !== undefined && (!extensions || typeof extensions !== "object" || Array.isArray(extensions))) {
    throw Object.assign(new Error("invalid extensions"), { status: 400, code: "invalid_request" });
  }
  return {
    ...body,
    model: target,
    x_teamaibox: {
      ...(body.x_teamaibox ?? {}),
      extensions: {
        ...(extensions ?? {}),
        agent: {
          requested_alias: alias,
          sandbox_id: credential.sandboxId,
          token_id: credential.tokenId,
        },
      },
    },
  };
}

function projectModel(value, target, alias) {
  return value && typeof value === "object" && !Array.isArray(value) && value.model === target
    ? { ...value, model: alias }
    : value;
}

async function writeChunk(response, chunk, signal) {
  if (!response.write(chunk)) await once(response, "drain", { signal });
}

async function relayEventStream(upstream, response, { target, alias, signal, memoryBudget }) {
  response.writeHead(200, {
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let release = () => {};
  try {
    while (!signal.aborted) {
      const item = await reader.read();
      // Account only for the unfinished event and next chunk, never the total
      // lifetime bytes of a streaming conversation. Backpressure bounds output.
      release(); release = () => {};
      const pending = Buffer.byteLength(buffer) + (item.value?.byteLength ?? 0);
      if (pending) release = reserveBufferedMedia(pending, memoryBudget);
      buffer = (buffer + decoder.decode(item.value ?? new Uint8Array(), { stream: !item.done })).replaceAll("\r\n", "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const output = block.split("\n").map((line) => {
          if (!line.startsWith("data:")) return line;
          const raw = line.slice(5).trimStart();
          if (!raw || raw === "[DONE]") return line;
          try { return `data: ${JSON.stringify(projectModel(JSON.parse(raw), target, alias))}`; }
          catch { throw new Error("invalid upstream event stream"); }
        }).join("\n");
        await writeChunk(response, `${output}\n\n`, signal);
      }
      release(); release = () => {};
      if (buffer.length) release = reserveBufferedMedia(Buffer.byteLength(buffer), memoryBudget);
      if (item.done) break;
    }
    if (buffer.trim()) throw new Error("incomplete upstream event stream");
    if (!signal.aborted) response.end();
  } finally {
    release();
    await reader.cancel().catch(() => {});
  }
}

async function relayJson(upstream, response, { target, alias, memoryBudget }) {
  const raw = await bufferedMediaResponse(upstream, memoryBudget);
  try {
    const value = JSON.parse(raw.toString("utf8"));
    const body = JSON.stringify(projectModel(value, target, alias));
    response.writeHead(upstream.status, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  } finally {
    raw.fill(0);
  }
}

export function createAgentComputeGatewayServer({ credentialAuthority, modelAliasMap, platformOrigin, fetchImplementation = globalThis.fetch, memoryBudget = {} }) {
  if (!credentialAuthority?.verify || typeof fetchImplementation !== "function") {
    throw new TypeError("Agent compute gateway dependencies are incomplete");
  }
  const aliases = safeAliasMap(modelAliasMap);
  const origin = safeOrigin(platformOrigin);
  return createServer((request, response) => {
    const abort = new AbortController();
    response.once("close", () => abort.abort());
    void (async () => {
      try {
        const pathname = new URL(request.url ?? "/", "http://compute-gateway.invalid").pathname;
        if (request.method === "GET" && pathname === "/health/live") {
          response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json" });
          response.end('{"status":"live"}');
          return;
        }
        if (request.method !== "POST" || !ROUTES.has(pathname)) {
          openAiError(response, 404, "not_found", "Endpoint was not found");
          return;
        }
        const token = bearer(request);
        const credential = credentialAuthority.verify({ token, method: request.method, pathname });
        const body = await jsonRequest(request, memoryBudget);
        if (typeof body.model !== "string" || !credential.modelAliases.includes(body.model)) {
          throw Object.assign(new Error("model denied"), { status: 403, code: "model_not_allowed" });
        }
        const alias = body.model;
        const target = aliases.get(alias);
        if (!target) throw Object.assign(new Error("model unavailable"), { status: 503, code: "model_unavailable" });
        const projected = projectBody(body, alias, target, credential);
        const idempotency = idempotencyKey(request, credential, pathname, projected);
        const upstream = await fetchImplementation(`${origin}${pathname}`, {
          method: "POST",
          signal: abort.signal,
          headers: {
            accept: body.stream === true ? "text/event-stream" : "application/json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "idempotency-key": idempotency,
            "x-forwarded-proto": "https",
          },
          body: JSON.stringify(projected),
        });
        if (!upstream.ok) {
          await upstream.body?.cancel().catch(() => {});
          openAiError(response, upstream.status >= 500 ? 503 : upstream.status,
            upstream.status >= 500 ? "compute_unavailable" : "compute_rejected",
            upstream.status >= 500 ? "Queued compute is temporarily unavailable" : "Queued compute rejected the request");
          return;
        }
        const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
        if (body.stream === true) {
          if (!upstream.body || !contentType.startsWith("text/event-stream")) throw new Error("invalid upstream stream");
          await relayEventStream(upstream, response, { target, alias, signal: abort.signal, memoryBudget });
        } else {
          if (!contentType.startsWith("application/json")) throw new Error("invalid upstream response");
          await relayJson(upstream, response, { target, alias, memoryBudget });
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        // A rejected unread upload must not become an unbounded drain or a
        // reusable keep-alive request. Send the error, then close normally.
        if (!request.complete && !response.headersSent) response.setHeader('connection', 'close');
        openAiError(response, Number.isInteger(error?.status) ? error.status : 502,
          typeof error?.code === "string" ? error.code : "compute_gateway_error",
          Number.isInteger(error?.status) && error.status < 500 ? "Agent compute request was rejected" : "Agent compute gateway could not complete the request");
      }
    })();
  });
}
