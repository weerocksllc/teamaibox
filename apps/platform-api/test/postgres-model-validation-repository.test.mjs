import assert from "node:assert/strict";
import test from "node:test";

import { PostgresModelValidationRepository } from "../src/models/postgres-model-validation-repository.mjs";

const fingerprint = `sha256:${"ff".repeat(32)}`;
const runId = "00000000-0000-4000-8000-000000007801";
const createdAt = "2026-08-11T12:00:00.000Z";
const stages = ["discovery", "build", "smoke", "conformance", "quality", "benchmark", "stress_soak", "coexistence_cluster", "security", "certification"];
function plan() {
  return {
    schemaVersion: 1, runKey: "model.validation.pg.r1",
    profile: { profileKey: "model.profile.r1", fingerprint: `sha256:${"aa".repeat(32)}` },
    build: { jobId: "00000000-0000-4000-8000-000000007802", fingerprint: `sha256:${"bb".repeat(32)}` },
    deployment: { jobId: "00000000-0000-4000-8000-000000007803", fingerprint: `sha256:${"cc".repeat(32)}` },
    corpusDigest: `sha256:${"dd".repeat(32)}`, policyDigest: `sha256:${"ee".repeat(32)}`,
    stages: stages.map((stage) => ({ stage })),
  };
}
function runRow(overrides = {}) {
  return {
    id: runId, run_key: "model.validation.pg.r1",
    plan_fingerprint: Buffer.from("ff".repeat(32), "hex"), profile_key: "model.profile.r1",
    build_job_id: plan().build.jobId, deployment_job_id: plan().deployment.jobId,
    plan: plan(), state: "validating", current_ordinal: 0, requested_by: null,
    operation_key: "model-validation-pg-7801", created_at: createdAt, updated_at: createdAt,
    ...overrides,
  };
}
function stageRows() {
  return stages.map((stage, ordinal) => ({
    run_id: runId, ordinal, stage, specification: { stage },
    state: ordinal === 0 ? "queued" : "pending", claimed_by_worker: null,
    claim_expires_at: null, result: null, created_at: createdAt, updated_at: createdAt,
  }));
}

test("PostgreSQL validation creation atomically writes ten stages and replay alias", async () => {
  const calls = [];
  const database = {
    async query() { return { rows: [] }; },
    async transaction(operation) {
      return operation({
        async query(sql, parameters = []) {
          calls.push({ sql, parameters });
          if (sql.includes("INSERT INTO compute.model_validation_runs")) return { rows: [runRow()] };
          if (sql.includes("SELECT * FROM compute.model_validation_runs WHERE id")) return { rows: [runRow()] };
          if (sql.includes("SELECT * FROM compute.model_validation_stages")) return { rows: stageRows() };
          return { rows: [] };
        },
      });
    },
  };
  const repository = new PostgresModelValidationRepository({ database });
  const result = await repository.createRun({ plan: plan(), fingerprint, operationKey: "model-validation-pg-7801", requestedBy: null });
  assert.equal(result.created, true);
  assert.equal(result.run.stages.length, 10);
  assert.ok(calls.some(({ sql }) => sql.includes("jsonb_array_elements")));
  assert.ok(calls.some(({ sql }) => sql.includes("model_validation_operations")));
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
});

test("PostgreSQL stage completion delegates sequence and fence checks to one database function", async () => {
  const calls = [];
  const database = {
    async query() { return { rows: [] }; },
    async transaction(operation) {
      return operation({
        async query(sql, parameters = []) {
          calls.push({ sql, parameters });
          if (sql.includes("SELECT * FROM compute.model_validation_runs WHERE id")) return { rows: [runRow({ state: "failed" })] };
          if (sql.includes("SELECT * FROM compute.model_validation_stages")) return { rows: stageRows().map((row, index) => index === 0 ? { ...row, state: "failed", result: { outcome: "failed" } } : { ...row, state: "blocked" }) };
          return { rows: [] };
        },
      });
    },
  };
  const repository = new PostgresModelValidationRepository({ database });
  const token = "validation-claim-not-stored-in-plaintext";
  const completed = await repository.completeStage({
    runId, ordinal: 0, workerId: "worker.spark.validation", claimToken: token,
    result: { outcome: "failed" },
  });
  assert.equal(completed.run.state, "failed");
  assert.match(calls[0].sql, /complete_model_validation_stage/);
  assert.equal(Buffer.isBuffer(calls[0].parameters[3]), true);
  assert.equal(calls[0].parameters.includes(token), false);
});

test("PostgreSQL validation repository requires transactions", () => {
  assert.throws(() => new PostgresModelValidationRepository({ database: { async query() {} } }), /transactional adapter/);
});
