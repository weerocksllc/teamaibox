import assert from "node:assert/strict";
import test from "node:test";

import { StorageAdministrationHttpApi } from "../src/storage/storage-administration-http-api.mjs";
import { StorageAdministrationService } from "../src/storage/storage-administration-service.mjs";

const OWNER = "018f0000-0000-7000-8000-000000000001";
const NODE = "018f0000-0000-7000-8000-000000000020";
const NOW = new Date("2026-08-21T08:00:00.000Z");
const context = { identityId: OWNER, permissions: ["storage:view", "storage:manage"] };

function pool(overrides = {}) {
  return Object.freeze({ poolId: "local.primary", displayName: "Primary data", backendKind: "local-filesystem", nodeId: NODE,
    failureDomain: "appliance.primary", lifecycleState: "active", healthState: "healthy", totalBytes: 1000, availableBytes: 700,
    safetyReserveBytes: 100, encryptionMode: "luks2", encryptionStatus: "verified", compatibilityStatus: "verified",
    dataClasses: ["team-file", "ai-artifact"], allocationCount: 2, allocatedBytes: 300, liveReservationCount: 0,
    liveReservationBytes: 0, incompleteMigrationCount: 0, observedAt: NOW.toISOString(), createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(), removedAt: null, ...overrides });
}

function fixture(initial = [pool()]) {
  let pools = initial, revision = 0;
  const audits = [];
  const repository = {
    async list() { return pools; },
    async find(poolId) { return pools.find((item) => item.poolId === poolId) ?? null; },
    async create(input) { const created = pool({ ...input, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), observedAt: NOW.toISOString() }); pools = [...pools, created]; return created; },
    async replaceDataClasses({ poolId, expectedUpdatedAt, dataClasses }) {
      const current = pools.find((item) => item.poolId === poolId); if (!current || current.updatedAt !== expectedUpdatedAt) return null;
      revision += 1; const updated = pool({ ...current, dataClasses, updatedAt: new Date(NOW.getTime() + revision).toISOString() });
      pools = pools.map((item) => item.poolId === poolId ? updated : item); return updated;
    },
    async transition({ poolId, expectedUpdatedAt, fromState, toState }) {
      const current = pools.find((item) => item.poolId === poolId); if (!current || current.updatedAt !== expectedUpdatedAt || current.lifecycleState !== fromState) return null;
      revision += 1; const updated = pool({ ...current, lifecycleState: toState, updatedAt: new Date(NOW.getTime() + revision).toISOString(), removedAt: toState === "removed" ? new Date(NOW.getTime() + revision).toISOString() : null });
      pools = pools.map((item) => item.poolId === poolId ? updated : item); return updated;
    },
  };
  return { service: new StorageAdministrationService({ repository, audit: async (event) => audits.push(event), clock: () => NOW }), audits,
    get pools() { return pools; } };
}

test("storage overview exposes capacity and blockers only to authorized administrators", async () => {
  const value = fixture();
  const result = await value.service.overview({ context });
  assert.deepEqual(result.summary, { poolCount: 1, activePoolCount: 1, degradedPoolCount: 0, totalBytes: 1000, availableBytes: 700, allocatedBytes: 300 });
  assert.equal(result.pools[0].allocationCount, 2);
  await assert.rejects(value.service.overview({ context: { identityId: OWNER, permissions: [] } }), (error) => error.code === "storage_permission_required" && error.status === 403);
});

test("verified encrypted pool registration is durable, confirmed, and audited", async () => {
  const value = fixture([]);
  await assert.rejects(value.service.create({ context, input: { poolId: "remote.archive", displayName: "Archive", backendKind: "s3-compatible", nodeId: null,
    failureDomain: "rack.archive", totalBytes: 1000, availableBytes: 900, safetyReserveBytes: 50, encryptionMode: "provider-managed",
    dataClasses: ["model-artifact"], verificationConfirmation: "VERIFIED" } }), (error) => error.code === "storage_verification_required");
  const created = await value.service.create({ context, input: { poolId: "remote.archive", displayName: "Archive", backendKind: "s3-compatible", nodeId: null,
    failureDomain: "rack.archive", totalBytes: 1000, availableBytes: 900, safetyReserveBytes: 50, encryptionMode: "provider-managed",
    dataClasses: ["model-artifact"], verificationConfirmation: "VERIFIED remote.archive" } });
  assert.equal(created.poolId, "remote.archive");
  assert.equal(value.audits[0].action, "storage.pool_registered");
});

test("data classes and lifecycle use optimistic revision, exact confirmation, and audit", async () => {
  const value = fixture([pool({ allocationCount: 0, allocatedBytes: 0 })]);
  let current = await value.service.replaceDataClasses({ context, poolId: "local.primary", expectedUpdatedAt: NOW.toISOString(), values: ["team-file", "cache"] });
  assert.deepEqual(current.dataClasses, ["cache", "team-file"]);
  await assert.rejects(value.service.transition({ context, poolId: "local.primary", action: "drain", expectedUpdatedAt: current.updatedAt, confirmation: "DRAIN" }), (error) => error.code === "storage_confirmation_required");
  current = await value.service.transition({ context, poolId: "local.primary", action: "drain", expectedUpdatedAt: current.updatedAt, confirmation: "DRAIN local.primary" });
  current = await value.service.transition({ context, poolId: "local.primary", action: "complete", expectedUpdatedAt: current.updatedAt, confirmation: "DRAINED local.primary" });
  current = await value.service.transition({ context, poolId: "local.primary", action: "remove", expectedUpdatedAt: current.updatedAt, confirmation: "REMOVE local.primary" });
  assert.equal(current.lifecycleState, "removed");
  assert.deepEqual(value.audits.map((item) => item.action), ["storage.pool_data_classes_replaced", "storage.pool_drain_started", "storage.pool_drained", "storage.pool_removed"]);
});

test("a synchronously completed data-plane drain records both lifecycle audit events", async () => {
  const current = pool({ allocationCount: 1, allocatedBytes: 300 });
  const drained = pool({ ...current, lifecycleState: "drained", allocationCount: 0, allocatedBytes: 0,
    updatedAt: new Date(NOW.getTime() + 1).toISOString() });
  const audits = [];
  const repository = {
    async list() { return [current]; },
    async find() { return current; },
    async create() { throw new Error("not used"); },
    async replaceDataClasses() { throw new Error("not used"); },
    async transition(input) {
      assert.equal(input.action, "drain");
      return drained;
    },
  };
  const service = new StorageAdministrationService({ repository, audit: async (event) => audits.push(event), clock: () => NOW });
  const result = await service.transition({ context, poolId: "local.primary", action: "drain",
    expectedUpdatedAt: current.updatedAt, confirmation: "DRAIN local.primary" });
  assert.equal(result.lifecycleState, "drained");
  assert.deepEqual(audits.map((item) => item.action), ["storage.pool_drain_started", "storage.pool_drained"]);
  assert.deepEqual(audits.map((item) => [item.fromState, item.toState]), [["active", "draining"], ["draining", "drained"]]);
});

test("storage HTTP adapter exposes only the bounded administrator surface", async () => {
  const value = fixture(); const api = new StorageAdministrationHttpApi({ service: value.service });
  assert.equal(api.matches("GET", "/api/v1/admin/storage"), true);
  assert.equal(api.matches("GET", "/api/v1/admin/storage/pools"), true);
  assert.equal(api.matches("POST", "/api/v1/admin/storage/pools"), true);
  assert.equal(api.matches("PUT", "/api/v1/admin/storage/pools/local.primary/data-classes"), true);
  assert.equal(api.matches("POST", "/api/v1/admin/storage/pools/local.primary/drain"), true);
  assert.equal(api.matches("DELETE", "/api/v1/admin/storage/pools/local.primary"), false);
  const response = await api.handle({ method: "GET", pathname: "/api/v1/admin/storage", context });
  assert.equal(response.status, 200);
});
