import assert from "node:assert/strict";
import test from "node:test";

import { PostgresModelLifecycleRepository } from "../src/models/postgres-model-lifecycle-repository.mjs";

const profileId = "00000000-0000-4000-8000-000000007901";
const fingerprint = Buffer.from("a".repeat(64), "hex");
function profileRow(overrides = {}) {
  return {
    profile_id: profileId, profile_key: "llm.spark.nvfp4.v1",
    profile_fingerprint: fingerprint, certification_state: "experimental",
    lifecycle_revision: "1", lifecycle_reason_key: "model.lifecycle.registered",
    lifecycle_evidence_refs: [], lifecycle_validation_run_id: null,
    lifecycle_updated_at: "2026-08-11T05:00:00.000Z", ...overrides,
  };
}

test("PostgreSQL lifecycle transition locks the profile and atomically appends its revision event", async () => {
  const calls = [];
  const database = {
    async query() { return { rows: [] }; },
    async transaction(callback) {
      return callback({
        async query(sql, parameters) {
          calls.push({ sql, parameters });
          if (sql.includes("FOR UPDATE")) return { rows: [{ certification_state: "experimental", lifecycle_revision: "1" }] };
          if (sql.includes("WITH changed AS")) return { rows: [profileRow({ certification_state: "validating", lifecycle_revision: "2", lifecycle_reason_key: "model.lifecycle.validation_started" })] };
          return { rows: [] };
        },
      });
    },
  };
  const repository = new PostgresModelLifecycleRepository({ database });
  const result = await repository.transitionLifecycle({
    profileId, expectedRevision: 1, expectedState: "experimental", nextState: "validating",
    reasonKey: "model.lifecycle.validation_started", evidenceRefs: ["evidence://models/discovery"],
    validationRunId: "00000000-0000-4000-8000-000000007902",
    actorIdentityId: "00000000-0000-4000-8000-000000007903",
    occurredAt: new Date("2026-08-11T05:01:00.000Z"),
  });
  assert.equal(result.state, "validating");
  assert.equal(result.revision, 2);
  assert.ok(calls.some(({ sql }) => sql.includes("FOR UPDATE")));
  assert.ok(calls.some(({ sql }) => sql.includes("INSERT INTO compute.model_profile_lifecycle_events")));
});

test("PostgreSQL lifecycle repository maps profile and expiring policy projections", async () => {
  const calls = [];
  const database = {
    async transaction() { throw new Error("not used"); },
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql.includes("model_profile_registrations")) return { rows: [profileRow()] };
      if (sql.includes("INSERT INTO compute.model_experimental")) return { rows: [{
        policy_key: "lab.spark", environment: "validation", model_profile_id: profileId,
        enabled: true, reason_key: "model.routing.experimental_validation", revision: "2",
        expires_at: "2026-08-12T05:00:00.000Z", updated_at: "2026-08-11T05:00:00.000Z",
      }] };
      return { rows: [{
        policy_key: "lab.spark", environment: "validation", model_profile_id: profileId,
        enabled: true, reason_key: "model.routing.experimental_validation", revision: "2",
        expires_at: "2026-08-12T05:00:00.000Z", updated_at: "2026-08-11T05:00:00.000Z",
      }] };
    },
  };
  const repository = new PostgresModelLifecycleRepository({ database });
  assert.equal((await repository.findProfile(profileId)).fingerprint, `sha256:${"a".repeat(64)}`);
  assert.equal((await repository.listProfiles({ limit: 100 }))[0].profileKey, "llm.spark.nvfp4.v1");
  const optIn = await repository.upsertExperimentalOptIn({
    policyKey: "lab.spark", environment: "validation", profileId, enabled: true,
    reasonKey: "model.routing.experimental_validation", expiresAt: new Date("2026-08-12T05:00:00.000Z"),
    actorIdentityId: null, occurredAt: new Date("2026-08-11T05:00:00.000Z"),
  });
  assert.equal(optIn.revision, 2);
  assert.equal((await repository.listExperimentalOptIns({
    policyKey: "lab.spark", environment: "validation", now: new Date("2026-08-11T05:00:00.000Z"),
  })).length, 1);
  assert.ok(calls.some(({ sql }) => sql.includes("ON CONFLICT")));
});

test("PostgreSQL lifecycle repository requires transactional storage", () => {
  assert.throws(() => new PostgresModelLifecycleRepository({ database: { async query() {} } }), /transactional adapter/);
});
