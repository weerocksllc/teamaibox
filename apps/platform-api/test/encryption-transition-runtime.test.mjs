import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEncryptionTransitionRuntimeFromEnvironment } from "../src/encryption/encryption-transition-runtime.mjs";

const D = (letter) => `sha256:${letter.repeat(64)}`;
test("transition runtime binds PostgreSQL, controller status, safe factors, and prerequisites", async () => {
  const root = await mkdtemp(join(tmpdir(), "teamaibox-transition-runtime-")), path = join(root, "config.json");
  await writeFile(path, JSON.stringify({ schemaVersion: 1, socketPath: "/run/controller.sock", factors: {
    recoveryVerificationId: "018f0000-0000-7000-8000-000000000021", recoveryEvidenceDigest: D("a"),
    webVerificationId: "018f0000-0000-7000-8000-000000000022", webEvidenceDigest: D("b"),
  }, prerequisiteEvidence: { "independent-backup": D("c"), "restore-rehearsal": D("d"), "offline-recovery": D("e"), "service-drain": D("f"), "reboot-simulation": D("1") },
  usbKeyReadOnlyQualification: { sdkVersion: "4.1.1.30", deviceFamily: "ViKeyPRO",
    runId: "vikey-readonly-20260831-a10", evidenceDigest: D("9") },
  usbKeyEnrollmentQualification: { sdkVersion: "4.1.1.30", deviceFamily: "ViKeyPRO",
    runId: "vikey-enrollment-resume-20260831-a2", evidenceDigest: D("8"), evidenceFileSha256: D("7") } }));
  const controller = { async call(operation) { if (operation === "status") return { blockEncryption: { configured: true, mode: "luks2", status: "verified" }, startupProtection: { enabled: false, mode: "automatic" }, capabilities: { webPassphrase: true, usbKey: false } }; if (operation === "inventory") return { luksVersion: 2, volumeUuid: "11111111-2222-4333-8444-555555555555", headerRevision: D("2"), slots: [] }; throw new Error(operation); } };
  const database = { async query() { return { rows: [] }; }, async transaction(operation) { return operation(this); } };
  const runtime = await createEncryptionTransitionRuntimeFromEnvironment({ PLATFORM_ENCRYPTION_TRANSITION_CONFIG_FILE: path }, { database, audit: async () => {}, controllerClient: controller });
  assert.equal((await runtime.statusSource.status()).capabilities.webPassphrase, true);
  assert.equal(Object.hasOwn((await runtime.statusSource.status()), "usbKeyAdapter"), false);
  assert.deepEqual((await runtime.statusSource.status()).prerequisites.map(item => item.key), ["offline-recovery", "service-drain", "reboot-simulation"]);
  assert.equal(typeof runtime.transitionService.prepare, "function");
});
