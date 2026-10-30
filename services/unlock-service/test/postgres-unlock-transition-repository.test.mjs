import assert from "node:assert/strict";
import test from "node:test";

import { PostgresUnlockTransitionRepository } from "../src/postgres-unlock-transition-repository.mjs";

const uuid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const bytes = (value) => Buffer.from(value.repeat(64), "hex");
const NOW = new Date("2026-08-11T12:00:00Z");
const compact = (sql) => sql.replace(/\s+/g, " ").trim();
const value = { planId: uuid(1), requestId: uuid(2), actorIdentityId: uuid(3), mode: "web_passphrase", volumeUuid: "11111111-2222-3333-4444-555555555555", headerRevisionBefore: `sha256:${"a".repeat(64)}`, automaticSlotId: 0, recoverySlotId: 1, selectedSlotId: 2, backupEvidenceDigest: `sha256:${"b".repeat(64)}`, recoveryVerificationId: uuid(4), recoveryEvidenceDigest: `sha256:${"c".repeat(64)}`, selectedVerificationId: uuid(5), selectedEvidenceDigest: `sha256:${"d".repeat(64)}`, drainEvidenceDigest: `sha256:${"e".repeat(64)}`, simulationEvidenceDigest: `sha256:${"f".repeat(64)}`, state: "prepared", revision: 1, preparedAt: NOW, expiresAt: new Date(NOW.getTime() + 3600000) };
function row(state = "prepared", revision = 1) { return { plan_id: value.planId, request_id: value.requestId, actor_identity_id: value.actorIdentityId, mode: value.mode, volume_uuid: value.volumeUuid, header_revision_before: bytes("a"), automatic_slot_id: 0, recovery_slot_id: 1, selected_slot_id: 2, backup_evidence_digest: bytes("b"), recovery_verification_id: value.recoveryVerificationId, recovery_evidence_digest: bytes("c"), selected_verification_id: value.selectedVerificationId, selected_evidence_digest: bytes("d"), drain_evidence_digest: bytes("e"), simulation_evidence_digest: bytes("f"), state, revision, prepared_at: NOW, expires_at: value.expiresAt, header_backup_id: state === "prepared" ? null : uuid(6), header_backup_digest: state === "prepared" ? null : bytes("f"), committed_at: state === "prepared" ? null : NOW, header_revision_after: state === "enabled" ? bytes("e") : null, enabled_at: state === "enabled" ? NOW : null, rollback_passed: null, failure_code: null, failed_at: null }; }

class Database {
  queries = [];
  async query(sql, parameters = []) {
    const text = compact(sql); this.queries.push({ sql: text, parameters });
    if (text.startsWith("SELECT * FROM security.unlock_protection_transitions WHERE request_id")) return { rows: [] };
    if (text.startsWith("INSERT INTO security.unlock_protection_transitions")) return { rows: [row()] };
    if (text.startsWith("UPDATE security.unlock_protection_transitions SET state='committing'")) return { rows: [row("committing", 2)] };
    return { rows: [] };
  }
  async transaction(operation) { return operation({ query: (sql, parameters = []) => this.query(sql, parameters) }); }
}

test("PostgreSQL preparation locks idempotency and stores only digest slot and verification facts", async () => {
  const database = new Database();
  const result = await new PostgresUnlockTransitionRepository({ database }).createPrepared(value);
  assert.equal(result.planId, value.planId);
  assert.equal(result.headerRevisionBefore, value.headerRevisionBefore);
  assert.ok(database.queries[0].sql.includes("pg_advisory_xact_lock"));
  assert.ok(database.queries[1].sql.includes("FOR UPDATE"));
  const insert = database.queries[2];
  assert.equal(Buffer.isBuffer(insert.parameters[5]), true);
  assert.doesNotMatch(JSON.stringify(insert.parameters), /"(?:passphrase|rawFactor|keyBytes)"\s*:/);
});

test("PostgreSQL commit transition is revision and prepared-state fenced", async () => {
  const database = new Database();
  const result = await new PostgresUnlockTransitionRepository({ database }).beginCommit({ planId: value.planId, expectedRevision: 1, headerBackupId: uuid(6), headerBackupDigest: `sha256:${"f".repeat(64)}`, committedAt: NOW });
  assert.equal(result.state, "committing");
  assert.ok(database.queries[0].sql.includes("state='prepared' AND revision=$2"));
  assert.ok(database.queries[1].sql.includes("unlock_protection_transition_events"));
});

test("PostgreSQL unlock transition repository requires transactions", () => {
  assert.throws(() => new PostgresUnlockTransitionRepository({ database: { query() {} } }), /support transactions/);
});

test("PostgreSQL unlock transition repository exposes bounded newest-first administration history", async () => {
  const database = {
    async query(sql, parameters = []) {
      assert.match(sql, /ORDER BY prepared_at DESC,plan_id DESC LIMIT/);
      if (parameters.length) assert.deepEqual(parameters, [8]);
      return { rows: [row()] };
    },
    async transaction() { throw new Error("not used"); },
  };
  const repository = new PostgresUnlockTransitionRepository({ database });
  assert.equal((await repository.latest()).planId, value.planId);
  assert.equal((await repository.listRecent(8))[0].planId, value.planId);
  await assert.rejects(repository.listRecent(0), TypeError);
});
