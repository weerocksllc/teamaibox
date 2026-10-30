import assert from "node:assert/strict";
import test from "node:test";

import { MemoryUnlockTransitionRepository, UnlockProtectionTransitionService } from "../src/index.mjs";

const ACTOR = "00000000-0000-4000-8000-000000000101";
const PLAN = "00000000-0000-4000-8000-000000000102";
const REQUEST = "00000000-0000-4000-8000-000000000103";
const RECOVERY_VERIFY = "00000000-0000-4000-8000-000000000104";
const SELECTED_VERIFY = "00000000-0000-4000-8000-000000000105";
const HEADER_BACKUP = "00000000-0000-4000-8000-000000000106";
const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;
const C = `sha256:${"c".repeat(64)}`;
const D = `sha256:${"d".repeat(64)}`;
const E = `sha256:${"e".repeat(64)}`;
const F = `sha256:${"f".repeat(64)}`;
const VOLUME = "11111111-2222-3333-4444-555555555555";

function fixture({ simulationPass = true, bootPolicyFailure = false, restoreFailure = false } = {}) {
  const now = new Date("2026-08-11T12:00:00Z");
  const calls = []; const audits = [];
  let currentHeader = A;
  let currentSlots = [
    { slotId: 0, role: "automatic", state: "active" },
    { slotId: 1, role: "offline_recovery", state: "active" },
    { slotId: 2, role: "web_passphrase", state: "active" },
    { slotId: 3, role: "usb_key", state: "active" },
  ];
  const evidence = (digest, extra = {}) => ({ passed: true, evidenceDigest: digest, ...extra });
  const dependencies = {
    repository: new MemoryUnlockTransitionRepository(),
    accessControl: { async authorize() { calls.push("authorize"); } },
    factorVerificationService: {
      async get(id) { calls.push(id === RECOVERY_VERIFY ? "recovery.verify" : "selected.verify"); return { verificationId: id, role: id === RECOVERY_VERIFY ? "offline_recovery" : "web_passphrase", slotId: id === RECOVERY_VERIFY ? 1 : 2, volumeUuid: VOLUME, evidenceDigest: id === RECOVERY_VERIFY ? C : D, verifiedAt: new Date(now.getTime() - 1000), expiresAt: new Date(now.getTime() + 3_600_000) }; },
      async revalidate({ verificationId }) { calls.push(verificationId === RECOVERY_VERIFY ? "recovery.revalidate" : "selected.revalidate"); return evidence(verificationId === RECOVERY_VERIFY ? C : D); },
    },
    keySlotManager: {
      async inventory() { calls.push("slots.inventory"); return { luksVersion: 2, volumeUuid: VOLUME, headerRevision: currentHeader, slots: structuredClone(currentSlots) }; },
      async createHeaderBackup() { calls.push("header.backup"); return { headerBackupId: HEADER_BACKUP, digest: F, independent: true }; },
      async disableAutomatic() { calls.push("automatic.disable"); currentHeader = E; currentSlots = currentSlots.filter((slot) => slot.role !== "automatic"); return { headerRevision: E }; },
      async writeBootPolicy({ mode }) { calls.push(`policy.${mode}`); if (bootPolicyFailure && mode !== "automatic") throw new Error("policy failed"); },
      async restoreHeaderBackup() { calls.push("header.restore"); if (restoreFailure) throw new Error("restore failed"); currentHeader = A; currentSlots = [{ slotId: 0, role: "automatic", state: "active" }, ...currentSlots]; },
    },
    drainReadiness: {
      async verify() { calls.push("drain.verify"); return evidence(E); },
      async revalidate() { calls.push("drain.revalidate"); return evidence(E); },
    },
    rebootSimulator: {
      async simulate() { calls.push("reboot.simulate"); return simulationPass ? evidence(F, { selectedUnlockSucceeded: true, recoveryUnlockSucceeded: true, automaticExcluded: true, protectedServicesHealthy: true, rollbackVerified: true }) : { passed: false }; },
      async revalidate() { calls.push("reboot.revalidate"); return evidence(F); },
    },
    audit: async (event) => audits.push(event), clock: () => now, idFactory: () => PLAN,
  };
  return { service: new UnlockProtectionTransitionService(dependencies), dependencies, calls, audits, context: { identityId: ACTOR } };
}

async function prepare(value) {
  return value.service.prepare({ context: value.context, mode: "web_passphrase", recoveryVerificationId: RECOVERY_VERIFY, selectedVerificationId: SELECTED_VERIFY, requestId: REQUEST });
}

test("retired hardware mode cannot prepare or commit an old stored plan and never changes slots", async () => {
  const value = fixture();
  await assert.rejects(value.service.prepare({ context: value.context, mode: "usb_key", recoveryVerificationId: RECOVERY_VERIFY, selectedVerificationId: SELECTED_VERIFY, requestId: REQUEST }), { code: "unlock_transition_invalid" });
  assert.deepEqual(value.calls, ["authorize"]);
  const plan = await prepare(value);
  value.dependencies.repository.get = async () => ({ ...plan, mode: "usb_key" });
  const previous = value.calls.length;
  await assert.rejects(value.service.commit({ context: value.context, planId: plan.planId, expectedRevision: 1 }), { code: "unlock_transition_mode_retired" });
  assert.deepEqual(value.calls.slice(previous), ["authorize"]);
});

test("recovery selected factor drain and reboot rollback are all proven before automatic slot removal", async () => {
  const value = fixture();
  const plan = await prepare(value);
  assert.equal(plan.state, "prepared");
  assert.equal(value.calls.includes("automatic.disable"), false);
  const enabled = await value.service.commit({ context: value.context, planId: plan.planId, expectedRevision: plan.revision });
  assert.equal(enabled.state, "enabled");
  assert.equal(enabled.headerRevisionAfter, E);
  const disable = value.calls.indexOf("automatic.disable");
  for (const prerequisite of ["recovery.revalidate", "selected.revalidate", "drain.revalidate", "reboot.revalidate", "header.backup"]) assert.ok(value.calls.indexOf(prerequisite) < disable);
  assert.equal(value.calls.includes("header.restore"), false);
  assert.deepEqual(value.audits.map((event) => event.action), ["security.unlock_protection_prepared", "security.unlock_protection_enabled"]);
  assert.equal(JSON.stringify(enabled).includes("passphrase"), true); // mode label only
  assert.doesNotMatch(JSON.stringify(enabled), /correct horse|keyBytes|rawFactor/);
  assert.deepEqual(await value.service.commit({ context: value.context, planId: plan.planId, expectedRevision: plan.revision }), enabled);
});

test("failed simulated reboot leaves automatic unlock unchanged", async () => {
  for (const options of [{ simulationPass: false }]) {
    const value = fixture(options);
    await assert.rejects(prepare(value), { code: "unlock_transition_prerequisite_failed" });
    assert.equal(value.calls.includes("automatic.disable"), false);
    assert.equal(value.calls.includes("header.backup"), false);
  }
});

test("post-disable failure restores the header and automatic boot policy", async () => {
  const value = fixture({ bootPolicyFailure: true });
  const plan = await prepare(value);
  await assert.rejects(value.service.commit({ context: value.context, planId: plan.planId, expectedRevision: 1 }), { code: "unlock_transition_rolled_back" });
  assert.ok(value.calls.indexOf("header.restore") > value.calls.indexOf("automatic.disable"));
  assert.ok(value.calls.includes("policy.automatic"));
  assert.equal(value.audits.at(-1).action, "security.unlock_protection_rolled_back");
});

test("rollback failure becomes an explicit manual recovery state", async () => {
  const value = fixture({ bootPolicyFailure: true, restoreFailure: true });
  const plan = await prepare(value);
  await assert.rejects(value.service.commit({ context: value.context, planId: plan.planId, expectedRevision: 1 }), { code: "unlock_transition_manual_recovery_required" });
  assert.equal(value.audits.at(-1).action, "security.unlock_protection_manual_recovery_required");
});

test("actor revision and idempotency fences prevent a different or changed commit", async () => {
  const value = fixture();
  const plan = await prepare(value);
  await assert.rejects(value.service.commit({ context: { identityId: "00000000-0000-4000-8000-000000000999" }, planId: plan.planId, expectedRevision: 1 }), { code: "unlock_transition_actor_mismatch" });
  await assert.rejects(value.service.commit({ context: value.context, planId: plan.planId, expectedRevision: 2 }), { code: "unlock_transition_stale" });
  const replay = await prepare(value);
  assert.equal(replay.planId, plan.planId);
});
