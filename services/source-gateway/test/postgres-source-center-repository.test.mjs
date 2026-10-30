import assert from "node:assert/strict";
import test from "node:test";

import { PostgresSourceCenterRepository } from "../src/postgres-source-center-repository.mjs";

const SOURCE = "018f6f18-24d7-7c21-9b62-8c0174199501";
const ADMIN = "018f6f18-24d7-7c21-9b62-8c017419958b";
const now = new Date("2026-08-11T06:00:00.000Z");
const declaration = {
  sourceKey: "pip.cache", displayName: "PIP cache", ecosystem: "pip", kind: "proxy-cache",
  endpoint: { url: "http://source.internal/", networkZone: "internal" }, priority: 10,
  packageScopes: ["*"], architectures: ["arm64"], trust: { checksumRequired: true, signaturePolicy: "preferred", tlsRequired: false },
  credentialSecretKey: null, onlineMode: "auto", cache: { mode: "read-through", maximumBytes: 1, ttlSeconds: 1, retainVerified: true }, storagePoolId: null, enabled: true,
};
const row = {
  id: SOURCE, source_key: "pip.cache", ecosystem: "pip", source_kind: "proxy-cache", priority: 10,
  declaration, health: { state: "unknown", latencyMilliseconds: null, errorCode: null, observedAt: null },
  revision: "1", created_by: ADMIN, created_at: now, updated_by: ADMIN, updated_at: now,
};

test("PostgreSQL source repository persists normalized declarations and maps rows", async () => {
  const calls = [];
  const database = {
    transaction: async (operation) => operation(database),
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("INSERT INTO source_center.sources")) return { rows: [row] };
      if (sql.includes("FROM source_center.sources") && sql.includes("ORDER BY")) return { rows: [row] };
      return { rows: [] };
    },
  };
  const repository = new PostgresSourceCenterRepository({ database });
  const created = await repository.createSource({ ...declaration, sourceId: SOURCE, health: row.health, revision: 1, createdBy: ADMIN, createdAt: now });
  const listed = await repository.listSources({ ecosystem: "pip" });
  assert.equal(created.sourceId, SOURCE);
  assert.equal(created.revision, 1);
  assert.equal(listed[0].sourceKey, "pip.cache");
  const serialized = JSON.parse(calls[0].params[5]);
  assert.equal(serialized.sourceId, undefined);
  assert.equal(serialized.sourceKey, "pip.cache");
});

test("PostgreSQL health observation is transactional and append-only", async () => {
  const calls = [];
  const healthy = { ...row, revision: "2", health: { state: "healthy", latencyMilliseconds: 9, errorCode: null, observedAt: now.toISOString() } };
  const database = {
    transaction: async (operation) => operation(database),
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("UPDATE source_center.sources")) return { rows: [healthy] };
      return { rows: [] };
    },
  };
  const repository = new PostgresSourceCenterRepository({ database });
  const result = await repository.recordHealth(SOURCE, 1, healthy.health, now);
  assert.equal(result.health.state, "healthy");
  assert.ok(calls.some((call) => call.sql.includes("INSERT INTO source_center.health_events")));
});

test("PostgreSQL source updates distinguish revision conflicts from missing records", async () => {
  const database = {
    transaction: async (operation) => operation(database),
    query: async (sql) => {
      if (sql.startsWith("UPDATE")) return { rows: [] };
      if (sql.includes("WHERE id=$1")) return { rows: [row] };
      return { rows: [] };
    },
  };
  const repository = new PostgresSourceCenterRepository({ database });
  await assert.rejects(repository.updateSource(SOURCE, 99, { ...declaration, health: row.health, updatedBy: ADMIN, updatedAt: now }), { code: "source_revision_conflict" });
});
