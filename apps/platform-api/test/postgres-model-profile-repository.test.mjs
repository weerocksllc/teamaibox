import assert from "node:assert/strict";
import test from "node:test";

import { PostgresModelProfileRepository } from "../src/models/postgres-model-profile-repository.mjs";

const fingerprint = `sha256:${"f".repeat(64)}`;
const profile = {
  schemaVersion: 1,
  profileId: "00000000-0000-4000-8000-000000007201",
  profileKey: "llm.spark.nvfp4.r1",
  capabilityId: "00000000-0000-4000-8000-000000007202",
  source: { model: "example/model", revision: "rev-1" },
  engine: { name: "tensorrt-llm", version: "1.2.0" },
  precision: "nvfp4",
  artifactDigest: `sha256:${"a".repeat(64)}`,
  quantizationRecipe: { scheme: "nvfp4" },
  compatibility: { architectures: ["linux/arm64/v8"] },
  resourceEnvelope: { accountingMode: "observed", cpuMillis: 1000, unifiedMemoryBytes: 1024 },
  certification: { state: "discovery", evidenceRefs: [] },
  exclusive: false,
  createdAt: "2026-08-11T09:00:00.000Z",
};

test("PostgreSQL registration serializes identity and atomically writes projection plus immutable document", async () => {
  const calls = [];
  const database = {
    async query() { return { rows: [] }; },
    async transaction(operation) {
      return operation({
        async query(sql, parameters) {
          calls.push({ sql, parameters });
          if (sql.includes("RETURNING profile_document")) {
            return { rows: [{ profile_document: profile, profile_fingerprint: Buffer.from("f".repeat(64), "hex") }] };
          }
          return { rows: [] };
        },
      });
    },
  };
  const repository = new PostgresModelProfileRepository({ database });
  const result = await repository.registerImmutable({
    profile, fingerprint,
    registeredBy: "00000000-0000-4000-8000-000000007203",
    operationKey: "model-register-7201",
  });
  assert.equal(result.created, true);
  assert.equal(result.profile.profileId, profile.profileId);
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  assert.ok(calls.some(({ sql }) => sql.includes("INSERT INTO compute.model_profiles")));
  assert.ok(calls.some(({ sql }) => sql.includes("INSERT INTO compute.model_profile_registrations")));
  assert.equal(calls.some(({ sql }) => /UPDATE|DELETE/.test(sql)), false);
  const projection = calls.find(({ sql }) => sql.includes("INSERT INTO compute.model_profiles"));
  assert.equal(projection.parameters[7], "nvfp4");
  assert.equal(projection.parameters[8], profile.artifactDigest);
});

test("PostgreSQL exact replay returns the original immutable profile without inserting", async () => {
  const calls = [];
  const database = {
    async query() { return { rows: [] }; },
    async transaction(operation) {
      return operation({
        async query(sql) {
          calls.push(sql);
          if (sql.includes("FROM compute.model_profile_registrations")) {
            return { rows: [{ profile_document: profile, profile_fingerprint: Buffer.from("f".repeat(64), "hex") }] };
          }
          return { rows: [] };
        },
      });
    },
  };
  const result = await new PostgresModelProfileRepository({ database }).registerImmutable({
    profile: { ...profile, profileId: "00000000-0000-4000-8000-000000007299" },
    fingerprint,
    registeredBy: "00000000-0000-4000-8000-000000007203",
    operationKey: "model-register-7202",
  });
  assert.equal(result.created, false);
  assert.equal(result.profile.profileId, profile.profileId);
  assert.equal(calls.some((sql) => sql.includes("INSERT INTO")), false);
});

test("PostgreSQL repository requires a transactional adapter", () => {
  assert.throws(() => new PostgresModelProfileRepository({ database: { async query() {} } }), /transactional adapter/);
});
