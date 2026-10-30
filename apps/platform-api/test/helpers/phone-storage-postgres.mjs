import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ManagedPhoneStorageRepository } from "../../src/storage/managed-phone-storage-repository.mjs";
import { StorageAdministrationService } from "../../src/storage/storage-administration-service.mjs";
import { PostgresStorageAdministrationRepository } from "../../src/storage/postgres-storage-administration-repository.mjs";
import { PostgresPhoneCapacity } from "../../../../services/scheduler/src/postgres-phone-capacity.mjs";
import { PostgresPhoneRepository } from "../../src/virtual-phones/postgres-phone-repository.mjs";
import { PHONE_POLICY } from "../../src/virtual-phones/contracts.mjs";

// This helper runs only within the suite's isolated, owned tmpfs PostgreSQL.
// Node observations below are explicit fixtures, not evidence of a real disk.
export async function verifyPhoneStorageRegistration(database) {
  const owner = randomUUID();
  await database.query(`INSERT INTO iam.identities(id,identity_kind,login_name,normalized_login_name,display_name,password_hash)
    VALUES ($1,'local_user',$2,$2,'storage registration fixture','synthetic-test-hash')`, [owner, "storage-test-" + owner]);
  const migration = direction => readFile(new URL(`../../../../packages/persistence/migrations/000081_phone_storage_class.${direction}.sql`, import.meta.url), "utf8");
  for (const direction of ["up", "down", "up"]) await database.transaction(async db => db.query(await migration(direction)));
  const nodeId = randomUUID(), poolId = "phone-registration-" + randomUUID();
  await database.query(`INSERT INTO compute.nodes(id,node_key,architecture,trust_kind,lifecycle_state,generation,appliance_role,recovery_state)
    VALUES ($1,$2,'aarch64','managed_appliance','ready',2,'appliance-core','healthy')`, [nodeId, "test-" + nodeId]);
  const approved = { nodeId, nodeGeneration: 1, poolId, imageDigest: "sha256:" + "a".repeat(64), maximumPhones: 2 };
  let wrong = {}, generationRace = false, reads = 0;
  const observation = () => ({ nodeId, nodeGeneration: 2, poolId, luksUUID: randomUUID(), filesystemUUID: randomUUID(),
    totalBytes: 64 * 2 ** 30, availableBytes: 60 * 2 ** 30, quotaBytes: 16 * 2 ** 30, reserveBytes: 8 * 2 ** 30,
    observedAt: new Date().toISOString(), ...wrong });
  const nodeAgentRouter = { async resolvePhoneNode(input) {
    assert.equal(input.nodeId,nodeId);assert.equal(input.minimumGeneration,1);
    return {nodeId,nodeGeneration:Number((await database.query('SELECT generation FROM compute.nodes WHERE id=$1',[nodeId])).rows[0].generation)};
  }, async readPhoneStorage(input) {
    assert.equal(input.nodeId, nodeId); assert.equal(input.nodeGeneration, 2); reads++;
    if (generationRace) await database.query("UPDATE compute.nodes SET generation=3 WHERE id=$1", [nodeId]);
    return observation();
  } };
  const postgres = new PostgresStorageAdministrationRepository({ database });
  let unrelatedCreates = 0;
  const repository = new ManagedPhoneStorageRepository({ localNodeId: nodeId, database, nodeAgentRouter, approvedNodes: [approved],
    repository: { bindContext() { return {
      list: () => postgres.list(), find: id => postgres.find(id),
      create: async input => { unrelatedCreates++; return postgres.create(input); },
      replaceDataClasses: input => postgres.replaceDataClasses(input), transition: input => postgres.transition(input),
    }; } } });
  const events = [], service = new StorageAdministrationService({ repository, audit: async e => events.push(e) });
  const context = { identityId: owner, permissions: ["storage:view", "storage:manage"] };
  const input = { ...approved, displayName: "Test phone pool", backendKind: "local-block", encryptionMode: "luks2",
    failureDomain: "test.phone", dataClasses: ["phone-data"], safetyReserveBytes: 8 * 2 ** 30,
    totalBytes: 1024 * 2 ** 30, availableBytes: 1024 * 2 ** 30, verificationConfirmation: `VERIFIED ${poolId}` };
  await assert.rejects(service.create({ context: { ...context, permissions: ["phone:use"] }, input }), { code: "storage_permission_required" });
  assert.equal(reads, 0);
  for (wrong of [{ nodeGeneration: 1 }, { poolId: "foreign.pool" }, { observedAt: new Date(Date.now()-11_000).toISOString() },
    { totalBytes: 0 }, { root: "/host/arbitrary" }]) {
    await assert.rejects(service.create({ context, input }), { code: "phone_storage_unavailable" });
    assert.equal(await postgres.find(poolId), null);
  }
  wrong = {}; generationRace = true;
  await assert.rejects(service.create({ context, input }), { code: "phone_storage_unavailable" });
  assert.equal(await postgres.find(poolId), null);
  generationRace = false;
  await database.query("UPDATE compute.nodes SET generation=2 WHERE id=$1", [nodeId]);
  const created = await service.create({ context, input });
  assert.equal(created.totalBytes, 64 * 2 ** 30, "never store caller-claimed verified capacity");
  assert.equal(created.availableBytes, 60 * 2 ** 30); assert.equal(unrelatedCreates, 0);
  assert.deepEqual(created.dataClasses, ["phone-data"]);
  assert.equal(events.filter(e => e.action === "storage.pool_registered").length, 1);
  await assert.rejects(service.create({ context, input }), { code: "storage_pool_exists" });
  await assert.rejects(service.replaceDataClasses({ context, poolId, expectedUpdatedAt: created.updatedAt, values: ["team-file"] }), { code: "phone_storage_unavailable" });
  await assert.rejects(database.query("INSERT INTO objects.storage_pool_data_classes(pool_id,data_class) VALUES ($1,'plugin-data')", [poolId]), { code: "23514" });
  await assert.rejects(database.transaction(async db => db.query(await migration("down"))), { code: "23514" });
  assert.deepEqual((await postgres.find(poolId)).dataClasses, ["phone-data"], "failed rollback preserves classification");
  const capacity = new PostgresPhoneCapacity({ database, localNodeId: nodeId, approvedNodes: [approved], baselineProvider: { read() { assert.fail("must not start a guest"); } },
    storageProvider: { read: i => nodeAgentRouter.readPhoneStorage(i) } });
  assert.equal((await capacity.status())[0].reasonCode, null);
  wrong = { observedAt: new Date(Date.now()-11_000).toISOString() };
  assert.equal((await capacity.status())[0].reasonCode, "phone_storage_unavailable");
  await assert.rejects(capacity.placement(), { code: "phone_storage_unavailable" });
  wrong = {};
  const placement = await capacity.placement(), phones = new PostgresPhoneRepository({ database });
  const op = await phones.requestCreate({ ownerId: owner, input: { name: "storage-only-test", start: false }, key: "storage-register-test",
    placement, policy: { ...PHONE_POLICY, storedPerUser: 20 } });
  assert.ok(op.phoneId);
  await assert.rejects(database.query("DELETE FROM objects.storage_pool_data_classes WHERE pool_id=$1", [poolId]), { code: "23514" });
  await assert.rejects(database.query("UPDATE objects.storage_pools SET lifecycle_state='drained' WHERE pool_id=$1", [poolId]), { code: "23514" });
  assert.equal((await phones.get(owner, op.phoneId)).state, "creating", "no real Android execution in this DB test");
  const initial = await phones.get(owner, op.phoneId);
  await phones.completeOperation({ ownerId: owner, operationId: op.id, generation: op.generation,
    result: { storageReady: true, volumeId: initial.volumeId } });
  const stopped = await phones.get(owner, op.phoneId);
  const removal = await phones.requestAction({ ownerId: owner, phoneId: op.phoneId, action: "delete", key: "storage-test-delete",
    input: { expectedRevision: stopped.revision, confirmDelete: true } });
  await phones.completeOperation({ ownerId: owner, operationId: removal.id, generation: removal.generation,
    result: { runtimeStopped: true, dataDeleted: true, volumeId: stopped.volumeId } });
  await database.query("UPDATE objects.storage_pools SET lifecycle_state='draining' WHERE pool_id=$1", [poolId]);
  await database.query("UPDATE objects.storage_pools SET lifecycle_state='drained' WHERE pool_id=$1", [poolId]);
  assert.equal((await postgres.find(poolId)).lifecycleState, "drained", "deleted phone tombstones do not block retirement");
}
