import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { createPostgresDatabaseFromEnvironment } from "../../../packages/persistence/src/postgres-database.mjs";
import { NatsJetStreamClient } from "./nats-jetstream-client.mjs";
import { OutboxPublisherService } from "./outbox-publisher-service.mjs";


async function token(path) {
  if (typeof path !== "string" || !path.startsWith("/")) throw new TypeError("NATS token file must be absolute");
  const raw = await readFile(path);
  try {
    const value = raw.toString("utf8").trim();
    if (!/^[A-Za-z0-9_-]{43,171}$/.test(value)) throw new TypeError("NATS token is invalid");
    return value;
  } finally { raw.fill(0); }
}


function reply(response, status, value) {
  const payload = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "cache-control": "no-store", "content-length": payload.byteLength, "content-type": "application/json" });
  response.end(payload);
}


export async function startMessagingPublisher(environment = process.env) {
  const database = await createPostgresDatabaseFromEnvironment(environment);
  await database.ready();
  const publisher = new OutboxPublisherService({
    database,
    jetstream: new NatsJetStreamClient({
      host: environment.TEAMAIBOX_EVENT_BUS_HOST || "event-bus",
      port: Number(environment.TEAMAIBOX_EVENT_BUS_PORT || "4222"),
      token: await token(environment.TEAMAIBOX_EVENT_BUS_TOKEN_FILE),
    }),
  });
  await publisher.start();
  const server = createServer(async (request, response) => {
    if (request.method !== "GET" || new URL(request.url, "http://messaging.invalid").pathname !== "/health/ready") {
      reply(response, 404, { error: { code: "not_found" } });
      return;
    }
    try {
      const health = await publisher.health();
      reply(response, health.ready ? 200 : 503, { status: health.ready ? "ready" : "not_ready", service: "messaging", ...health });
    } catch { reply(response, 503, { status: "not_ready", service: "messaging" }); }
  });
  const port = Number(environment.TEAMAIBOX_MESSAGING_SERVICE_PORT || "8080");
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "0.0.0.0", resolve); });
  let closing = false;
  const close = () => { if (!closing) { closing = true; publisher.stop(); server.close(); } };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  server.once("close", () => { void database.close(); });
  return server;
}


if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startMessagingPublisher().catch((error) => {
    process.stderr.write(`messaging service failed: ${error?.message ?? "unknown error"}\n`);
    process.exitCode = 1;
  });
}
