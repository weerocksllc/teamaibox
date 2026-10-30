import assert from "node:assert/strict";
import test from "node:test";

import { PostgresClusterMetricRepository } from "../src/postgres-cluster-metric-repository.mjs";

const NODE = "018f6f18-24d7-7c21-9b62-8c0174199502";
const DIGEST = `sha256:${"a".repeat(64)}`;

function row(overrides = {}) { return { node_id: NODE, node_generation: 2, sequence: "7", observed_at: "2026-08-11T08:00:00Z", received_at: "2026-08-11T08:00:01Z", stale_after_milliseconds: 30_000, snapshot_digest: Buffer.from("a".repeat(64), "hex"), snapshot: { schemaVersion: 1 }, ...overrides }; }

test("PostgreSQL metric recording is immutable and sequence scoped", async () => {
  const calls = [];
  const transaction = { async query(sql, params) { calls.push([sql, params]); if (sql.includes("ORDER BY sequence")) return { rows: [] }; if (sql.includes("AND sequence=$3 FOR SHARE")) return { rows: [row()] }; return { rows: [] }; } };
  const repository = new PostgresClusterMetricRepository({ database: { async query() { return { rows: [] }; }, async transaction(operation) { return operation(transaction); } } });
  const saved = await repository.record({ nodeId: NODE, nodeGeneration: 2, sequence: 7, observedAt: new Date("2026-08-11T08:00:00Z"), receivedAt: new Date("2026-08-11T08:00:01Z"), staleAfterMilliseconds: 30_000, snapshotDigest: DIGEST, snapshot: { schemaVersion: 1 } });
  assert.equal(saved.snapshotDigest, DIGEST);
  assert.equal(saved.sequence, 7);
  assert.match(calls[1][0], /ON CONFLICT .* DO NOTHING/);
  assert.ok(Buffer.isBuffer(calls[1][1][6]));
});

test("PostgreSQL latest queries retain node generation ordering", async () => {
  const calls = [], repository = new PostgresClusterMetricRepository({ database: { async query(sql) { calls.push(sql); return { rows: [row()] }; }, async transaction() {} } });
  assert.equal((await repository.latestForNode(NODE)).nodeGeneration, 2);
  assert.equal((await repository.listLatest())[0].sequence, 7);
  assert.match(calls[0], /node_generation DESC,sequence DESC/);
  assert.match(calls[1], /WITH RECURSIVE node_keys/);
  assert.match(calls[1], /node_id > previous.node_id ORDER BY node_id LIMIT 1/);
  assert.match(calls[1], /WHERE node_id=target.node_id\s+ORDER BY node_generation DESC,sequence DESC LIMIT 1/);
  assert.doesNotMatch(calls[1], /SELECT DISTINCT/);
});

test("PostgreSQL metric repository requires transactional storage", () => {
  assert.throws(() => new PostgresClusterMetricRepository({ database: { query() {} } }), /query and transaction/);
});
