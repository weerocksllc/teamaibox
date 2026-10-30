import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
createServer(async (request, response) => {
  if (request.url !== "/health/ready") return response.writeHead(404).end();
  const schema = await readFile("/var/lib/teamaibox-browser-canary/schema", "utf8").catch(() => "pending");
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ready: true, schema: schema.trim() }));
}).listen(8081, "0.0.0.0");
