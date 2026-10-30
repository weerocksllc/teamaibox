import assert from "node:assert/strict";
import test from "node:test";
import { PostgresPhoneCapacity } from "../src/postgres-phone-capacity.mjs";
const node = { nodeId: "00000000-0000-4000-8000-000000000019", nodeGeneration: 1, poolId: "phone-data", maximumPhones: 2, imageDigest: `sha256:${"a".repeat(64)}` };
const row = { generation: 1, lifecycle_state: "ready", recovery_state: "healthy", appliance_role: "appliance-core", architecture: "arm64", trust_kind: "managed_appliance",
  encryption_mode: "luks2", encryption_status: "verified", compatibility_status: "verified", health_state: "healthy", pool_state: "active",
  display_name: "Office node", node_address: "192.0.2.19", running: 2, running_count: 1, starting_count: 1 };
function capacity(value) { return new PostgresPhoneCapacity({ localNodeId: node.nodeId, database: { query: async () => ({ rows: value ? [value] : [] }), transaction() {} },
  approvedNodes: [node], baselineProvider: { read() {} }, clock: () => new Date("2026-09-13T09:00:00Z") }); }
test("admin status distinguishes active phones and start operations without resource bookings", async () => {
  const [result] = await capacity(row).status();
  assert.equal(result.running, 2); assert.equal(result.runningCount, 1); assert.equal(result.startingCount, 1);
  assert.equal('reservedCount' in result,false);assert.equal('configuredLimit' in result,false);
  assert.equal(result.nodeName, "Office node"); assert.equal(result.address, null);
  assert.equal(result.observedAt, "2026-09-13T09:00:00.000Z"); assert.equal(result.reasonCode, null);
  assert.equal((await capacity(row).placement()).nodeId, node.nodeId);
});
test("the appliance core is a valid installed phone node for the single-box baseline", async () => {
  const [result] = await capacity({ ...row, appliance_role: "appliance-core", node_address: null }).status();
  assert.equal(result.reasonCode, null);
  assert.equal((await capacity({ ...row, appliance_role: "appliance-core", node_address: null }).placement()).nodeId, node.nodeId);
});
test("an unrelated managed role is not admitted as a phone node", async () => {
  const [result] = await capacity({ ...row, appliance_role: "storage-only" }).status();
  assert.equal(result.reasonCode, "phone_node_unavailable");
  await assert.rejects(capacity({ ...row, appliance_role: "storage-only" }).placement(), error =>
    error.code === "phone_storage_unavailable" && error.details?.reason === "no_managed_encrypted_node");
});
test("missing node data is unknown, not a claim of zero running phones", async () => {
  const [result] = await capacity(null).status();
  for (const key of ["runningCount", "startingCount", "nodeName", "address", "observedAt"]) assert.equal(result[key], null);
  assert.equal(result.reasonCode, "phone_node_unavailable");
  await assert.rejects(capacity(null).placement());
});
