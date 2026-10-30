import assert from "node:assert/strict";
import { test } from "node:test";

import { principalFromRoleKeys } from "../../../packages/authorization/src/index.mjs";
import { MemoryStoragePoolRepository } from "../src/memory-storage-pool-repository.mjs";
import { StoragePoolService } from "../src/storage-pool-service.mjs";

const DIGEST = "a".repeat(64);
const BLOB_KEY = "objects/storage-pool-test";

class MemoryStorageDataPlane {
  copies = new Map();
  failDeletes = new Set();
  corruptCopies = false;
  copyCalls = [];

  key(poolId, blobKey) {
    return `${poolId}\u0000${blobKey}`;
  }

  seed(poolId, blobKey, size, sha256) {
    this.copies.set(this.key(poolId, blobKey), { size, sha256 });
  }

  async copy({ sourcePoolId, targetPoolId, blobKey }) {
    this.copyCalls.push({ sourcePoolId, targetPoolId, blobKey });
    const source = this.copies.get(this.key(sourcePoolId, blobKey));
    if (!source) throw new Error("source copy missing");
    this.copies.set(this.key(targetPoolId, blobKey), {
      ...source,
      ...(this.corruptCopies ? { sha256: "0".repeat(64) } : {}),
    });
  }

  async inspect({ poolId, blobKey }) {
    return structuredClone(this.copies.get(this.key(poolId, blobKey)) ?? null);
  }

  async delete({ poolId, blobKey }) {
    const key = this.key(poolId, blobKey);
    if (this.failDeletes.has(key)) throw new Error("injected delete failure");
    this.copies.delete(key);
  }
}

function principal(roleKey = "system_admin") {
  return principalFromRoleKeys({
    id: `${roleKey}-identity`,
    status: "active",
    identityKind: "local_user",
  }, [roleKey]);
}

function fixture({
  observationMaximumAgeMs = 5 * 60 * 1000,
  healthSink = null,
} = {}) {
  let now = new Date("2026-08-10T00:00:00.000Z");
  const repository = new MemoryStoragePoolRepository();
  const dataPlane = new MemoryStorageDataPlane();
  const audit = [];
  const service = new StoragePoolService({
    repository,
    dataPlane,
    audit: async (event) => audit.push(event),
    clock: () => new Date(now),
    observationMaximumAgeMs,
    reservationLifetimeMs: 1_000,
    healthSink,
  });
  return {
    audit,
    dataPlane,
    repository,
    service,
    admin: principal(),
    owner: principal("owner"),
    member: principal("member"),
    now: () => new Date(now),
    advance(milliseconds) { now = new Date(now.getTime() + milliseconds); },
  };
}

test("storage observations are published to operational diagnostics", async () => {
  const observations = [], f = fixture({ healthSink: { async recordStoragePoolHealth(value) { observations.push(value); } } });
  await addHealthyPool(f, { poolId: "pool-health", failureDomain: "rack-a" });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].healthState, "healthy");
  assert.equal(observations[0].poolId, "pool-health");
});

test("diagnostic health sink failure cannot invalidate a committed storage observation", async () => {
  const f = fixture({ healthSink: { async recordStoragePoolHealth() { throw new Error("diagnostics unavailable"); } } });
  const result = await addHealthyPool(f, { poolId: "pool-resilient", failureDomain: "rack-a" });
  assert.equal(result.healthState, "healthy");
  assert.ok(f.audit.some((event) => event.action === "storage.health_publish_failed"));
});

async function addHealthyPool(f, {
  poolId,
  failureDomain,
  totalBytes = 1_000,
  availableBytes = totalBytes,
  backendKind = "local-block",
  nodeId = `node-${poolId}`,
  encryptionMode = backendKind === "s3-compatible" ? "provider-managed" : "luks2",
  dataClasses = ["team-file", "ai-artifact"],
  safetyReserveBytes = 0,
} = {}) {
  await f.service.registerPool({
    principal: f.admin,
    poolId,
    displayName: `Pool ${poolId}`,
    backendKind,
    nodeId: backendKind === "s3-compatible" ? null : nodeId,
    failureDomain,
    safetyReserveBytes,
    dataClasses,
  });
  return f.service.recordObservation({
    principal: f.admin,
    poolId,
    healthState: "healthy",
    totalBytes,
    availableBytes,
    encryptionMode,
    encryptionStatus: "verified",
    encryptionVerifiedAt: f.now(),
    compatibilityStatus: "verified",
    compatibilityVerifiedAt: f.now(),
    observedAt: f.now(),
  });
}

test("pool inventory is administrator-scoped and reports health, capacity, encryption, and stale eligibility", async () => {
  const f = fixture({ observationMaximumAgeMs: 1_000 });
  const registered = await f.service.registerPool({
    principal: f.admin,
    poolId: "pool-local",
    displayName: "Encrypted NVMe",
    backendKind: "local-block",
    nodeId: "node-spark-a",
    failureDomain: "spark-a",
    safetyReserveBytes: 100,
    dataClasses: ["team-file", "ai-artifact"],
  });
  assert.equal(registered.eligibility.eligible, false);
  assert.deepEqual([...registered.eligibility.reasons].sort(), [
    "compatibility_pending",
    "encryption_pending",
    "health_unknown",
    "local_pool_requires_luks2",
    "observation_missing",
  ]);

  const observed = await f.service.recordObservation({
    principal: f.admin,
    poolId: "pool-local",
    healthState: "healthy",
    totalBytes: 1_000,
    availableBytes: 900,
    encryptionMode: "luks2",
    encryptionStatus: "verified",
    encryptionVerifiedAt: f.now(),
    compatibilityStatus: "verified",
    compatibilityVerifiedAt: f.now(),
    observedAt: f.now(),
  });
  assert.equal(observed.eligibility.eligible, true);
  assert.equal(observed.capacity.availableToPlaceBytes, 800);
  assert.equal(Object.hasOwn(observed, "backup"), false);
  assert.equal((await f.service.listPools({ principal: f.owner })).length, 1);
  await assert.rejects(f.service.listPools({ principal: f.member }),
    (error) => error.code === "storage_access_denied" && error.status === 403);

  f.advance(1_001);
  const stale = await f.service.pool({ principal: f.admin, poolId: "pool-local" });
  assert.equal(stale.eligibility.eligible, false);
  assert.ok(stale.eligibility.reasons.includes("observation_stale"));
  assert.ok(f.audit.some((event) => event.action === "storage.access_denied"));
});

test("placement requires encrypted compatible capacity in distinct failure domains and verifies every copy", async () => {
  const f = fixture();
  await addHealthyPool(f, { poolId: "pool-a", failureDomain: "node-a" });
  await addHealthyPool(f, { poolId: "pool-b", failureDomain: "node-b" });
  const reservation = await f.service.reservePlacement({
    principal: f.admin,
    blobKey: BLOB_KEY,
    dataClass: "team-file",
    size: 200,
    sha256: DIGEST,
    copies: 2,
  });
  assert.equal(reservation.targets.length, 2);
  assert.notEqual(reservation.targets[0].failureDomain, reservation.targets[1].failureDomain);
  assert.deepEqual(reservation.protection, {
    kind: "availability-copies",
    copyCount: 2,
  });
  const reservedInventory = await f.service.pool({ principal: f.admin, poolId: "pool-a" });
  assert.equal(reservedInventory.capacity.reservedBytes, 200);

  await assert.rejects(f.service.commitPlacement({
    principal: f.admin,
    reservationId: reservation.reservationId,
    verifiedCopies: reservation.targets.map((target, index) => ({
      poolId: target.poolId,
      size: index === 0 ? 199 : 200,
      sha256: DIGEST,
      verifiedAt: f.now(),
    })),
  }), (error) => error.code === "storage_verification_mismatch" && error.status === 422);
  assert.equal((await f.repository.allocations()).length, 0);

  const committed = await f.service.commitPlacement({
    principal: f.admin,
    reservationId: reservation.reservationId,
    verifiedCopies: reservation.targets.map((target) => ({
      poolId: target.poolId,
      size: 200,
      sha256: DIGEST,
      verifiedAt: f.now(),
    })),
  });
  assert.equal(committed.state, "committed");
  assert.equal((await f.repository.allocations()).length, 2);
  assert.equal((await f.service.pool({ principal: f.admin, poolId: "pool-a" })).capacity.allocatedBytes, 200);
});

test("placement fails closed when requested copies cannot span distinct failure domains", async () => {
  const f = fixture();
  await addHealthyPool(f, { poolId: "pool-a", failureDomain: "rack-a" });
  await addHealthyPool(f, { poolId: "pool-b", failureDomain: "rack-a" });
  await assert.rejects(f.service.reservePlacement({
    principal: f.admin,
    blobKey: BLOB_KEY,
    dataClass: "team-file",
    size: 100,
    sha256: DIGEST,
    copies: 2,
  }), (error) => error.code === "storage_placement_unavailable"
    && error.details.eligibleFailureDomains === 1);
});

async function committedSourceFixture({ copies = 1 } = {}) {
  const f = fixture();
  await addHealthyPool(f, {
    poolId: "pool-source",
    failureDomain: "node-source",
    availableBytes: 1_000,
  });
  await addHealthyPool(f, {
    poolId: "pool-target",
    failureDomain: "node-target",
    availableBytes: 900,
  });
  const reservation = await f.service.reservePlacement({
    principal: f.admin,
    blobKey: BLOB_KEY,
    dataClass: "team-file",
    size: 100,
    sha256: DIGEST,
    copies,
  });
  for (const target of reservation.targets) f.dataPlane.seed(target.poolId, BLOB_KEY, 100, DIGEST);
  await f.service.commitPlacement({
    principal: f.admin,
    reservationId: reservation.reservationId,
    verifiedCopies: reservation.targets.map((target) => ({
      poolId: target.poolId,
      size: 100,
      sha256: DIGEST,
      verifiedAt: f.now(),
    })),
  });
  return f;
}

test("drain copies, verifies, deletes the source, and permits only a drained empty pool to be removed", async () => {
  const f = await committedSourceFixture();
  const drained = await f.service.drainPool({ principal: f.admin, poolId: "pool-source" });
  assert.equal(drained.lifecycleState, "drained");
  assert.equal(drained.migrations[0].state, "completed");
  assert.equal(f.dataPlane.copyCalls.length, 1);
  assert.equal(await f.dataPlane.inspect({ poolId: "pool-source", blobKey: BLOB_KEY }), null);
  assert.deepEqual(await f.service.removalReadiness({
    principal: f.admin,
    poolId: "pool-source",
  }), {
    poolId: "pool-source",
    removable: true,
    blockers: {
      lifecycleState: null,
      liveAllocationCount: 0,
      activeReservationCount: 0,
      incompleteMigrationCount: 0,
      uniqueCopyBlobKeys: [],
    },
  });
  const removed = await f.service.removePool({ principal: f.admin, poolId: "pool-source" });
  assert.equal(removed.lifecycleState, "removed");
});

test("failed migration verification retains the only source copy and blocks removal until a verified retry", async () => {
  const f = await committedSourceFixture();
  f.dataPlane.corruptCopies = true;
  const failed = await f.service.drainPool({ principal: f.admin, poolId: "pool-source" });
  assert.equal(failed.lifecycleState, "draining");
  assert.equal(failed.migrations[0].state, "failed");
  assert.ok(await f.dataPlane.inspect({ poolId: "pool-source", blobKey: BLOB_KEY }));
  const blocked = await f.service.removalReadiness({ principal: f.admin, poolId: "pool-source" });
  assert.equal(blocked.removable, false);
  assert.deepEqual(blocked.blockers.uniqueCopyBlobKeys, [BLOB_KEY]);
  await assert.rejects(f.service.removePool({ principal: f.admin, poolId: "pool-source" }),
    (error) => error.code === "storage_pool_not_removable"
      && error.details.uniqueCopyBlobKeys[0] === BLOB_KEY);

  f.dataPlane.corruptCopies = false;
  const retried = await f.service.drainPool({ principal: f.admin, poolId: "pool-source" });
  assert.equal(retried.lifecycleState, "drained");
  assert.equal((await f.repository.migrations({ sourcePoolId: "pool-source" }))
    .filter((migration) => migration.state === "failed").length, 0);
});

test("source deletion failure remains cleanup-pending and a later drain resumes safely", async () => {
  const f = await committedSourceFixture();
  const sourceKey = f.dataPlane.key("pool-source", BLOB_KEY);
  f.dataPlane.failDeletes.add(sourceKey);
  const first = await f.service.drainPool({ principal: f.admin, poolId: "pool-source" });
  assert.equal(first.lifecycleState, "draining");
  assert.equal(first.migrations[0].state, "cleanup_pending");
  assert.equal((await f.repository.allocations({ blobKey: BLOB_KEY })).length, 2);

  f.dataPlane.failDeletes.delete(sourceKey);
  const second = await f.service.drainPool({ principal: f.admin, poolId: "pool-source" });
  assert.equal(second.lifecycleState, "drained");
  assert.equal((await f.repository.allocations({ poolId: "pool-source" })).length, 0);
});

test("drain reuses and verifies an existing availability copy without copying bytes again", async () => {
  const f = await committedSourceFixture({ copies: 2 });
  const result = await f.service.drainPool({ principal: f.admin, poolId: "pool-source" });
  assert.equal(result.lifecycleState, "drained");
  assert.equal(f.dataPlane.copyCalls.length, 0);
  assert.equal((await f.repository.allocations({ blobKey: BLOB_KEY })).length, 1);
});

test("active reservations block drain completion and draining pools reject new placements", async () => {
  const f = fixture();
  await addHealthyPool(f, {
    poolId: "pool-source",
    failureDomain: "node-source",
    availableBytes: 1_000,
  });
  await addHealthyPool(f, {
    poolId: "pool-target",
    failureDomain: "node-target",
    availableBytes: 900,
  });
  const reservation = await f.service.reservePlacement({
    principal: f.admin,
    blobKey: BLOB_KEY,
    dataClass: "team-file",
    size: 100,
    sha256: DIGEST,
  });
  const first = await f.service.drainPool({ principal: f.admin, poolId: "pool-source" });
  assert.equal(first.lifecycleState, "draining");
  assert.equal(first.blockers.reservationCount, 1);

  const replacement = await f.service.reservePlacement({
    principal: f.admin,
    blobKey: "objects/replacement",
    dataClass: "team-file",
    size: 100,
    sha256: "b".repeat(64),
  });
  assert.deepEqual(replacement.targets.map((target) => target.poolId), ["pool-target"]);
  await f.service.abortPlacement({ principal: f.admin, reservationId: reservation.reservationId });
  const second = await f.service.drainPool({ principal: f.admin, poolId: "pool-source" });
  assert.equal(second.lifecycleState, "drained");
});
