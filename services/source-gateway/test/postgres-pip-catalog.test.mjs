import assert from "node:assert/strict";
import test from "node:test";

import { PostgresPipCatalog } from "../gateways/pip/src/postgres-pip-catalog.mjs";

const row = {
  id: "018f6f18-24d7-7c21-9b62-8c0174199501", project: "demo", package_version: "1.0.0", filename: "demo-1.0.0.whl",
  sha256: Buffer.alloc(32, 1), byte_size: "123", source_id: "018f6f18-24d7-7c21-9b62-8c0174199502", source_kind: "hosted", location_key: "pip/demo.whl",
  upstream_url: null, requires_python: ">=3.11", dependencies: [], architectures: ["all"], yanked_reason: null, core_metadata_sha256: null,
  signature_status: "not-available", scan_status: "passed", license: "MIT", cached_at: new Date("2026-08-11T07:00:00Z"), imported_at: new Date("2026-08-11T07:00:00Z"),
};

test("PostgreSQL PIP catalog maps immutable artifact metadata and cache state", async () => {
  const calls = [];
  const transaction = { query: async (sql, params) => { calls.push({ sql, params }); if (sql.includes("SELECT *") && sql.includes("FOR UPDATE")) return { rows: [] }; if (sql.includes("INSERT INTO")) return { rows: [row] }; return { rows: [] }; } };
  const database = { query: transaction.query, transaction: async (operation) => operation(transaction) };
  const catalog = new PostgresPipCatalog({ database });
  const result = await catalog.putArtifact({ artifactId: row.id, project: row.project, version: row.package_version, filename: row.filename, sha256: `sha256:${"01".repeat(32)}`, size: 123, sourceId: row.source_id, sourceKind: row.source_kind, locationKey: row.location_key, requiresPython: row.requires_python, dependencies: [], architectures: ["all"], yankedReason: null, coreMetadataSha256: null, signatureStatus: row.signature_status, scanStatus: row.scan_status, license: row.license, cachedAt: row.cached_at, importedAt: row.imported_at });
  assert.equal(result.sha256, `sha256:${"01".repeat(32)}`);
  assert.equal(result.size, 123);
  assert.ok(calls.some((call) => call.sql.includes("INSERT INTO source_center.pip_artifacts")));
});

test("PostgreSQL PIP catalog updates only cache presence for an identical artifact", async () => {
  const calls = [];
  const transaction = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [row] }; } };
  const database = { query: transaction.query, transaction: async (operation) => operation(transaction) };
  const catalog = new PostgresPipCatalog({ database });
  const value = { artifactId: row.id, project: row.project, version: row.package_version, filename: row.filename, sha256: `sha256:${"01".repeat(32)}`, size: 123, sourceId: row.source_id, sourceKind: row.source_kind, locationKey: row.location_key, upstreamUrl: null, cachedAt: row.cached_at };
  await catalog.putArtifact(value);
  assert.ok(calls.some((call) => call.sql.includes("SET cached_at=COALESCE")));
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO")), false);
});
