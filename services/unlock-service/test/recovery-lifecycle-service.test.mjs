import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRecoveryLifecycleRepository, RecoveryLifecycleService } from "../src/index.mjs";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digest = `sha256:${"a".repeat(64)}`;
function fixture({ changedVolume = false, selectedValid = true } = {}) {
  const calls = [], slots = [{ slotId: 1, role: "offline_recovery", state: "active" },
    { slotId: 2, role: "web_passphrase", state: "active" }, { slotId: 3, role: "usb_key", state: "active" }];
  let inventories = 0;
  const service = new RecoveryLifecycleService({
    repository: new MemoryRecoveryLifecycleRepository(),
    recoveryAuthority: { async authorizeTicket() { return { authorized: true, operatorId: id(1) }; }, async authorizeAdministrator() {} },
    factorVerificationService: {
      async get(value) { return { role: value === id(2) ? "offline_recovery" : "web_passphrase", slotId: value === id(2) ? 1 : 2,
        volumeUuid: id(10), evidenceDigest: digest, expiresAt: new Date(value === id(2) || selectedValid ? "2030-01-01" : "2020-01-01") }; },
      async revalidate() { return { passed: true, evidenceDigest: digest }; },
    },
    keySlotManager: { async inventory() { inventories++; return { volumeUuid: changedVolume && inventories > 1 ? id(11) : id(10), headerRevision: digest, slots: structuredClone(slots) }; } },
    volumeControl: { async unlockRecovery() { calls.push("recovery-unlock"); return { passed: true, evidenceDigest: digest }; } },
    protectedServiceControl: { async startRecoveryMode(value) { assert.equal(value.schedulerEnabled, false); return { passed: true, evidenceDigest: digest }; } },
    bootPolicy: { async write(value) { calls.push(value); } }, clock: () => new Date("2026-10-25"), idFactory: () => id(5),
  });
  return { service, calls, slots };
}
async function enter(f) { await f.service.enterEmergencyRecovery({ recoveryVerificationId: id(2), requestId: id(3) }); }
const finish = { context: { identityId: id(1) }, recoveryId: id(5), selectedVerificationId: id(4) };
test("offline recovery preserves every existing slot and requires verified Web factor", async () => {
  const f = fixture(), original = structuredClone(f.slots); await enter(f);
  assert.equal((await f.service.finish(finish)).state, "READY_TO_REBOOT");
  assert.deepEqual(f.slots, original);
  assert.equal(f.calls.at(-1).mode, "web_passphrase");
  assert.equal(typeof f.service.revokeLostUsb, "undefined");
  assert.equal(typeof f.service.enrollReplacement, "undefined");
});
test("unverified Web factor and changed volume cannot write boot policy", async () => {
  for (const options of [{ changedVolume: true }, { selectedValid: false }]) {
    const f = fixture(options); await enter(f);
    await assert.rejects(f.service.finish(finish));
    assert.deepEqual(f.calls, ["recovery-unlock"]);
  }
});
