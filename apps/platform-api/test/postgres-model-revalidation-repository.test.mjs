import assert from "node:assert/strict";
import test from "node:test";

import { PostgresModelRevalidationRepository } from "../src/models/postgres-model-revalidation-repository.mjs";

const profileId = "00000000-0000-4000-8000-000000008201";
const runId = "00000000-0000-4000-8000-000000008202";
const digest = (character) => `sha256:${character.repeat(64)}`;

test("PostgreSQL certification baseline is serialized and immutable-idempotent", async () => {
  const calls = [];
  const database = {
    async query() { return { rows: [] }; },
    async transaction(callback) {
      return callback({ async query(sql, parameters) {
        calls.push({ sql, parameters });
        if (sql.includes("WHERE model_profile_id") && sql.includes("FOR SHARE")) return { rows: [] };
        if (sql.includes("INSERT INTO compute.model_profile_certification_baselines")) return { rows: [{
          id: "00000000-0000-4000-8000-000000008203", model_profile_id: profileId,
          lifecycle_revision: "3", validation_run_id: runId, facts: { driverVersion: "580" },
          facts_digest: Buffer.from("a".repeat(64), "hex"), evidence_refs: [],
          recorded_at: "2026-08-11T08:00:00.000Z",
        }] };
        return { rows: [] };
      } });
    },
  };
  const repository = new PostgresModelRevalidationRepository({ database });
  const result = await repository.putBaseline({
    profileId, lifecycleRevision: 3, validationRunId: runId,
    facts: { driverVersion: "580" }, factsDigest: digest("a"), evidenceRefs: [],
    actorIdentityId: null, recordedAt: new Date("2026-08-11T08:00:00.000Z"),
  });
  assert.equal(result.created, true);
  assert.equal(result.baseline.factsDigest, digest("a"));
  assert.ok(calls.some(({ sql }) => sql.includes("pg_advisory_xact_lock")));
});

test("PostgreSQL revalidation checks persist only digests and classified changed dimensions", async () => {
  const calls = [];
  const database = {
    async transaction() { throw new Error("not used"); },
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return { rows: [{ id: "00000000-0000-4000-8000-000000008204", observed_facts_digest: Buffer.from("b".repeat(64), "hex"), checked_at: "2026-08-11T08:05:00.000Z" }] };
    },
  };
  const repository = new PostgresModelRevalidationRepository({ database });
  const result = await repository.recordCheck({
    profileId, baselineId: "00000000-0000-4000-8000-000000008203",
    observedFacts: { driverVersion: "581" }, observedFactsDigest: digest("b"),
    changedDimensions: [{ dimension: "driverVersion", status: "changed" }],
    outcome: "revalidation_required", evidenceRefs: [], workerId: "worker.spark.inventory",
    checkedAt: new Date("2026-08-11T08:05:00.000Z"),
  });
  assert.equal(result.observedFactsDigest, digest("b"));
  assert.ok(calls[0].sql.includes("model_profile_revalidation_checks"));
  assert.equal(JSON.parse(calls[0].parameters[4])[0].dimension, "driverVersion");
});

test("PostgreSQL revalidation repository requires transactional storage", () => {
  assert.throws(() => new PostgresModelRevalidationRepository({ database: { async query() {} } }), /transactional adapter/);
});
