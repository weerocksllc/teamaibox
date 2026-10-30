import assert from "node:assert/strict";
import test from "node:test";

import { PostgresModelArtifactRepository } from "../src/models/postgres-model-artifact-repository.mjs";

const artifactDigest = `sha256:${"aa".repeat(32)}`;
const chunkDigest = `sha256:${"bb".repeat(32)}`;
const createdAt = "2026-08-11T10:00:00.000Z";

function importRow(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000007401", account_key: "model-cache",
    candidate_key: "example-nvfp4", source_kind: "online", artifact_name: "weights.bin",
    artifact_sha256: Buffer.from("aa".repeat(32), "hex"), size_bytes: 8,
    media_type: "application/octet-stream", chunk_size_bytes: 4,
    source_uri: "https://models.example.test/revision/weights.bin", source_revision: "revision-1",
    signature: null, bundle_signature_verified: false, state: "active", received_bytes: 0,
    next_ordinal: 0, source_etag: null, source_last_modified: null,
    deduplicated: false, error_code: null, requested_by: null,
    operation_key: "model-import-postgres-001", created_at: createdAt, updated_at: createdAt,
    ...overrides,
  };
}

test("PostgreSQL begins a resumable import without booking its declared size", async () => {
  const calls = [];
  const database = {
    async query() { return { rows: [] }; },
    async transaction(operation) {
      return operation({
        async query(sql, parameters = []) {
          calls.push({ sql, parameters });
          if (sql.includes("UPDATE compute.model_cache_accounts") && sql.includes("RETURNING account_key")) return { rows: [{ account_key: "model-cache" }] };
          if (sql.includes("INSERT INTO compute.model_artifact_imports")) return { rows: [importRow()] };
          return { rows: [] };
        },
      });
    },
  };
  const repository = new PostgresModelArtifactRepository({ database, quotaBytes: 1024 });
  const result = await repository.beginImport({
    candidateId: "example-nvfp4", sourceKind: "online", artifactName: "weights.bin",
    digest: artifactDigest, sizeBytes: 8, mediaType: "application/octet-stream", chunkSizeBytes: 4,
    sourceUri: "https://models.example.test/revision/weights.bin", sourceRevision: "revision-1",
    signature: null, bundleSignatureVerified: false, requestedBy: null,
    operationKey: "model-import-postgres-001",
  });
  assert.equal(result.import.digest, artifactDigest);
  assert.equal('reservationBytes' in result.import, false);
  assert.ok(calls.some(({ sql }) => sql.includes("pg_advisory_xact_lock")));
  assert.equal(calls.some(({sql})=>/reserved_bytes|reservation_bytes/.test(sql)),false);
  const insertion = calls.find(({ sql }) => sql.includes("INSERT INTO compute.model_artifact_imports"));
  assert.equal(Buffer.isBuffer(insertion.parameters[4]), true);
  assert.equal(insertion.parameters.some((value) => typeof value === "string" && value.includes("password")), false);
});

test("PostgreSQL chunk recording uses the atomic protected-cache database function", async () => {
  const calls = [];
  const progressed = importRow({ received_bytes: 4, next_ordinal: 1, source_etag: '"stable"' });
  const database = {
    async query() { return { rows: [] }; },
    async transaction(operation) {
      return operation({
        async query(sql, parameters = []) {
          calls.push({ sql, parameters });
          if (sql.includes("record_model_import_chunk")) return { rows: [{ chunk_created: true }] };
          if (sql.includes("FROM compute.model_artifact_imports")) return { rows: [progressed] };
          return { rows: [] };
        },
      });
    },
  };
  const repository = new PostgresModelArtifactRepository({ database, quotaBytes: 1024 });
  const result = await repository.recordChunk({
    importId: progressed.id, ordinal: 0, offset: 0, digest: chunkDigest, sizeBytes: 4,
    blobKey: `models/chunks/sha256/${chunkDigest.slice(7)}`, etag: '"stable"', lastModified: null,
  });
  assert.equal(result.chunkCreated, true);
  assert.equal(result.import.receivedBytes, 4);
  assert.match(calls[0].sql, /compute\.record_model_import_chunk/);
  assert.equal(Buffer.from(calls[0].parameters[3]).toString("hex"), "bb".repeat(32));
});

test("PostgreSQL repository validates transactional adapter and configured quota", () => {
  assert.throws(() => new PostgresModelArtifactRepository({ database: { async query() {} }, quotaBytes: 1 }), /transactional adapter/);
  assert.throws(() => new PostgresModelArtifactRepository({ database: { async query() {}, async transaction() {} }, quotaBytes: 0 }), /quota/);
});

test('actual write limit errors are classified without turning them into advance admission',async()=>{
  const database={query:async()=>({rows:[]}),transaction:async()=>{throw Object.assign(new Error('actual write full'),{code:'53100'});}};
  const repository=new PostgresModelArtifactRepository({database,quotaBytes:8});
  await assert.rejects(repository.recordChunk({importId:importRow().id}),{code:'model_cache_quota_exceeded'});
  assert.deepEqual(await repository.usage(),{quotaBytes:8,committedBytes:0,availableBytes:8,readyArtifacts:0,chunks:0});
});
