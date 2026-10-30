import { createServer } from "node:http";

import { errorResponse, PlatformError } from "../../../../../packages/observability/src/index.mjs";

function pathname(request) { try { return new URL(request.url ?? "/", "http://pip-gateway.internal").pathname; } catch { return null; } }
function query(request) { try { return new URL(request.url ?? "/", "http://pip-gateway.internal").searchParams; } catch { return new URLSearchParams(); } }

export function createPipGatewayServer({ api, contextResolver }) {
  if (!api?.matches || !api?.handle || !contextResolver?.resolve) throw new TypeError("PIP gateway server dependencies are incomplete");
  return createServer((request, response) => {
    void (async () => {
      const requestId = String(request.headers["x-request-id"] ?? "pip-gateway").slice(0, 128);
      try {
        const path = pathname(request);
        if (!path) throw new PlatformError("invalid_request", "Request target is invalid", { status: 400 });
        if (request.method === "GET" && path === "/health/live") { response.writeHead(200, { "content-type": "application/json" }); response.end('{"status":"live"}'); return; }
        if (request.method === "GET" && path === "/health/ready") { response.writeHead(200, { "content-type": "application/json" }); response.end('{"status":"ready"}'); return; }
        if (!api.matches(request.method, path)) throw new PlatformError("not_found", "PIP gateway route was not found", { status: 404 });
        const context = await contextResolver.resolve({ request, pathname: path });
        const result = await api.handle({ method: request.method, pathname: path, headers: request.headers, query: query(request), context });
        response.writeHead(result.status, { "cache-control": path.startsWith("/pip/files/") ? "public, immutable" : "no-cache", "x-content-type-options": "nosniff", "x-request-id": requestId, ...result.headers });
        response.end(result.body);
      } catch (error) {
        const failure = errorResponse(error, requestId);
        response.writeHead(failure.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-request-id": requestId });
        response.end(JSON.stringify(failure.body));
      }
    })();
  });
}
