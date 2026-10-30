import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createTextTransformWorker } from "./worker.mjs";

export function createTextTransformServer(options = {}) {
  const worker = createTextTransformWorker(options);
  return createServer((request, response) => {
    const path = new URL(request.url, "http://worker.invalid").pathname;
    if (request.method === "GET" && path === "/health/live") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "live" }));
      return;
    }
    if (request.method === "GET" && new Set(["/health/startup", "/health/ready"]).has(path)) {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: worker.ready() ? "ready" : "starting" }));
      return;
    }
    if (request.method !== "POST" || path !== "/v1/worker/control") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "not_found" } }));
      return;
    }
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1048576) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", async () => {
      try {
        const result = await worker.handle(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(result));
      } catch {
        response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: { code: "worker_protocol_invalid" } }));
      }
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  createTextTransformServer().listen(port, "0.0.0.0");
}
