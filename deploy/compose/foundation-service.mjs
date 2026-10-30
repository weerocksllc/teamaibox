import http from "node:http";

const service = process.env.SERVICE_NAME;
if (!service || !/^[a-z][a-z0-9-]{2,63}$/.test(service)) {
  throw new Error("SERVICE_NAME must be a safe non-empty service identifier");
}

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("PORT must be an unprivileged TCP port");
}

let draining = false;
const startedAt = Date.now();

function reply(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(payload);
}

const server = http.createServer((request, response) => {
  if (request.method !== "GET") {
    reply(response, 405, { error: { code: "method_not_allowed" } });
    return;
  }
  if (request.url === "/health/live") {
    reply(response, 200, { status: "ok", service });
    return;
  }
  if (request.url === "/health/ready") {
    reply(response, draining ? 503 : 200, {
      status: draining ? "not_ready" : "ready",
      service,
      foundationStub: true,
    });
    return;
  }
  if (request.url === "/version") {
    reply(response, 200, {
      service,
      version: "0.1.0",
      runtime: process.version,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
    return;
  }
  reply(response, 404, { error: { code: "not_found" } });
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(JSON.stringify({ event: "listening", port, service }) + "\n");
});

function shutdown(signal) {
  if (draining) return;
  draining = true;
  process.stdout.write(JSON.stringify({ event: "draining", service, signal }) + "\n");
  server.close((error) => {
    process.exitCode = error ? 1 : 0;
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

