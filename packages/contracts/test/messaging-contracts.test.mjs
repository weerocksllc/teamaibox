import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const load = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

test("messaging contracts expose browser and application APIs without reusable storage credentials", async () => {
  const catalog = await load("catalog.v1.json");
  const expected = {
    "http-messaging-conversation": ["http/messaging-conversation.v1.schema.json", "http", "response"],
    "http-messaging-message-submission": ["http/messaging-message-submission.v1.schema.json", "http", "request"],
    "http-messaging-message": ["http/messaging-message.v1.schema.json", "http", "response"],
    "realtime-messaging-event": ["realtime/messaging-event.v1.schema.json", "realtime", "response"],
  };
  const schemas = [];
  for (const [id, [path, family, role]] of Object.entries(expected)) {
    const entry = catalog.contracts.find((value) => value.id === id);
    assert.deepEqual(entry, { id, family, major: 1, role, stability: "stable", path });
    const schema = await load(path);
    schemas.push(schema);
    assert.deepEqual(schema["x-teamaibox-contract"], { family, role, major: 1 });
  }
  const serialized = JSON.stringify(schemas);
  for (const forbidden of ["signed_reference", "access_key", "secret_key", "storage_endpoint", "blob_key"]) {
    assert.equal(serialized.includes(`"${forbidden}"`), false, forbidden);
  }
  assert.ok(serialized.includes("attachment_reference_ids"), "ephemeral attachment inputs remain explicit");
  assert.ok(serialized.includes("object_version"), "durable attachment outputs use immutable object versions");
});
