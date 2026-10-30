import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { phoneApprovedNodes } from "../../../services/scheduler/src/phone-approved-nodes.mjs";
import { installedPhoneRom, LEGACY_PHONE_ROM, GOOGLE_PHONE_ROM } from "../../../services/scheduler/src/phone-rom.mjs";
import { validateCreate, requestFingerprint, PHONE_SPEC } from "../src/virtual-phones/contracts.mjs";
import { ManagedNodePhoneRuntime } from "../src/virtual-phones/managed-node-phone-runtime.mjs";
import { PostgresPhoneCapacity } from "../../../services/scheduler/src/postgres-phone-capacity.mjs";
import { PostgresPhoneRepository } from "../src/virtual-phones/postgres-phone-repository.mjs";

const aosp = `sha256:${"a".repeat(64)}`, google = `sha256:${"b".repeat(64)}`;
const node = { nodeId: randomUUID(), nodeGeneration: 1, poolId: "phone-test", imageDigest: aosp, maximumPhones: 2 };
const roms = [{ romVersionId: LEGACY_PHONE_ROM, imageDigest: aosp }, { romVersionId: GOOGLE_PHONE_ROM, imageDigest: google }];
test("migration-only AOSP wrappers are omitted from create choices, not phone lookup", async () => {
  const calls=[];
  const repository=new PostgresPhoneRepository({ database: { transaction() {}, async query(sql, parameters) {
    calls.push({sql,parameters});
    return {rows:sql.includes("WHERE id=$1") ? [{id:parameters[0],family_id:"aosp",create_enabled:false}] : []};
  } } });
  await repository.romCatalog();
  assert.match(calls[0].sql,/WHERE id NOT LIKE 'aosp-17-runtime-%'/);
  const old=`aosp-17-runtime-${"b".repeat(64)}`;
  assert.equal((await repository.getRom(old)).id,old);
  assert.deepEqual(calls[1].parameters,[old]);
});
test("ROM choice is normalized, closed and part of request idempotency", () => {
  const original = validateCreate({ name: "Phone" });
  assert.equal(requestFingerprint(original), requestFingerprint(validateCreate({ name: "Phone", romVersionId: LEGACY_PHONE_ROM })));
  assert.notEqual(requestFingerprint(original), requestFingerprint(validateCreate({ name: "Phone", romVersionId: GOOGLE_PHONE_ROM })));
  for (const input of [{ romVersionId: "../system" }, { romVersionId: null }, { romVersionId: [] },
    { imageDigest: google }, { romVersionId: GOOGLE_PHONE_ROM, image: "override" }, { romVersionId: "x".repeat(129) }]) {
    assert.throws(() => validateCreate({ name: "Phone", ...input }), { code: "phone_input_invalid" });
  }
});
test("installed mappings are bounded, immutable and cannot substitute a ROM image", () => {
  const installed = phoneApprovedNodes([{ ...node, roms }]).get(node.nodeId);
  assert.equal(installedPhoneRom(installed, GOOGLE_PHONE_ROM, google).imageDigest, google);
  assert.equal(installedPhoneRom(installed, GOOGLE_PHONE_ROM, aosp), null);
  assert.equal(installedPhoneRom(node, GOOGLE_PHONE_ROM), null);
  assert.equal(installedPhoneRom(node).romVersionId, LEGACY_PHONE_ROM);
  assert.throws(() => { installed.roms[0].imageDigest = google; }, TypeError);
  for (const mappings of [[], [...roms, roms[0]], [{ ...roms[0], mounts: [] }], [{ ...roms[0], imageDigest: "tag:latest" }]]) {
    assert.throws(() => phoneApprovedNodes([{ ...node, roms: mappings }]), TypeError);
  }
});
test("runtime and media lifecycle remain pinned when node default changes", async () => {
  const calls = [];
  const runtime = new ManagedNodePhoneRuntime({ approvedNodes: [{ ...node, imageDigest: google, roms }],
    accessRevoker: { async revokePhoneAccess(value) { return { ...value, accessRevoked: true }; } },
    nodeAgentRouter: { resolvePhoneNode: async () => ({ nodeGeneration: 1 }), async executePhoneCommand({ action, payload }) {
      calls.push(payload);
      const { run, ...identity } = payload;
      return { ...identity, runId: run?.id, containerId: "c".repeat(64), storageReady: true,
        androidReady: true, mediaReady: true, runtimeStopped: false, cleanShutdown: false, dataDeleted: false };
    } } });
  const phone = { id: randomUUID(), ownerId: randomUUID(), volumeId: randomUUID(), nodeId: node.nodeId, poolId: node.poolId,
    baseBuildId: PHONE_SPEC.buildId, specId: PHONE_SPEC.id, storageBytes: PHONE_SPEC.storageBytes, generation: 1,
    romVersionId: LEGACY_PHONE_ROM, rom: { imageDigest: aosp } };
  const run = { id: randomUUID(), phoneId: phone.id, ownerId: phone.ownerId, nodeId: phone.nodeId, nodeGeneration: 1,
    generation: 1, reservationId: randomUUID(), imageDigest: aosp, memoryBytes: PHONE_SPEC.memoryBytes, cpuMillis: PHONE_SPEC.cpuMillis };
  await runtime.start({ phone, run, operationId: randomUUID() });
  assert.equal(calls[0].run.imageDigest, aosp);
  await assert.rejects(runtime.start({ phone, run: { ...run, imageDigest: google }, operationId: randomUUID() }), { code: "phone_stale_run" });
  await assert.rejects(runtime.start({ phone: { ...phone, romVersionId: GOOGLE_PHONE_ROM }, run, operationId: randomUUID() }), { code: "phone_rom_not_installed" });
  assert.equal(calls.length, 1);
});
test("placement rejects undeployed versions without using a different node image", async () => {
  const capacity = new PostgresPhoneCapacity({ localNodeId: node.nodeId, approvedNodes: [node], database: { transaction() {}, async query() {
    return { rows: [{ lifecycle_state: "ready", recovery_state: "healthy", appliance_role: "appliance-core", trust_kind: "managed_appliance",
      architecture: "aarch64", generation: 1, encryption_mode: "luks2", encryption_status: "verified", compatibility_status: "verified", health_state: "healthy", pool_state: "active" }] };
  } }, baselineProvider: { read() {} } });
  await assert.rejects(capacity.placement({ rom: { id: GOOGLE_PHONE_ROM, imageDigest: google } }), { code: "phone_rom_not_installed" });
  assert.equal((await capacity.placement({ rom: { id: LEGACY_PHONE_ROM, imageDigest: aosp } })).imageDigest, aosp);
});
