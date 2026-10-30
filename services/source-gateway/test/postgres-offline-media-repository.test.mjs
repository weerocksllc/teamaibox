import assert from "node:assert/strict";
import test from "node:test";

import { PostgresOfflineMediaRepository } from "../src/postgres-offline-media-repository.mjs";

test("PostgreSQL offline media repository fences approval and atomically replaces indexed inventory", async () => {
  const calls = [];
  const row = { id: "018f6f18-24d7-7c21-9b62-8c0174199501", node_id: "018f6f18-24d7-7c21-9b62-8c0174199502", device_identity_sha256: Buffer.from("1".repeat(64), "hex"),
    filesystem_uuid: "018f6f18-24d7-7c21-9b62-8c0174199503", volume_label: "OFFLINE", observed_manifest_sha256: Buffer.from("2".repeat(64), "hex"), availability: "attached",
    approval_state: "pending", lifecycle_state: "discovered", record: { mediaHandle: "media.handle", health: { state: "unknown" }, inventory: null, lastSeenAt: "2026-08-11T10:00:00Z" },
    revision: 1, created_by: "018f6f18-24d7-7c21-9b62-8c0174199504", created_at: "2026-08-11T10:00:00Z", updated_at: "2026-08-11T10:00:00Z" };
  const transaction = { async query(sql, params) { calls.push([sql, params]); if (sql.includes("SELECT *") && sql.includes("FOR UPDATE")) return { rows: [row] }; if (sql.includes("UPDATE source_center.offline_media SET approval")) return { rows: [{ ...row, approval_state: "approved", lifecycle_state: "ready", revision: 2, record: JSON.parse(params[4]) }] }; return { rows: [] }; } };
  const database = { async query() { return { rows: [] }; }, async transaction(operation) { return operation(transaction); } };
  const repository = new PostgresOfflineMediaRepository({ database });
  const approvedAt = new Date("2026-08-11T10:01:00Z");
  const result = await repository.approveIndex(row.id, 1, { artifacts: [{ ecosystem: "pip", name: "demo", version: "1", architecture: "arm64", relativePath: "pip/demo.whl", sha256: `sha256:${"a".repeat(64)}`, sizeBytes: 12, dependencies: [] }],
    media: { approvalState: "approved", lifecycleState: "ready", approvedManifestSha256: `sha256:${"2".repeat(64)}`, manifestSignerFingerprint: "A".repeat(40), inventory: { artifactCount: 1 }, approvedBy: row.created_by, approvedAt } });
  assert.equal(result.revision, 2);
  assert.ok(calls.some(([sql]) => sql.includes("DELETE FROM source_center.offline_media_artifacts")));
  assert.ok(calls.some(([sql]) => sql.includes("INSERT INTO source_center.offline_media_artifacts")));
  assert.ok(calls.some(([sql]) => sql.includes("INSERT INTO source_center.offline_media_approvals")));
});

test("PostgreSQL offline media repository stores digests as bytes and requires transactions", async () => {
  assert.throws(() => new PostgresOfflineMediaRepository({ database: { query() {} } }), /requires transactions/);
  const calls = [];
  const database = { async query(sql, params) { calls.push([sql, params]); return { rows: [] }; }, async transaction(operation) { return operation(this); } };
  const repository = new PostgresOfflineMediaRepository({ database });
  await repository.findByDeviceIdentity(`sha256:${"a".repeat(64)}`);
  assert.ok(Buffer.isBuffer(calls[0][1][0]));
  assert.equal(calls[0][1][0].length, 32);
});
