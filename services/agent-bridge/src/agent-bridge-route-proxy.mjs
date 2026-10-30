import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const ALLOWED_PATH = /^\/(?:healthz|v1(?:\/[^/?#]*)*)$/;

function origin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.pathname !== "/"
    || parsed.search || parsed.hash || !/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(parsed.hostname)) {
    throw new TypeError("Agent Bridge proxy upstream must be an internal HTTP origin");
  }
  return parsed.origin;
}

function fail(response, status, code) {
  const body = JSON.stringify({ error: { code, message: "Agent Bridge route is unavailable", retryable: status >= 500 } });
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

export function createAgentBridgeRouteProxy({ upstreamOrigin, fetchImplementation = globalThis.fetch }) {
  const upstream = origin(upstreamOrigin);
  if (typeof fetchImplementation !== "function") throw new TypeError("Agent Bridge proxy fetch implementation is required");
  return http.createServer(async (request, response) => {
    const controller = new AbortController();
    const close = () => controller.abort("downstream_closed");
    request.once("aborted", close);
    response.once("close", close);
    try {
      const url = new URL(request.url ?? "/", "http://agent-bridge-proxy.invalid");
      if (!new Set(["GET", "POST"]).has(request.method) || !ALLOWED_PATH.test(url.pathname)
        || (url.pathname === "/healthz" && request.method !== "GET")) return fail(response, 404, "agent_bridge_route_not_found");
      // The proxy does not interpret the request. Stream with backpressure;
      // the authenticated destination owns validation and memory admission.
      const body = request.method === 'POST' ? Readable.toWeb(request) : null;
      const target = new URL(url.pathname + url.search, upstream);
      const result = await fetchImplementation(target, {
        method: request.method,
        signal: controller.signal,
        redirect: "manual",
        headers: {
          accept: String(request.headers.accept ?? "application/json").slice(0, 256),
          ...(request.headers.authorization ? { authorization: String(request.headers.authorization).slice(0, 8192) } : {}),
          ...(body ? { "content-type": String(request.headers["content-type"] ?? "application/json").slice(0, 256) } : {}),
        },
        ...(body ? { body, duplex: 'half' } : {}),
      });
      response.writeHead(result.status, {
        "cache-control": "no-store",
        "content-type": result.headers.get("content-type") ?? "application/octet-stream",
        ...(!result.headers.get('content-encoding') && result.headers.get("content-length") ? { "content-length": result.headers.get("content-length") } : {}),
        ...(result.headers.get("x-teamaibox-artifact-name") ? { "x-teamaibox-artifact-name": result.headers.get("x-teamaibox-artifact-name") } : {}),
        ...(result.headers.get("x-teamaibox-content-sha256") ? { "x-teamaibox-content-sha256": result.headers.get("x-teamaibox-content-sha256") } : {}),
        "x-content-type-options": "nosniff",
      });
      if (!result.body) return response.end();
      await pipeline(Readable.fromWeb(result.body), response, {signal:controller.signal});
    } catch {
      if (!response.headersSent) fail(response, 503, "agent_bridge_proxy_unavailable");
      else if (!response.writableEnded) response.destroy();
    } finally {
      request.off("aborted", close);
      response.off("close", close);
    }
  });
}
