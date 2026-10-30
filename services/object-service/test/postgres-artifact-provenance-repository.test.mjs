import assert from "node:assert/strict";
import { test } from "node:test";

import { PostgresArtifactProvenanceRepository } from "../src/postgres-artifact-provenance-repository.mjs";

const ID = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const OBJECT = "33333333-3333-4333-8333-333333333333";
const SOURCE = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-08-11T08:00:00.000Z";
const digest = Buffer.from("a".repeat(64), "hex");
const row = {
  id: ID, artifact_kind: "ai-result", object_id: OBJECT, object_version: "2", byte_size: "7",
  media_type: "application/json", sha256: digest, object_key: "results/value.json",
  owner_identity_id: OWNER, producer_kind: "compute-job", producer_key: "compute.ocr",
  application_key: "official.ocr", job_id: SOURCE, metadata: { schema: "result.v1" },
  provenance_digest: digest, created_at: NOW,
};

function database(resolver) {
  const calls = [];
  const adapter = {
    async query(sql, values = []) { calls.push({ sql, values }); return resolver(sql, values, calls.length); },
    async transaction(callback) { calls.push({ sql: "BEGIN", values: [] }); return callback(adapter); },
  };
  return { adapter, calls };
}

test("PostgreSQL provenance creation commits immutable object facts and source edges transactionally", async () => {
  const state = database((sql) => {
    if (sql.includes("WHERE provenance_digest") && sql.includes("FOR SHARE")) return { rows: [] };
    if (sql.includes("INSERT INTO objects.artifact_provenance (") && sql.includes("RETURNING")) return { rows: [row] };
    if (sql.includes("artifact_provenance_sources") && sql.includes("SELECT")) return { rows: [{ source_ordinal: 0, relationship: "derived-from", source_object_id: SOURCE, source_object_version: "1", source_sha256: digest, source_provenance_id: null }] };
    return { rows: [], rowCount: 1 };
  });
  const repository = new PostgresArtifactProvenanceRepository({ database: state.adapter });
  const value = await repository.create({
    id: ID, artifactKind: "ai-result",
    object: { objectId: OBJECT, objectVersion: 2, size: 7, mediaType: "application/json", sha256: `sha256:${"a".repeat(64)}`, objectKey: "results/value.json" },
    ownerIdentityId: OWNER,
    producer: { kind: "compute-job", key: "compute.ocr", applicationKey: "official.ocr", jobId: SOURCE },
    sources: [{ ordinal: 0, relationship: "derived-from", objectId: SOURCE, objectVersion: 1, sha256: `sha256:${"a".repeat(64)}`, provenanceId: null }],
    metadata: { schema: "result.v1" }, provenanceDigest: `sha256:${"a".repeat(64)}`, createdAt: new Date(NOW),
  });
  assert.equal(value.created, true);
  assert.equal(value.record.object.objectVersion, 2);
  assert.equal(value.record.sources[0].relationship, "derived-from");
  assert.equal(state.calls[0].sql, "BEGIN");
  assert.ok(state.calls.some((call) => call.sql.includes("INSERT INTO objects.artifact_provenance_sources")));
});

test("PostgreSQL provenance lookup and handoff persist no scoped reference identifier", async () => {
  const state = database((sql) => {
    if (sql.includes("SELECT * FROM objects.artifact_provenance WHERE id")) return { rows: [row] };
    if (sql.includes("artifact_provenance_sources") && sql.includes("SELECT")) return { rows: [] };
    if (sql.includes("INSERT INTO objects.artifact_handoffs")) return { rows: [{ id: SOURCE, provenance_id: ID, object_id: OBJECT, object_version: "2", actor_identity_id: OWNER, consumer_kind: "messaging", consumer_key: "messaging.message", application_key: null, job_id: null, audience: "messaging.attachment", operation: "read", occurred_at: NOW }] };
    return { rows: [] };
  });
  const repository = new PostgresArtifactProvenanceRepository({ database: state.adapter });
  assert.equal((await repository.findById(ID)).id, ID);
  const handoff = await repository.recordHandoff({ id: SOURCE, provenanceId: ID, objectId: OBJECT, objectVersion: 2, actorIdentityId: OWNER, consumer: { kind: "messaging", key: "messaging.message", applicationKey: null, jobId: null }, audience: "messaging.attachment", operation: "read", occurredAt: new Date(NOW) });
  assert.equal(handoff.audience, "messaging.attachment");
  const insert = state.calls.find((call) => call.sql.includes("INSERT INTO objects.artifact_handoffs"));
  assert.equal(insert.sql.includes("reference_id"), false);
});

test("PostgreSQL provenance repository requires transactions", () => {
  assert.throws(() => new PostgresArtifactProvenanceRepository({ database: { query() {} } }), /requires transactions/);
});

test("lineage includes more than 256 ancestors and fetches shared/cyclic parents only once", async () => {
  const ids = Array.from({length: 300}, (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12,'0')}`);
  const state = database((sql, values) => {
    const index = ids.indexOf(values[0]);
    if (sql.includes('SELECT * FROM objects.artifact_provenance WHERE id')) return {rows:[{...row,id:ids[index]}]};
    if (sql.includes('artifact_provenance_sources')) return {rows:[0,1].map(n=>({source_ordinal:n,relationship:'derived-from',source_object_id:SOURCE,
      source_object_version:1,source_sha256:digest,source_provenance_id:ids[(index+1)%ids.length]}))};
    throw Error('unexpected_query');
  });
  const lineage = await new PostgresArtifactProvenanceRepository({database:state.adapter}).lineage(ids[0]);
  assert.deepEqual(lineage.records.map(v=>v.id),ids);
  assert.equal(state.calls.length,600);
});
