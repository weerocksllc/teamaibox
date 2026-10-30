import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";

import { NatsJetStreamClient } from "../src/nats-jetstream-client.mjs";
import { OutboxPublisherService } from "../src/outbox-publisher-service.mjs";


const TOKEN = Buffer.alloc(32, 33).toString("base64url");


async function fakeNats() {
  const subjects = [];
  let streamExists = false;
  let sequence = 0;
  const server = net.createServer((socket) => {
    socket.write('INFO {"server_id":"test"}\r\n');
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const match = /PUB ([^ ]+) ([^ ]+) (\d+)\r\n/.exec(buffer.toString("utf8"));
        if (!match) return;
        const headerEnd = match.index + match[0].length;
        const size = Number(match[3]);
        if (buffer.byteLength < headerEnd + size + 2) return;
        const subject = match[1], inbox = match[2];
        subjects.push(subject);
        let response;
        if (subject.includes("STREAM.INFO")) response = streamExists
          ? { config: { name: "TEAMAIBOX_EVENTS" }, state: { messages: sequence } }
          : { error: { code: 404 } };
        else if (subject.includes("STREAM.CREATE")) {
          streamExists = true;
          response = { config: { name: "TEAMAIBOX_EVENTS" }, state: { messages: sequence } };
        } else response = { stream: "TEAMAIBOX_EVENTS", seq: ++sequence };
        const payload = Buffer.from(JSON.stringify(response));
        socket.write(`MSG ${inbox} 1 ${payload.byteLength}\r\n`);
        socket.write(payload);
        socket.write("\r\n");
        buffer = buffer.subarray(headerEnd + size + 2);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, subjects };
}


test("minimal authenticated NATS client creates a durable stream and verifies publish acknowledgement", async () => {
  const fixture = await fakeNats();
  try {
    const client = new NatsJetStreamClient({ host: "127.0.0.1", port: fixture.port, token: TOKEN });
    const created = await client.ensureStream();
    assert.equal(created.config.name, "TEAMAIBOX_EVENTS");
    const acknowledged = await client.publish("teamaibox.events.v1.messaging", { eventId: "event-1" });
    assert.deepEqual(acknowledged, { stream: "TEAMAIBOX_EVENTS", sequence: 1, duplicate: false });
    assert.deepEqual(fixture.subjects, [
      "$JS.API.STREAM.INFO.TEAMAIBOX_EVENTS",
      "$JS.API.STREAM.CREATE.TEAMAIBOX_EVENTS",
      "teamaibox.events.v1.messaging",
    ]);
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});


test("outbox publisher claims durable rows, publishes redacted envelope, and commits the exact broker fence", async () => {
  const calls = [];
  const event = {
    event_id: "11111111-1111-4111-8111-111111111111", subject: "teamaibox.events.v1.messaging",
    event_type: "messaging.message_created", schema_version: 1, aggregate_type: "messaging.event",
    aggregate_id: "22222222-2222-4222-8222-222222222222", aggregate_version: "7",
    payload: { eventId: "33333333-3333-4333-8333-333333333333" }, headers: { audience: "messaging-realtime" },
    occurred_at: new Date("2026-08-12T00:00:00Z"), claim_token: "44444444-4444-4444-8444-444444444444",
  };
  const database = { async query(sql, values = []) {
    calls.push({ sql, values });
    if (sql.includes("claim_outbox")) return { rows: [event] };
    if (sql.includes("mark_outbox_published")) return { rows: [{ marked: true }] };
    if (sql.includes("count(*)")) return { rows: [{ count: "0" }] };
    return { rows: [] };
  } };
  const published = [];
  const jetstream = {
    async ensureStream() { return {}; },
    async streamInfo() { return { config: { name: "TEAMAIBOX_EVENTS" }, state: { messages: 1 } }; },
    async publish(subject, envelope) { published.push({ subject, envelope }); return { stream: "TEAMAIBOX_EVENTS", sequence: 12 }; },
  };
  const service = new OutboxPublisherService({ database, jetstream });
  const result = await service.drainOnce();
  assert.deepEqual(result, { claimed: 1, published: 1 });
  assert.equal(published[0].envelope.aggregate.version, 7);
  assert.equal(JSON.stringify(published).includes("private body"), false);
  const mark = calls.find((item) => item.sql.includes("mark_outbox_published"));
  assert.deepEqual(mark.values.slice(2), ["TEAMAIBOX_EVENTS", 12]);
});
