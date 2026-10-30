import assert from "node:assert/strict";
import test from "node:test";

import { PostgresExternalObjectGrantRepository } from "../src/postgres-external-object-grant-repository.mjs";

const uuid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const NOW = new Date("2026-08-11T08:00:00Z");
const compact = (sql) => sql.replace(/\s+/g, " ").trim();
function row(overrides = {}) {
  return {
    id: uuid(1), ticket_digest: Buffer.alloc(32, 1), owner_identity_id: uuid(2), job_id: uuid(3),
    attempt_id: uuid(4), provider_id: uuid(5), direction: "input", reference_id: uuid(6),
    audience: `external-provider:${uuid(5)}:${uuid(4)}`, operations: ["head", "read", "range"],
    expected_sha256: Buffer.alloc(32, 2), expected_size: "100", maximum_bytes: "100",
    media_type: "image/png", destination_object_key: null, maximum_uses: "1024", use_count: "0",
    state: "active", created_at: NOW, expires_at: new Date(NOW.getTime() + 60_000), last_used_at: null,
    completed_at: null, failed_at: null, failure_code: null, revoked_at: null, revoke_reason: null,
    completed_object_id: null, completed_object_version: null, completed_sha256: null,
    ...overrides,
  };
}
class Database {
  queries = [];
  constructor(handler) { this.handler = handler; }
  async query(sql, parameters = []) { this.queries.push({ sql: compact(sql), parameters }); return this.handler(compact(sql), parameters); }
  async transaction(operation) { return operation({ query: (sql, parameters = []) => this.query(sql, parameters) }); }
}

test("PostgreSQL external grants persist only a ticket digest and exact scoped facts", async () => {
  const database = new Database((sql) => ({ rows: sql.startsWith("INSERT INTO") ? [row()] : [] }));
  const repository = new PostgresExternalObjectGrantRepository({ database });
  const result = await repository.create({
    grantId: uuid(1), ticketDigest: "01".repeat(32), ownerIdentityId: uuid(2), jobId: uuid(3),
    attemptId: uuid(4), providerId: uuid(5), direction: "input", referenceId: uuid(6),
    audience: row().audience, operations: ["head", "read", "range"], expectedSha256: `sha256:${"02".repeat(32)}`,
    expectedSize: 100, maximumBytes: 100, mediaType: "image/png", destinationObjectKey: null,
    maximumUses: 1024, useCount: 0, state: "active", createdAt: NOW, expiresAt: new Date(NOW.getTime() + 60_000),
  });
  assert.equal(result.ticketDigest, "01".repeat(32));
  assert.ok(Buffer.isBuffer(database.queries[0].parameters[1]));
  assert.equal(database.queries[0].parameters.some((value) => typeof value === "string" && value.length === 43), false);
});

test("PostgreSQL authorization atomically fences expiry, operation, state, and use count", async () => {
  const database = new Database((sql) => ({ rows: sql.startsWith("UPDATE compute.external_object_grants") ? [row({ use_count: "1", last_used_at: NOW })] : [] }));
  const result = await new PostgresExternalObjectGrantRepository({ database }).authorize({
    ticketDigest: "01".repeat(32), operation: "range", usedAt: NOW,
  });
  assert.equal(result.useCount, 1);
  assert.match(database.queries[0].sql, /state='active' AND expires_at>\$3/);
  assert.match(database.queries[0].sql, /operations \? \$2 AND use_count<maximum_uses/);
});

test("PostgreSQL external object repository requires transaction support", () => {
  assert.throws(() => new PostgresExternalObjectGrantRepository({ database: { query() {} } }), /query and transaction/);
});
