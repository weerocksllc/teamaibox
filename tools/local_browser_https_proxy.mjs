#!/usr/bin/env node
/** Local-only browser acceptance proxy for a self-signed Spark HTTPS deployment. */

import http from "node:http";
import https from "node:https";

const upstream = new URL(process.env.TEAMAIBOX_BROWSER_TEST_UPSTREAM ?? "");
const port = Number.parseInt(process.env.TEAMAIBOX_BROWSER_TEST_PORT ?? "18572", 10);
if (upstream.protocol !== "https:" || !Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error("A bounded HTTPS upstream and local high port are required");
}
const localOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
const hopByHop = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function rewrittenRequestHeaders(request) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) if (!hopByHop.has(name) && name !== "host" && value !== undefined) headers[name] = value;
  headers.host = upstream.host;
  if (typeof headers.origin === "string" && localOrigins.has(headers.origin)) headers.origin = upstream.origin;
  if (typeof headers.referer === "string") for (const origin of localOrigins) if (headers.referer.startsWith(origin)) headers.referer = upstream.origin + headers.referer.slice(origin.length);
  return headers;
}

function rewrittenResponseHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) if (!hopByHop.has(name) && value !== undefined) result[name] = value;
  if (typeof result.location === "string" && result.location.startsWith(upstream.origin)) result.location = `http://localhost:${port}${result.location.slice(upstream.origin.length)}`;
  return result;
}

const server = http.createServer((request, response) => {
  const host = request.headers.host;
  if (!new Set([`localhost:${port}`, `127.0.0.1:${port}`]).has(host) || typeof request.url !== "string" || request.url.length > 8192) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end("invalid local browser test request");
    return;
  }
  const outgoing = https.request({
    hostname: upstream.hostname,
    port: upstream.port,
    method: request.method,
    path: request.url,
    headers: rewrittenRequestHeaders(request),
    rejectUnauthorized: false,
    timeout: 45_000,
  }, (incoming) => {
    response.writeHead(incoming.statusCode ?? 502, rewrittenResponseHeaders(incoming.headers));
    incoming.pipe(response);
  });
  outgoing.on("timeout", () => outgoing.destroy(new Error("upstream timeout")));
  outgoing.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end("Spark browser test upstream unavailable");
  });
  request.pipe(outgoing);
});

server.listen(port, "127.0.0.1", () => process.stdout.write(JSON.stringify({ status: "ready", listen: `http://localhost:${port}`, upstream: upstream.origin }) + "\n"));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
