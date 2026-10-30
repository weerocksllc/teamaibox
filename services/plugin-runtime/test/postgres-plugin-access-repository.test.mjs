import assert from "node:assert/strict";
import test from "node:test";

import { PostgresPluginAccessRepository } from "../src/postgres-plugin-access-repository.mjs";

const digest = `sha256:${"a".repeat(64)}`;

function databaseWith(handler) {
  return {
    async query(sql, parameters) { return handler(sql, parameters); },
    async transaction(callback) { return callback({ query: this.query }); },
  };
}

test("PostgreSQL delegation insert proves the active ApplicationPlugin generation and stores only a hash", async () => {
  const calls = [];
  const repository = new PostgresPluginAccessRepository({
    database: databaseWith(async (sql, parameters) => {
      calls.push({ sql, parameters });
      return { rows: [{ id: "00000000-0000-4000-8000-000000001001" }] };
    }),
  });
  const tokenHash = "b".repeat(64);
  await repository.insertDelegation({
    delegationId: "00000000-0000-4000-8000-000000001001",
    pluginId: "example.team-notes",
    pluginVersion: "1.2.3",
    pluginGeneration: 4,
    audience: "plugin:example.team-notes",
    identityId: "00000000-0000-4000-8000-000000001002",
    sessionId: "00000000-0000-4000-8000-000000001003",
    tokenHash,
    grants: [{ scope: "files:read", permission: "file:read", resource: { kind: "team", key: "team-alpha" } }],
    issuedAt: new Date("2026-08-11T04:00:00Z"),
    expiresAt: new Date("2026-08-11T04:02:00Z"),
  });
  assert.match(calls[0].sql, /plugins\.current_version_id = versions\.id/);
  assert.match(calls[0].sql, /plugins\.generation = \$4/);
  assert.match(calls[0].sql, /plugins\.plugin_type = 'application'/);
  assert.ok(Buffer.isBuffer(calls[0].parameters[7]));
  assert.equal(calls[0].parameters[7].toString("hex"), tokenHash);
  assert.equal(JSON.stringify(calls).includes("taibp_v1_"), false);
});

test("PostgreSQL token lookup projects bounded delegation facts without secret columns", async () => {
  const repository = new PostgresPluginAccessRepository({
    database: databaseWith(async () => ({ rows: [{
      id: "00000000-0000-4000-8000-000000001001",
      plugin_key: "example.team-notes",
      plugin_version: "1.2.3",
      plugin_generation: "4",
      audience: "plugin:example.team-notes",
      identity_id: "00000000-0000-4000-8000-000000001002",
      session_id: "00000000-0000-4000-8000-000000001003",
      token_hash: Buffer.from("c".repeat(64), "hex"),
      grants: [{ scope: "files:read" }],
      issued_at: new Date("2026-08-11T04:00:00Z"),
      expires_at: new Date("2026-08-11T04:02:00Z"),
      last_used_at: null,
      revoked_at: null,
      revoke_reason: null,
    }] })),
  });
  const record = await repository.findDelegationByTokenHash("c".repeat(64));
  assert.equal(record.pluginGeneration, 4);
  assert.equal(record.tokenHash, "c".repeat(64));
  assert.equal(Object.hasOwn(record, "token"), false);
});

function registrationRow() {
  return {
    id: "00000000-0000-4000-8000-000000001011",
    plugin_key: "example.fast-ocr",
    plugin_version: "2.0.0",
    plugin_generation: "5",
    worker_instance_id: "00000000-0000-4000-8000-000000001012",
    worker_generation: "3",
    node_id: "00000000-0000-4000-8000-000000001013",
    control_lease_id: "00000000-0000-4000-8000-000000001014",
    control_fencing_token: "7",
    model_profile_id: "00000000-0000-4000-8000-000000001015",
    capability_id: "00000000-0000-4000-8000-000000001016",
    capability_key: "ocr.document",
    modality: "ocr",
    operations: ["ocr"],
    resource_envelope: { cpuMillis: 2000 },
    registration_digest: Buffer.from("a".repeat(64), "hex"),
    registration_state: "available",
    observed_at: new Date("2026-08-11T04:00:00Z"),
    expires_at: new Date("2026-08-11T04:01:30Z"),
    retired_at: null,
    retire_reason: null,
  };
}

test("PostgreSQL compute registration atomically rechecks plugin, worker fence, health, profile, and operations", async () => {
  const calls = [];
  const repository = new PostgresPluginAccessRepository({
    database: databaseWith(async (sql, parameters) => {
      calls.push({ sql, parameters });
      if (/INSERT INTO plugins\.compute_capability_registrations/.test(sql)) return { rows: [{ id: registrationRow().id }] };
      if (/WHERE registrations\.id = \$1/.test(sql)) return { rows: [registrationRow()] };
      return { rows: [] };
    }),
  });
  const record = await repository.putCapabilityRegistration({
    registrationId: registrationRow().id,
    pluginId: "example.fast-ocr",
    pluginVersion: "2.0.0",
    pluginGeneration: 5,
    workerId: registrationRow().worker_instance_id,
    workerGeneration: 3,
    nodeId: registrationRow().node_id,
    leaseId: registrationRow().control_lease_id,
    fencingToken: 7,
    modelProfileId: registrationRow().model_profile_id,
    capabilityId: registrationRow().capability_id,
    operations: ["ocr"],
    resourceEnvelope: { cpuMillis: 2000 },
    registrationDigest: digest,
    observedAt: new Date("2026-08-11T04:00:00Z"),
    expiresAt: new Date("2026-08-11T04:01:30Z"),
  });
  const insert = calls[0];
  assert.match(insert.sql, /plugins\.lifecycle_state = 'enabled'/);
  assert.match(insert.sql, /workers\.control_lease_id = \$10/);
  assert.match(insert.sql, /workers\.control_fencing_token = \$11/);
  assert.match(insert.sql, /profiles\.capability_id = \$9::uuid/);
  assert.match(insert.sql, /workers\.lifecycle_state IN \('ready','busy'\)/);
  assert.match(insert.sql, /profiles\.certification_state = 'certified'/);
  assert.match(insert.sql, /capabilities\.api_operations @> \$12::jsonb/);
  assert.match(insert.sql, /ON CONFLICT .* DO UPDATE/s);
  assert.match(insert.sql, /registration_digest = EXCLUDED\.registration_digest/);
  assert.match(insert.sql, /expires_at = EXCLUDED\.expires_at/);
  assert.equal(record.capabilityKey, "ocr.document");
});

test("PostgreSQL scheduler listing excludes stale plugin generations, fences, unhealthy workers, and expiry", async () => {
  let selected;
  const repository = new PostgresPluginAccessRepository({
    database: databaseWith(async (sql) => {
      selected = sql;
      return { rows: [] };
    }),
  });
  assert.deepEqual(await repository.listCapabilityRegistrations(new Date("2026-08-11T04:00:00Z")), []);
  assert.match(selected, /plugins\.current_version_id = registrations\.plugin_version_id/);
  assert.match(selected, /plugins\.generation = registrations\.plugin_generation/);
  assert.match(selected, /workers\.control_fencing_token = registrations\.control_fencing_token/);
  assert.match(selected, /workers\.health_state = 'healthy'/);
  assert.match(selected, /registrations\.expires_at > \$1/);
});

test("PostgreSQL plugin access repository requires durable transactional storage", () => {
  assert.throws(() => new PostgresPluginAccessRepository({ database: {} }), /PostgreSQL database/);
});
