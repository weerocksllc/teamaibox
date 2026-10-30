import { randomUUID } from "node:crypto";
import { UnlockError } from "./index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const VOLUME = /^[a-f0-9-]{8,128}$/i;
const MODES = new Set(["web_passphrase"]);
const ROLES = new Set(["automatic", "offline_recovery", "web_passphrase", "usb_key"]);
function fail(code, message, status = 400) { throw new UnlockError(code, message, { status }); }
function verified(value, name) { if (!value || value.passed !== true || !SHA256.test(value.evidenceDigest ?? "")) fail("unlock_transition_prerequisite_failed", `${name} verification failed`, 409); return value; }
function slot(inventory, role) {
  const matches = inventory.slots.filter((item) => item.role === role && item.state === "active");
  if (matches.length !== 1 || !Number.isInteger(matches[0].slotId) || matches[0].slotId < 0 || matches[0].slotId > 31) fail("unlock_transition_slot_invalid", `Exact ${role} slot is unavailable`, 409);
  return matches[0];
}
function inventory(value) {
  if (!value || value.luksVersion !== 2 || !VOLUME.test(value.volumeUuid ?? "") || !SHA256.test(value.headerRevision ?? "") || !Array.isArray(value.slots) || value.slots.some((item) => !ROLES.has(item.role) || !new Set(["active", "inactive"]).has(item.state))) fail("unlock_transition_inventory_invalid", "LUKS2 slot inventory is invalid", 409);
  return value;
}
function ticket(value, { role, slotId, volumeUuid, now }) {
  if (!value || !UUID.test(value.verificationId ?? "") || value.role !== role || value.slotId !== slotId || value.volumeUuid !== volumeUuid || !SHA256.test(value.evidenceDigest ?? "") || !(value.verifiedAt instanceof Date) || !(value.expiresAt instanceof Date) || value.verifiedAt > now || value.expiresAt <= now) fail("unlock_transition_factor_unverified", `${role} factor verification is missing or expired`, 409);
  return value;
}

export class UnlockProtectionTransitionService {
  #repository; #access; #verification; #slots; #drain; #simulation; #audit; #clock; #id;
  constructor({ repository, accessControl, factorVerificationService, keySlotManager, drainReadiness, rebootSimulator, audit = async () => {}, clock = () => new Date(), idFactory = randomUUID }) {
    if (!repository?.createPrepared || !repository?.get || !repository?.beginCommit || !repository?.complete || !repository?.finishFailure || !accessControl?.authorize || !factorVerificationService?.get || !factorVerificationService?.revalidate || !keySlotManager?.inventory || !keySlotManager?.createHeaderBackup || !keySlotManager?.disableAutomatic || !keySlotManager?.writeBootPolicy || !keySlotManager?.restoreHeaderBackup || !drainReadiness?.verify || !drainReadiness?.revalidate || !rebootSimulator?.simulate || !rebootSimulator?.revalidate || typeof audit !== "function") throw new TypeError("unlock protection transition dependencies are incomplete");
    this.#repository = repository; this.#access = accessControl;
    this.#verification = factorVerificationService; this.#slots = keySlotManager;
    this.#drain = drainReadiness; this.#simulation = rebootSimulator; this.#audit = audit;
    this.#clock = clock; this.#id = idFactory;
  }
  async #authorize(context) { await this.#access.authorize({ context, action: "unlock_protection:manage" }); if (!UUID.test(context?.identityId ?? "")) fail("unlock_transition_actor_invalid", "Administrator identity is invalid", 403); }

  async prepare({ context, mode, recoveryVerificationId, selectedVerificationId, requestId }) {
    await this.#authorize(context);
    if (!MODES.has(mode) || !UUID.test(recoveryVerificationId ?? "") || !UUID.test(selectedVerificationId ?? "") || !UUID.test(requestId ?? "")) fail("unlock_transition_invalid", "Unlock protection plan is invalid");
    const now = this.#clock();
    const current = inventory(await this.#slots.inventory());
    const automatic = slot(current, "automatic");
    const recovery = slot(current, "offline_recovery");
    const selected = slot(current, mode);
    if (new Set([automatic.slotId, recovery.slotId, selected.slotId]).size !== 3) fail("unlock_transition_slot_invalid", "Unlock roles must use distinct LUKS2 slots", 409);
    const recoveryProof = ticket(await this.#verification.get(recoveryVerificationId), { role: "offline_recovery", slotId: recovery.slotId, volumeUuid: current.volumeUuid, now });
    const selectedProof = ticket(await this.#verification.get(selectedVerificationId), { role: mode, slotId: selected.slotId, volumeUuid: current.volumeUuid, now });
    const drain = verified(await this.#drain.verify({ volumeUuid: current.volumeUuid }), "protected service drain readiness");
    const simulation = verified(await this.#simulation.simulate({ volumeUuid: current.volumeUuid, headerRevision: current.headerRevision, selectedSlotId: selected.slotId, selectedRole: mode, recoverySlotId: recovery.slotId }), "simulated protected reboot");
    if (simulation.selectedUnlockSucceeded !== true || simulation.recoveryUnlockSucceeded !== true || simulation.automaticExcluded !== true || simulation.protectedServicesHealthy !== true || simulation.rollbackVerified !== true) fail("unlock_transition_prerequisite_failed", "Simulated reboot and rollback are incomplete", 409);
    const prepared = await this.#repository.createPrepared({
      planId: this.#id(), requestId, actorIdentityId: context.identityId.toLowerCase(), mode,
      volumeUuid: current.volumeUuid, headerRevisionBefore: current.headerRevision,
      automaticSlotId: automatic.slotId, recoverySlotId: recovery.slotId, selectedSlotId: selected.slotId,
      recoveryVerificationId, recoveryEvidenceDigest: recoveryProof.evidenceDigest,
      selectedVerificationId, selectedEvidenceDigest: selectedProof.evidenceDigest,
      drainEvidenceDigest: drain.evidenceDigest, simulationEvidenceDigest: simulation.evidenceDigest,
      state: "prepared", revision: 1, preparedAt: now, expiresAt: new Date(now.getTime() + 60 * 60_000),
    });
    await this.#audit({ action: "security.unlock_protection_prepared", actorIdentityId: context.identityId, planId: prepared.planId, mode, evidenceDigests: [recoveryProof.evidenceDigest, selectedProof.evidenceDigest, drain.evidenceDigest, simulation.evidenceDigest] });
    return prepared;
  }

  async commit({ context, planId, expectedRevision }) {
    await this.#authorize(context);
    if (!UUID.test(planId ?? "") || !Number.isInteger(expectedRevision) || expectedRevision < 1) fail("unlock_transition_invalid", "Unlock protection commit is invalid");
    const existing = await this.#repository.get(planId.toLowerCase());
    if (!existing) fail("unlock_transition_not_found", "Unlock protection plan was not found", 404);
    if (existing.actorIdentityId !== context.identityId.toLowerCase()) fail("unlock_transition_actor_mismatch", "Only the preparing administrator can commit this plan", 403);
    if (!MODES.has(existing.mode)) fail("unlock_transition_mode_retired", "This unlock mode is retired; existing slots were preserved", 409);
    if (existing.state === "enabled") return existing;
    if (existing.state !== "prepared" || existing.revision !== expectedRevision || existing.expiresAt <= this.#clock()) fail("unlock_transition_stale", "Unlock protection plan is stale", 409);
    verified(await this.#verification.revalidate({ verificationId: existing.recoveryVerificationId, evidenceDigest: existing.recoveryEvidenceDigest }), "recovery factor");
    verified(await this.#verification.revalidate({ verificationId: existing.selectedVerificationId, evidenceDigest: existing.selectedEvidenceDigest }), "selected factor");
    verified(await this.#drain.revalidate({ evidenceDigest: existing.drainEvidenceDigest }), "drain readiness");
    verified(await this.#simulation.revalidate({ evidenceDigest: existing.simulationEvidenceDigest }), "simulated reboot");
    const before = inventory(await this.#slots.inventory());
    if (before.volumeUuid !== existing.volumeUuid || before.headerRevision !== existing.headerRevisionBefore || slot(before, "automatic").slotId !== existing.automaticSlotId || slot(before, "offline_recovery").slotId !== existing.recoverySlotId || slot(before, existing.mode).slotId !== existing.selectedSlotId) fail("unlock_transition_drift", "LUKS2 slots changed after preparation", 409);
    const headerBackup = await this.#slots.createHeaderBackup({ volumeUuid: existing.volumeUuid, expectedHeaderRevision: existing.headerRevisionBefore });
    if (!headerBackup || !UUID.test(headerBackup.headerBackupId ?? "") || !SHA256.test(headerBackup.digest ?? "") || headerBackup.independent === false) fail("unlock_transition_header_backup_failed", "Independent LUKS2 header backup failed", 409);
    let committing = await this.#repository.beginCommit({ planId: existing.planId, expectedRevision, headerBackupId: headerBackup.headerBackupId, headerBackupDigest: headerBackup.digest, committedAt: this.#clock() });
    let automaticMayBeDisabled = false;
    try {
      const changed = await this.#slots.disableAutomatic({ volumeUuid: existing.volumeUuid, expectedHeaderRevision: existing.headerRevisionBefore, automaticSlotId: existing.automaticSlotId, authorizationSlotId: existing.recoverySlotId });
      automaticMayBeDisabled = true;
      if (!SHA256.test(changed?.headerRevision ?? "")) throw new Error("post-disable header revision is invalid");
      await this.#slots.writeBootPolicy({ mode: existing.mode, volumeUuid: existing.volumeUuid, selectedSlotId: existing.selectedSlotId, recoverySlotId: existing.recoverySlotId, expectedHeaderRevision: changed.headerRevision });
      const after = inventory(await this.#slots.inventory());
      const active = new Map(after.slots.filter((item) => item.state === "active").map((item) => [item.role, item.slotId]));
      if (after.volumeUuid !== existing.volumeUuid || after.headerRevision !== changed.headerRevision || active.has("automatic") || active.get("offline_recovery") !== existing.recoverySlotId || active.get(existing.mode) !== existing.selectedSlotId) throw new Error("post-disable slot verification failed");
      committing = await this.#repository.complete({ planId: existing.planId, expectedRevision: committing.revision, headerRevisionAfter: after.headerRevision, enabledAt: this.#clock() });
      await this.#audit({ action: "security.unlock_protection_enabled", actorIdentityId: context.identityId, planId: existing.planId, mode: existing.mode, headerBackupDigest: headerBackup.digest });
      return committing;
    } catch (error) {
      let rollbackPassed = false;
      try {
        if (automaticMayBeDisabled) await this.#slots.restoreHeaderBackup({ volumeUuid: existing.volumeUuid, headerBackupId: headerBackup.headerBackupId, expectedDigest: headerBackup.digest });
        await this.#slots.writeBootPolicy({ mode: "automatic", volumeUuid: existing.volumeUuid, selectedSlotId: existing.automaticSlotId, recoverySlotId: existing.recoverySlotId, expectedHeaderRevision: existing.headerRevisionBefore });
        const restored = inventory(await this.#slots.inventory());
        rollbackPassed = restored.volumeUuid === existing.volumeUuid && restored.headerRevision === existing.headerRevisionBefore && slot(restored, "automatic").slotId === existing.automaticSlotId;
      } catch { rollbackPassed = false; }
      const failed = await this.#repository.finishFailure({ planId: existing.planId, expectedRevision: committing.revision, rollbackPassed, failureCode: rollbackPassed ? "commit_failed_rolled_back" : "manual_recovery_required", failedAt: this.#clock() });
      await this.#audit({ action: rollbackPassed ? "security.unlock_protection_rolled_back" : "security.unlock_protection_manual_recovery_required", actorIdentityId: context.identityId, planId: existing.planId, mode: existing.mode, failureCode: failed.failureCode });
      fail(rollbackPassed ? "unlock_transition_rolled_back" : "unlock_transition_manual_recovery_required", rollbackPassed ? "Unlock protection change failed and was rolled back" : "Unlock protection needs manual recovery", 409);
    }
  }
}
