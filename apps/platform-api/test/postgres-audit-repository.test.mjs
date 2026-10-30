import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAuditRepository } from "../src/audit/postgres-audit-repository.mjs";

const EVENT = "018f6f18-24d7-7c21-9b62-8c0174199501";
const ACTOR = "018f6f18-24d7-7c21-9b62-8c017419958b";
const NOW = "2026-08-11T12:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;
const SIGNATURE = `hmac-sha256:${"b".repeat(64)}`;
function compact(sql) { return sql.replace(/\s+/g, " ").trim(); }
function canonicalEvent() { return { schemaVersion: 1, eventId: EVENT, occurredAt: NOW, actor: { identityId: ACTOR, kind: "administrator" }, action: "provider.created", domain: "provider", outcome: "succeeded", resource: { kind: "provider", id: EVENT }, correlationId: "request-audit-12345678", metadata: { providerId: EVENT } }; }
function row() { return { sequence_id: "7", event_hash: Buffer.from("a".repeat(64), "hex"), previous_event_hash: null, canonical_payload: canonicalEvent(), checkpoint_algorithm: "hmac-sha256", checkpoint_key_id: "audit.primary.v1", checkpoint_signature: Buffer.from("b".repeat(64), "hex") }; }

class Database {
  calls = [];
  constructor(handler) { this.handler = handler; }
  async query(sql, parameters = []) { const normalized = compact(sql); this.calls.push([normalized, parameters]); return this.handler(normalized, parameters); }
  async transaction(operation) { return operation({ query: (sql, parameters = []) => this.query(sql, parameters) }); }
}

test("PostgreSQL audit append serializes the chain and persists canonical signed evidence", async () => {
  const database = new Database((sql) => {
    if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [{}] };
    if (sql.startsWith("SELECT sequence_id,event_hash")) return { rows: [] };
    if (sql.startsWith("INSERT INTO audit.audit_references")) return { rows: [row()] };
    return { rows: [] };
  });
  const repository = new PostgresAuditRepository({ database });
  const saved = await repository.append({ event: canonicalEvent(), previousEventHash: null, eventHash: HASH,
    checkpoint: { algorithm: "hmac-sha256", keyId: "audit.primary.v1", signature: SIGNATURE } });
  assert.equal(saved.sequenceId, 7);
  assert.equal(saved.eventHash, HASH);
  assert.equal(saved.checkpoint.signature, SIGNATURE);
  assert.match(database.calls[2][0], /schema_version,domain,outcome,correlation_key,canonical_payload/);
  assert.equal(database.calls[2][1][7], null);
  assert.equal(JSON.stringify(database.calls).includes("private prompt"), false);
});

test("PostgreSQL audit append rejects a stale expected head before insert", async () => {
  const database = new Database((sql) => {
    if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [{}] };
    if (sql.startsWith("SELECT sequence_id,event_hash")) return { rows: [{ sequence_id: "6", event_hash: Buffer.from("c".repeat(64), "hex") }] };
    throw new Error("insert must not run");
  });
  const repository = new PostgresAuditRepository({ database });
  assert.equal(await repository.append({ event: canonicalEvent(), previousEventHash: null, eventHash: HASH,
    checkpoint: { algorithm: "hmac-sha256", keyId: "audit.primary.v1", signature: SIGNATURE } }), null);
  assert.equal(database.calls.length, 2);
});

test("PostgreSQL audit head, reverse listing, and forward verification scan map digests", async () => {
  const database = new Database((sql) => sql.startsWith("SELECT sequence_id,event_hash") ? { rows: [{ sequence_id: "7", event_hash: Buffer.from("a".repeat(64), "hex") }] } : { rows: [row()] });
  const repository = new PostgresAuditRepository({ database });
  assert.deepEqual(await repository.head(), { sequenceId: 7, eventHash: HASH });
  assert.equal((await repository.list({ domain: "provider", correlationId: "request-audit-12345678", afterSequence: 9, limit: 10 }))[0].domain, "provider");
  assert.equal((await repository.scan({ afterSequence: 0, limit: 1000 }))[0].checkpoint.keyId, "audit.primary.v1");
  assert.match(database.calls[1][0], /ORDER BY sequence_id DESC/);
  assert.match(database.calls[1][0], /correlation_key=\$2/);
  assert.deepEqual(database.calls[1][1], ["provider", "request-audit-12345678", 9, 10]);
  assert.match(database.calls[2][0], /ORDER BY sequence_id ASC/);
  await repository.scan({ afterSequence: 4, throughSequence: 7, limit: 3 });
  assert.match(database.calls[3][0], /sequence_id<=\$3/);
  assert.deepEqual(database.calls[3][1], [4, 3, 7]);
});

test("PostgreSQL audit repository requires transactional storage", () => {
  assert.throws(() => new PostgresAuditRepository({ database: { query() {} } }), /query and transaction/);
});
