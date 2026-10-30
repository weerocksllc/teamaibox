import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MODES = new Set(["web_passphrase"]);
const PREREQUISITE_STATES = new Set(["passed", "failed", "unavailable", "pending"]);

function fail(code, message, status = 400) { throw new PlatformError(code, message, { status }); }
function authorize(context, permission) {
  const identityId = context?.identityId ?? context?.identity?.id;
  if (!UUID.test(identityId ?? "")) fail("encryption_authentication_required", "Authentication is required", 401);
  if (!context?.permissions?.includes(permission)) fail("encryption_permission_required", `Missing permission: ${permission}`, 403);
  return identityId.toLowerCase();
}
function publicTransition(value) {
  if (!value) return null;
  return Object.freeze({
    planId: value.planId,
    mode: value.mode === "usb_key" ? "retired" : value.mode,
    state: value.state,
    revision: value.revision,
    preparedAt: value.preparedAt?.toISOString?.() ?? value.preparedAt,
    expiresAt: value.expiresAt?.toISOString?.() ?? value.expiresAt,
    enabledAt: value.enabledAt?.toISOString?.() ?? value.enabledAt ?? null,
    rollbackPassed: value.rollbackPassed ?? null,
    failureCode: value.failureCode ?? null,
  });
}
function runtimeStatus(value, transitionAvailable) {
  if (!value || typeof value !== "object") fail("encryption_status_unavailable", "Encryption runtime status is unavailable", 503);
  const blockEncryption = value.blockEncryption;
  const startupProtection = value.startupProtection;
  const capabilities = value.capabilities;
  const prerequisites = value.prerequisites;
  if (!blockEncryption || typeof blockEncryption.configured !== "boolean"
    || !new Set(["luks2", "unverified"]).has(blockEncryption.mode)
    || !new Set(["verified", "unverified", "unavailable"]).has(blockEncryption.status)
    || !startupProtection || typeof startupProtection.enabled !== "boolean"
    || !new Set(["automatic", "web_passphrase", "usb_key"]).has(startupProtection.mode)
    || !capabilities || typeof capabilities.webPassphrase !== "boolean"
    || !Array.isArray(prerequisites) || prerequisites.some((item) => typeof item?.key !== "string"
      || !PREREQUISITE_STATES.has(item?.state)
      || (item.evidenceDigest != null && !SHA256.test(item.evidenceDigest)))) {
    fail("encryption_status_invalid", "Encryption runtime status is invalid", 503);
  }
  return Object.freeze({
    blockEncryption: Object.freeze({ ...blockEncryption }),
    startupProtection: Object.freeze({ ...startupProtection }),
    capabilities: Object.freeze({ webPassphrase: capabilities.webPassphrase, transition: transitionAvailable }),
    prerequisites: Object.freeze(prerequisites.map((item) => Object.freeze({ ...item }))),
  });
}

export class EncryptionAdministrationService {
  #repository; #transition; #runtime; #clock;
  constructor({ repository, transitionService = null, runtimeStatusSource, clock = () => new Date() }) {
    if (!repository?.latest || !repository?.listRecent || !runtimeStatusSource?.status
      || (transitionService !== null && (!transitionService?.prepare || !transitionService?.commit))
      || typeof clock !== "function") throw new TypeError("encryption administration dependencies are incomplete");
    this.#repository = repository;
    this.#transition = transitionService;
    this.#runtime = runtimeStatusSource;
    this.#clock = clock;
  }

  async overview({ context }) {
    authorize(context, "security:view");
    const [latest, recent, observed] = await Promise.all([
      this.#repository.latest(),
      this.#repository.listRecent(8),
      this.#runtime.status(),
    ]);
    const runtime = runtimeStatus(observed, this.#transition !== null);
    const enabled = latest?.state === "enabled" || runtime.startupProtection.enabled;
    const mode = latest?.state === "enabled" ? latest.mode : runtime.startupProtection.mode;
    return Object.freeze({
      schemaVersion: 1,
      generatedAt: this.#clock().toISOString(),
      blockEncryption: runtime.blockEncryption,
      startupProtection: Object.freeze({ enabled, mode: mode === "usb_key" ? "retired" : mode }),
      capabilities: runtime.capabilities,
      prerequisites: runtime.prerequisites,
      latestTransition: publicTransition(latest),
      recentTransitions: Object.freeze(recent.map(publicTransition)),
    });
  }

  async prepare({ context, input }) {
    authorize(context, "security:manage");
    if (!this.#transition) fail("encryption_transition_unavailable", "Startup protection transition is unavailable on this appliance", 503);
    const mode = input?.mode;
    if (!MODES.has(mode)) fail("encryption_mode_invalid", "Startup protection mode is invalid");
    const observed = runtimeStatus(await this.#runtime.status(), true);
    if (!observed.blockEncryption.configured || observed.blockEncryption.status !== "verified") {
      fail("encryption_luks2_required", "Verified LUKS2 block encryption is required", 409);
    }
    if (mode === "web_passphrase" && !observed.capabilities.webPassphrase) fail("encryption_web_unavailable", "Web passphrase mode is unavailable", 409);
    if (observed.prerequisites.some((item) => item.state !== "passed")) fail("encryption_prerequisite_failed", "All startup protection prerequisites must pass", 409);
    const expectedConfirmation = "PREPARE WEB PASSPHRASE";
    if (input?.confirmation !== expectedConfirmation) fail("encryption_confirmation_required", "Exact startup protection confirmation is required", 409);
    for (const key of ["recoveryVerificationId", "selectedVerificationId", "requestId"]) {
      if (!UUID.test(input?.[key] ?? "")) fail("encryption_verification_required", "Current factor verification tickets are required", 409);
    }
    return publicTransition(await this.#transition.prepare({
      context,
      mode,
      recoveryVerificationId: input.recoveryVerificationId,
      selectedVerificationId: input.selectedVerificationId,
      requestId: input.requestId,
    }));
  }

  async commit({ context, input }) {
    authorize(context, "security:manage");
    if (!this.#transition) fail("encryption_transition_unavailable", "Startup protection transition is unavailable on this appliance", 503);
    if (!UUID.test(input?.planId ?? "") || !Number.isInteger(input?.expectedRevision) || input.expectedRevision < 1) {
      fail("encryption_plan_invalid", "Startup protection plan is invalid");
    }
    if (input?.confirmation !== `ENABLE ${input.planId}`) fail("encryption_confirmation_required", "Exact startup protection confirmation is required", 409);
    return publicTransition(await this.#transition.commit({ context, planId: input.planId, expectedRevision: input.expectedRevision }));
  }
}

export class EnvironmentEncryptionRuntimeStatusSource {
  #environment; #transitionAvailable;
  constructor({ environment = process.env, transitionAvailable = false } = {}) {
    this.#environment = environment;
    this.#transitionAvailable = transitionAvailable;
  }
  async status() {
    const luks2 = this.#environment.PLATFORM_PROTECTED_DATA_LUKS2 === "true";
    const web = this.#transitionAvailable && this.#environment.PLATFORM_WEB_UNLOCK_CONFIGURED === "true";
    const passed = this.#environment.PLATFORM_UNLOCK_TRANSITION_PREREQUISITES === "passed";
    const state = passed ? "passed" : "unavailable";
    return Object.freeze({
      blockEncryption: Object.freeze({ configured: luks2, mode: luks2 ? "luks2" : "unverified", status: luks2 ? "verified" : "unverified" }),
      startupProtection: Object.freeze({ enabled: false, mode: "automatic" }),
      capabilities: Object.freeze({ webPassphrase: web, webPassphraseReason: web ? null : "transition-runtime-not-configured" }),
      prerequisites: Object.freeze([
        Object.freeze({ key: "offline-recovery", state }),
        Object.freeze({ key: "service-drain", state }),
        Object.freeze({ key: "reboot-simulation", state }),
      ]),
    });
  }
}
