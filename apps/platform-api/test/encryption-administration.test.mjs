import assert from "node:assert/strict";
import test from "node:test";

import { EncryptionAdministrationHttpApi } from "../src/encryption/encryption-administration-http-api.mjs";
import { EncryptionAdministrationService, EnvironmentEncryptionRuntimeStatusSource } from "../src/encryption/encryption-administration-service.mjs";
import { PostgresEncryptionAdministrationRepository } from "../src/encryption/postgres-encryption-administration-repository.mjs";

const OWNER = "018f0000-0000-7000-8000-000000000001";
const MEMBER = "018f0000-0000-7000-8000-000000000002";
const RECOVERY = "018f0000-0000-7000-8000-000000000011";
const SELECTED = "018f0000-0000-7000-8000-000000000012";
const REQUEST = "018f0000-0000-7000-8000-000000000013";
const PLAN = "018f0000-0000-7000-8000-000000000014";
const NOW = new Date("2026-08-22T08:00:00.000Z");
const D = (letter) => `sha256:${letter.repeat(64)}`;
const owner = { identityId: OWNER, permissions: ["security:view", "security:manage"] };

function runtime(overrides = {}) {
  return {
    async status() {
      return {
        blockEncryption: { configured: true, mode: "luks2", status: "verified" },
        startupProtection: { enabled: false, mode: "automatic" },
        capabilities: { webPassphrase: true, usbKey: false, usbKeyReason: "approved-sdk-and-device-not-configured" },
        usbKeyAdapter: { status: "unavailable", sdkVersion: null, deviceFamily: null, qualificationRunId: null, evidenceDigest: null },
        prerequisites: ["independent-backup", "restore-rehearsal", "offline-recovery", "service-drain", "reboot-simulation"]
          .map((key) => ({ key, state: "passed" })),
        ...overrides,
      };
    },
  };
}

function fixture({ transitionAvailable = true, status = runtime() } = {}) {
  let records = [];
  const calls = [];
  const repository = {
    async latest() { return records[0] ?? null; },
    async listRecent() { return records; },
  };
  const transitionService = transitionAvailable ? {
    async prepare(input) {
      calls.push({ operation: "prepare", input });
      const value = { planId: PLAN, mode: input.mode, state: "prepared", revision: 1,
        preparedAt: NOW, expiresAt: new Date(NOW.getTime() + 3_600_000), enabledAt: null };
      records = [value]; return value;
    },
    async commit(input) {
      calls.push({ operation: "commit", input });
      const value = { ...records[0], state: "enabled", revision: 3, enabledAt: NOW };
      records = [value]; return value;
    },
  } : null;
  return { service: new EncryptionAdministrationService({ repository, transitionService, runtimeStatusSource: status, clock: () => NOW }), calls };
}

test("encryption overview distinguishes LUKS2 at rest from optional startup protection", async () => {
  const value = fixture({ transitionAvailable: false });
  const result = await value.service.overview({ context: { identityId: OWNER, permissions: ["security:view"] } });
  assert.deepEqual(result.blockEncryption, { configured: true, mode: "luks2", status: "verified" });
  assert.deepEqual(result.startupProtection, { enabled: false, mode: "automatic" });
  assert.equal(result.capabilities.transition, false);
  assert.equal(Object.hasOwn(result.capabilities, "usbKey"), false);
  assert.equal(Object.hasOwn(result, "usbKeyAdapter"), false);
  await assert.rejects(value.service.overview({ context: { identityId: MEMBER, permissions: [] } }),
    (error) => error.code === "encryption_permission_required" && error.status === 403);
});

test("Web startup protection requires passed readiness, verification tickets, and two exact confirmations", async () => {
  const value = fixture();
  const input = { mode: "web_passphrase", recoveryVerificationId: RECOVERY, selectedVerificationId: SELECTED,
    requestId: REQUEST, confirmation: "PREPARE WEB PASSPHRASE" };
  await assert.rejects(value.service.prepare({ context: owner, input: { ...input, confirmation: "PREPARE" } }),
    (error) => error.code === "encryption_confirmation_required");
  const prepared = await value.service.prepare({ context: owner, input });
  assert.equal(prepared.state, "prepared");
  assert.equal(Object.hasOwn(prepared, "selectedVerificationId"), false);
  await assert.rejects(value.service.commit({ context: owner, input: { planId: PLAN, expectedRevision: 1, confirmation: "ENABLE" } }),
    (error) => error.code === "encryption_confirmation_required");
  const enabled = await value.service.commit({ context: owner, input: { planId: PLAN, expectedRevision: 1, confirmation: `ENABLE ${PLAN}` } });
  assert.equal(enabled.state, "enabled");
  assert.deepEqual(value.calls.map((item) => item.operation), ["prepare", "commit"]);
  assert.equal((await value.service.overview({ context: owner })).startupProtection.mode, "web_passphrase");
});

test("legacy hardware protection is reported as retired, never silently as automatic", async () => {
  const value = fixture({ status: runtime({ startupProtection: { enabled: true, mode: "usb_key" } }) });
  const state = await value.service.overview({ context: owner });
  assert.deepEqual(state.startupProtection, { enabled: true, mode: "retired" });
  assert.equal(Object.hasOwn(state.capabilities, "usbKey"), false);
  assert.deepEqual(value.calls, []);
});

test("USB and unavailable transitions fail closed without changing protection", async () => {
  const value = fixture();
  await assert.rejects(value.service.prepare({ context: owner, input: { mode: "usb_key", recoveryVerificationId: RECOVERY,
    selectedVerificationId: SELECTED, requestId: REQUEST, confirmation: "PREPARE USB KEY" } }),
  (error) => error.code === "encryption_mode_invalid");
  const unavailable = fixture({ transitionAvailable: false });
  await assert.rejects(unavailable.service.prepare({ context: owner, input: {} }),
    (error) => error.code === "encryption_transition_unavailable" && error.status === 503);
});

test("encryption HTTP adapter exposes only status and bounded prepare/commit phases", async () => {
  const value = fixture(); const api = new EncryptionAdministrationHttpApi({ service: value.service });
  assert.equal(api.matches("GET", "/api/v1/admin/encryption/status"), true);
  assert.equal(api.matches("POST", "/api/v1/admin/encryption/protection/enable"), true);
  assert.equal(api.matches("DELETE", "/api/v1/admin/encryption/protection/enable"), false);
  const prepared = await api.handle({ method: "POST", pathname: "/api/v1/admin/encryption/protection/enable", context: owner,
    body: { phase: "prepare", mode: "web_passphrase", recovery_verification_id: RECOVERY,
      selected_verification_id: SELECTED, request_id: REQUEST, confirmation: "PREPARE WEB PASSPHRASE" } });
  assert.equal(prepared.status, 201);
  const committed = await api.handle({ method: "POST", pathname: "/api/v1/admin/encryption/protection/enable", context: owner,
    body: { phase: "commit", plan_id: PLAN, expected_revision: 1, confirmation: `ENABLE ${PLAN}` } });
  assert.equal(committed.status, 200);
});

test("environment status is conservative until exact runtime evidence is configured", async () => {
  const source = new EnvironmentEncryptionRuntimeStatusSource({ environment: {
    PLATFORM_PROTECTED_DATA_LUKS2: "true",
    PLATFORM_WEB_UNLOCK_CONFIGURED: "true",
    PLATFORM_UNLOCK_TRANSITION_PREREQUISITES: "passed",
  }, transitionAvailable: true });
  const value = await source.status();
  assert.equal(value.blockEncryption.status, "verified");
  assert.equal(value.capabilities.webPassphrase, true);
  assert.equal(Object.hasOwn(value.capabilities, "usbKey"), false);
  assert.equal(Object.hasOwn(value, "usbKeyAdapter"), false);
  assert.ok(value.prerequisites.every((item) => item.state === "passed"));
});

test("PostgreSQL administration history projects no verification tickets or key material", async () => {
  const database = { async query(sql, parameters = []) {
    assert.doesNotMatch(sql, /verification_id|evidence_digest|header_revision|slot_id/i);
    if (parameters.length) assert.deepEqual(parameters, [8]);
    return { rows: [{ plan_id: PLAN, mode: "web_passphrase", state: "prepared", revision: 1,
      prepared_at: NOW, expires_at: new Date(NOW.getTime() + 3_600_000), enabled_at: null,
      rollback_passed: null, failure_code: null }] };
  } };
  const repository = new PostgresEncryptionAdministrationRepository({ database });
  assert.equal((await repository.latest()).planId, PLAN);
  assert.equal((await repository.listRecent())[0].planId, PLAN);
});
