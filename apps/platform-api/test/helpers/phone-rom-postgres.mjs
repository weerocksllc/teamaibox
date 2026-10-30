import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { LEGACY_PHONE_ROM, GOOGLE_PHONE_ROM } from "../../../../services/scheduler/src/phone-rom.mjs";
import { VirtualPhoneService } from "../../src/virtual-phones/virtual-phone-service.mjs";
import { PHONE_POLICY } from "../../src/virtual-phones/contracts.mjs";

export const aospImage = "sha256:93e913dd5435577deab64a626c4cf75a40a72bedde188b240f212e913c1276ac";
export async function verifyPhoneRomMigration(db, { owner, nodeId, poolId }) {
  const migration = direction => readFile(new URL(`../../../../packages/persistence/migrations/000082_phone_rom_catalog.${direction}.sql`, import.meta.url), "utf8");
  for (const direction of ["up", "down"]) await db.transaction(async tx => tx.query(await migration(direction)));
  const ids = [randomUUID(), randomUUID()], oldImage = `sha256:${"b".repeat(64)}`;
  for (const [n, id] of ids.entries()) {
    await db.query(`INSERT INTO platform.phones(id,owner_id,name,state,generation,spec_id,base_build_id,node_id,pool_id,volume_id,storage_bytes,deleted_at)
      VALUES ($1,$2,'legacy fixture',$3,1,'cuttlefish-arm64-office-v1','16102939',$4,$5,$6,17179869184,$7)`,
    [id, owner, n ? "deleted" : "stopped", nodeId, poolId, randomUUID(), n ? new Date() : null]);
    await db.query(`INSERT INTO platform.phone_runs(id,phone_id,owner_id,generation,node_id,node_generation,reservation_id,image_digest,state,memory_bytes,cpu_millis,stopped_at)
      VALUES ($1,$2,$3,1,$4,1,$5,$6,'stopped',6442450944,2000,clock_timestamp())`, [randomUUID(), id, owner, nodeId, randomUUID(), n ? aospImage : oldImage]);
  }
  const rows = () => db.query(`SELECT to_jsonb(p)-'rom_version_id' AS value FROM platform.phones p WHERE id=ANY($1::uuid[]) ORDER BY id`, [ids]);
  const before = await rows();
  await db.transaction(async tx => tx.query(await migration("up")));
  assert.deepEqual(await rows(), before, "existing phone fields including tombstones, disk identity and revision do not change");
  const values = (await db.query(`SELECT p.id,p.rom_version_id,v.runtime_image_digest,v.create_enabled FROM platform.phones p
    JOIN platform.phone_rom_versions v ON v.id=p.rom_version_id WHERE p.id=ANY($1::uuid[])`, [ids])).rows;
  assert.equal(values.find(p => p.id === ids[0]).runtime_image_digest, oldImage);
  assert.equal(values.find(p => p.id === ids[0]).create_enabled, false);
  assert.equal(values.find(p => p.id === ids[1]).rom_version_id, LEGACY_PHONE_ROM);
  await assert.rejects(db.transaction(async tx => tx.query(await migration("down"))), /explicit data migration/);
  await assert.rejects(db.query(`UPDATE platform.phones SET rom_version_id=$2,revision=revision+1 WHERE id=$1`, [ids[0], LEGACY_PHONE_ROM]), { code: "23514" });
  await assert.rejects(db.query(`UPDATE platform.phone_rom_versions SET runtime_image_digest=$2 WHERE id=$1`, [LEGACY_PHONE_ROM, oldImage]), { code: "23514" });
  // These IDs were created only in this isolated PostgreSQL, never a product node.
  await db.query(`DELETE FROM platform.phone_runs WHERE phone_id=ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM platform.phones WHERE id=ANY($1::uuid[])`, [ids]);
}

export async function verifyPhoneRomRequests(db, repository, placement) {
  const owner = randomUUID();
  await db.query(`INSERT INTO iam.identities(id,identity_kind,login_name,normalized_login_name,display_name,password_hash)
    VALUES ($1::uuid,'local_user',$1::uuid::text,$1::uuid::text,'ROM fixture','synthetic-test-hash')`, [owner]);
  const context = { identityId: owner }, calls = [];
  const capacity = { status: async () => [], acquireRun() {}, releaseRun() {}, async placement({ rom }) {
    calls.push(rom.id);
    return { ...placement, romVersionId: rom.id, imageDigest: rom.imageDigest };
  } };
  const runtime = Object.fromEntries(["provision", "start", "stop", "deleteData", "revokeAccess"].map(key => [key, async () => {}]));
  const service = new VirtualPhoneService({ repository, capacity, runtime, directory: { authorization: async () => ({ permissions: ["phone:use"] }) }, policy: { enabled: true } });
  const create = (key, romVersionId) => service.create({ context, key, input: { name: "ROM fixture", start: false, ...(romVersionId ? { romVersionId } : {}) } });
  await assert.rejects(create("rom-unknown-1", "unknown-version"), { code: "phone_rom_unavailable" });
  await assert.rejects(create("rom-google-disabled", GOOGLE_PHONE_ROM), { code: "phone_rom_unavailable" });
  const original = await create("rom-original-1");
  const originalPhone = await repository.get(owner, original.phoneId);
  assert.equal(originalPhone.romVersionId, LEGACY_PHONE_ROM);
  assert.equal(originalPhone.rom.imageDigest, aospImage);
  assert.equal((await create("rom-original-1", LEGACY_PHONE_ROM)).id, original.id, "old and explicit AOSP request fingerprints match");
  await assert.rejects(create("rom-original-1", GOOGLE_PHONE_ROM), { code: "phone_idempotency_conflict" });
  assert.deepEqual(calls, [LEGACY_PHONE_ROM], "disabled/unknown/repeated requests do not reach placement");
  // This is a synthetic DB fixture, not permission to enable Google in production.
  await db.query(`UPDATE platform.phone_rom_versions SET create_enabled=true WHERE id=$1`, [GOOGLE_PHONE_ROM]);
  try {
    const google = await create("rom-google-1", GOOGLE_PHONE_ROM), googlePhone = await repository.get(owner, google.phoneId);
    assert.equal(googlePhone.rom.googlePlay, true); assert.equal(googlePhone.rom.experimental, true);
    assert.notEqual(originalPhone.volumeId, googlePhone.volumeId);
    assert.equal((await repository.quota(owner)).stored, 2, "ROMs share the same quota");
    const before = await repository.get(owner, original.phoneId);
    await db.query(`UPDATE platform.phone_rom_versions SET create_enabled=false WHERE id=$1`, [LEGACY_PHONE_ROM]);
    assert.equal((await create("rom-original-1")).id, original.id, "saved retry survives catalog removal");
    await assert.rejects(create("rom-removed-1"), { code: "phone_rom_unavailable" });
    await repository.completeOperation({ ownerId: owner, operationId: original.id, generation: 0, result: { storageReady: true, volumeId: before.volumeId } });
    const phone = await repository.get(owner, original.phoneId);
    const op = await repository.requestAction({ ownerId: owner, phoneId: phone.id, action: "start", input: { expectedRevision: phone.revision }, key: "rom-restart-pin", policy: PHONE_POLICY });
    await assert.rejects(repository.bindRun({ ownerId: owner, phoneId: phone.id, operationId: op.id, generation: op.generation,
      runId: randomUUID(), reservationId: randomUUID(), nodeGeneration: 1, imageDigest: googlePhone.rom.imageDigest }), { code: "phone_stale_run" });
    const run = await repository.bindRun({ ownerId: owner, phoneId: phone.id, operationId: op.id, generation: op.generation,
      runId: randomUUID(), reservationId: randomUUID(), nodeGeneration: 1, imageDigest: before.rom.imageDigest });
    assert.equal(run.imageDigest, before.rom.imageDigest, "old phone remains startable with its pinned runtime after create removal");
    assert.equal((await repository.get(owner, phone.id)).volumeId, before.volumeId);
    assert.equal(JSON.stringify(await service.get({ context, phoneId: phone.id })).includes("sha256:"), false, "member projection omits runtime internals");
    await db.query(`DELETE FROM platform.phone_runs WHERE owner_id=$1`, [owner]);
    await db.query(`DELETE FROM platform.phone_operations WHERE owner_id=$1`, [owner]);
    await db.query(`DELETE FROM platform.phones WHERE owner_id=$1`, [owner]);
  } finally {
    await db.query(`UPDATE platform.phone_rom_versions SET create_enabled=(id=$1) WHERE id=ANY($2::text[])`, [LEGACY_PHONE_ROM, [LEGACY_PHONE_ROM, GOOGLE_PHONE_ROM]]);
  }
}
