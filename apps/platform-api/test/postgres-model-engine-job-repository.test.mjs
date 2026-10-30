import assert from "node:assert/strict";
import test from "node:test";

import { PostgresModelEngineJobRepository } from "../src/models/postgres-model-engine-job-repository.mjs";

const fingerprint = `sha256:${"aa".repeat(32)}`;
const createdAt = "2026-08-11T11:00:00.000Z";
function buildRow(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000007601",
    build_key: "qwen.nvfp4.engine.r1",
    specification_fingerprint: Buffer.from("aa".repeat(32), "hex"),
    specification: { schemaVersion: 1, buildKey: "qwen.nvfp4.engine.r1" },
    state: "queued", claimed_by_worker: null, claim_expires_at: null,
    result: null, error_code: null, requested_by: null,
    operation_key: "model-engine-build-7601", created_at: createdAt, updated_at: createdAt,
    ...overrides,
  };
}

test("PostgreSQL engine build enqueue serializes operation/fingerprint and persists replay alias", async () => {
  const calls = [];
  const database = {
    async query() { return { rows: [] }; },
    async transaction(operation) {
      return operation({
        async query(sql, parameters = []) {
          calls.push({ sql, parameters });
          if (sql.includes("INSERT INTO compute.model_engine_build_jobs")) return { rows: [buildRow()] };
          return { rows: [] };
        },
      });
    },
  };
  const repository = new PostgresModelEngineJobRepository({ database });
  const result = await repository.enqueueBuild({
    specification: { schemaVersion: 1, buildKey: "qwen.nvfp4.engine.r1" },
    fingerprint, operationKey: "model-engine-build-7601", requestedBy: null,
  });
  assert.equal(result.created, true);
  assert.equal(result.job.fingerprint, fingerprint);
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  assert.ok(calls.some(({ sql }) => sql.includes("model_engine_build_operations")));
  assert.equal(calls.some(({ parameters }) => parameters.some((value) => value === fingerprint)), false);
});

test("PostgreSQL build claim stores only a SHA-256 fence and checks expiry", async () => {
  const calls = [];
  const database = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes("UPDATE compute.model_engine_build_jobs")) {
        return { rows: [buildRow({ state: "running", claimed_by_worker: "worker.spark.1", claim_expires_at: "2026-08-11T12:00:00.000Z" })] };
      }
      if (sql.includes("SELECT 1")) return { rows: [{ "?column?": 1 }] };
      return { rows: [] };
    },
    async transaction(operation) { return operation(this); },
  };
  const repository = new PostgresModelEngineJobRepository({ database });
  const token = "claim-token-that-must-not-be-persisted";
  const claimed = await repository.claimBuild({
    jobId: buildRow().id, workerId: "worker.spark.1", claimToken: token,
    expiresAt: "2026-08-11T12:00:00.000Z",
  });
  assert.equal(claimed.state, "running");
  assert.equal(Buffer.isBuffer(calls[0].parameters[2]), true);
  assert.equal(calls[0].parameters.includes(token), false);
  assert.equal(await repository.verifyBuildClaim({ jobId: buildRow().id, workerId: "worker.spark.1", claimToken: token }), true);
  assert.match(calls[1].sql, /claim_expires_at > clock_timestamp/);
});

test("PostgreSQL engine jobs require a transactional database adapter", () => {
  assert.throws(() => new PostgresModelEngineJobRepository({ database: { async query() {} } }), /transactional adapter/);
});
