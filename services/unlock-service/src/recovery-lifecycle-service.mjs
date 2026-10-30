import { randomUUID } from "node:crypto";
import { UnlockError } from "./index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
function fail(code, message, status = 409) { throw new UnlockError(code, message, { status }); }
function exactSlot(inventory, role) { const matches = inventory?.slots?.filter((item) => item.role === role && item.state === "active") ?? []; if (matches.length !== 1) fail("recovery_slot_invalid", `Exact ${role} slot is unavailable`); return matches[0]; }
function evidence(value, name) { if (!value || value.passed !== true || !SHA256.test(value.evidenceDigest ?? "")) fail("recovery_verification_failed", `${name} verification failed`); return value; }

export class MemoryRecoveryLifecycleRepository {
  #records = new Map(); #requests = new Map();
  async create(value) { const previous = this.#requests.get(value.requestId); if (previous) { const record = this.#records.get(previous); if (record.operatorId !== value.operatorId || record.recoveryEvidenceDigest !== value.recoveryEvidenceDigest || record.volumeUuid !== value.volumeUuid) fail("recovery_request_conflict", "Recovery request conflicts with its prior use"); return structuredClone(record); } this.#requests.set(value.requestId, value.recoveryId); this.#records.set(value.recoveryId, structuredClone(value)); return structuredClone(value); }
  async get(id) { return structuredClone(this.#records.get(id) ?? null); }
  async update({ recoveryId, expectedRevision, state, facts, updatedAt }) { const value = this.#records.get(recoveryId); if (!value || value.revision !== expectedRevision) fail("recovery_lifecycle_stale", "Recovery lifecycle is stale"); Object.assign(value, { state, facts: { ...value.facts, ...structuredClone(facts) }, revision: value.revision + 1, updatedAt }); return structuredClone(value); }
}

export class RecoveryLifecycleService {
  #repository; #authority; #factors; #slots; #volume; #services; #boot; #audit; #clock; #id;
  constructor({ repository, recoveryAuthority, factorVerificationService, keySlotManager, volumeControl, protectedServiceControl, bootPolicy, audit = async () => {}, clock = () => new Date(), idFactory = randomUUID }) {
    if (!repository?.create || !repository?.get || !repository?.update || !recoveryAuthority?.authorizeTicket || !recoveryAuthority?.authorizeAdministrator || !factorVerificationService?.get || !factorVerificationService?.revalidate || !keySlotManager?.inventory || !volumeControl?.unlockRecovery || !protectedServiceControl?.startRecoveryMode || !bootPolicy?.write || typeof audit !== "function") throw new TypeError("recovery lifecycle dependencies are incomplete");
    this.#repository = repository; this.#authority = recoveryAuthority; this.#factors = factorVerificationService; this.#slots = keySlotManager; this.#volume = volumeControl; this.#services = protectedServiceControl; this.#boot = bootPolicy; this.#audit = audit; this.#clock = clock; this.#id = idFactory;
  }
  async enterEmergencyRecovery({ recoveryVerificationId, requestId }) {
    if (!UUID.test(recoveryVerificationId ?? "") || !UUID.test(requestId ?? "")) fail("recovery_request_invalid", "Recovery request is invalid", 400);
    const now = this.#clock();
    const authorization = await this.#authority.authorizeTicket({ recoveryVerificationId });
    if (!authorization?.authorized || !UUID.test(authorization.operatorId ?? "")) fail("recovery_authorization_failed", "Offline recovery authorization failed", 403);
    const inventory = await this.#slots.inventory();
    const recoverySlot = exactSlot(inventory, "offline_recovery");
    const proof = await this.#factors.get(recoveryVerificationId);
    if (!proof || proof.role !== "offline_recovery" || proof.slotId !== recoverySlot.slotId || proof.volumeUuid !== inventory.volumeUuid || proof.expiresAt <= now || !SHA256.test(proof.evidenceDigest ?? "")) fail("recovery_verification_failed", "Offline recovery factor is unverified");
    const unlocked = evidence(await this.#volume.unlockRecovery({ volumeUuid: inventory.volumeUuid, recoverySlotId: recoverySlot.slotId, verificationId: recoveryVerificationId }), "offline recovery unlock");
    const services = evidence(await this.#services.startRecoveryMode({ allowlist: ["identity-recovery", "audit", "key-management", "unlock-ui"], schedulerEnabled: false, agentEnabled: false, objectWritesEnabled: false }), "emergency recovery services");
    const record = await this.#repository.create({ recoveryId: this.#id(), requestId, operatorId: authorization.operatorId, volumeUuid: inventory.volumeUuid, recoverySlotId: recoverySlot.slotId, recoveryEvidenceDigest: proof.evidenceDigest, unlockEvidenceDigest: unlocked.evidenceDigest, serviceEvidenceDigest: services.evidenceDigest, state: "EMERGENCY_RECOVERY", revision: 1, facts: { schedulerEnabled: false, agentEnabled: false, objectWritesEnabled: false }, createdAt: now, updatedAt: now });
    await this.#audit({ action: "security.emergency_recovery_entered", recoveryId: record.recoveryId, operatorId: record.operatorId, evidenceDigests: [proof.evidenceDigest, unlocked.evidenceDigest, services.evidenceDigest] });
    return record;
  }
  async finish({ context, recoveryId, selectedVerificationId }) {
    await this.#authority.authorizeAdministrator({ context, action: "recovery:manage" });
    const record = await this.#record(recoveryId, context);
    if (record.state !== "EMERGENCY_RECOVERY") fail("recovery_lifecycle_stale", "Recovery is not ready");
    evidence(await this.#factors.revalidate({ evidenceDigest: record.recoveryEvidenceDigest }), "offline recovery factor");
    const inventory = await this.#slots.inventory();
    const recovery = exactSlot(inventory, "offline_recovery");
    if (inventory.volumeUuid !== record.volumeUuid || recovery.slotId !== record.recoverySlotId) fail("recovery_slot_invalid", "Recovery volume or slot changed");
    const selected = exactSlot(inventory, "web_passphrase");
    if (!UUID.test(selectedVerificationId ?? "")) fail("recovery_verification_failed", "Verify the Web passphrase before completing recovery");
    const proof = await this.#factors.get(selectedVerificationId);
    if (!proof || proof.role !== "web_passphrase" || proof.slotId !== selected.slotId || proof.volumeUuid !== record.volumeUuid || proof.expiresAt <= this.#clock() || !SHA256.test(proof.evidenceDigest ?? "")) fail("recovery_verification_failed", "Web passphrase is unverified");
    evidence(await this.#factors.revalidate({ verificationId: selectedVerificationId, evidenceDigest: proof.evidenceDigest }), "Web passphrase");
    await this.#boot.write({ mode: "web_passphrase", volumeUuid: record.volumeUuid, selectedSlotId: selected.slotId, recoverySlotId: record.recoverySlotId, expectedHeaderRevision: inventory.headerRevision });
    const updated = await this.#repository.update({ recoveryId, expectedRevision: record.revision, state: "READY_TO_REBOOT", facts: {  }, updatedAt: this.#clock() });
    await this.#audit({ action: "security.emergency_recovery_ready_to_reboot", recoveryId, operatorId: context.identityId });
    return updated;
  }
  async #record(recoveryId, context) {
    if (!UUID.test(recoveryId ?? "") || !UUID.test(context?.identityId ?? "")) fail("recovery_request_invalid", "Recovery identity is invalid", 400);
    const value = await this.#repository.get(recoveryId.toLowerCase());
    if (!value) fail("recovery_not_found", "Recovery lifecycle was not found", 404);
    if (value.operatorId !== context.identityId.toLowerCase()) fail("recovery_actor_mismatch", "Only the recovery operator can continue", 403);
    return value;
  }
}
