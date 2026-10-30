import { createHash, randomUUID } from "node:crypto";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_.-]{2,127}$/;
const HEADER = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const MODEL = /^[^\s\x00-\x1f\x7f]{1,512}$/;
const CURRENCY = /^[A-Z]{3}$/;
const DATA_CLASSES = new Set(["public", "internal", "confidential", "restricted"]);
const OPERATIONS = new Set(["responses", "chat.completions", "embeddings", "images.generations", "images.edits", "ocr", "audio.transcriptions", "translations"]);
const AUTH_SCHEMES = new Set(["none", "bearer", "api_key_header"]);
const TRUST_MODES = new Set(["system_ca", "custom_ca"]);

function fail(code, message, status = 400, retryable = false, details = undefined) {
  throw new PlatformError(code, message, { status, retryable, details });
}
function text(value, name, maximum = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) fail("provider_declaration_invalid", `${name} is invalid`);
  return value.trim();
}
function key(value, name) { if (typeof value !== "string" || !KEY.test(value)) fail("provider_declaration_invalid", `${name} is invalid`); return value; }
function uuid(value, name) { if (typeof value !== "string" || !UUID.test(value)) fail("provider_declaration_invalid", `${name} is invalid`); return value; }
function integer(value, name, minimum, maximum) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("provider_declaration_invalid", `${name} is invalid`); return value; }
function enumValue(value, allowed, name) { if (!allowed.has(value)) fail("provider_declaration_invalid", `${name} is invalid`); return value; }

function actor(context, permission) {
  const identityId = context?.identityId ?? context?.identity?.id;
  if (!UUID.test(identityId ?? "")) fail("access_denied", "Administrator identity is required", 403);
  if (!new Set(context?.permissions ?? []).has(permission)) fail("access_denied", `Missing permission: ${permission}`, 403);
  return identityId;
}

function operationsViewer(context) {
  const identityId = context?.identityId ?? context?.identity?.id;
  if (!UUID.test(identityId ?? "")) fail("access_denied", "Administrator identity is required", 403);
  if (!(context?.permissions ?? []).some((permission) => new Set(["operations:view", "node:view", "node:manage", "provider:view"]).has(permission))) fail("access_denied", "Missing operations view permission", 403);
  return identityId;
}

function endpoint(value) {
  let parsed;
  try { parsed = new URL(value); } catch { fail("provider_endpoint_invalid", "Provider endpoint must be an absolute HTTPS URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) fail("provider_endpoint_invalid", "Provider endpoint must use HTTPS without credentials, query, or fragment");
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function dataClasses(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > DATA_CLASSES.size) fail("provider_declaration_invalid", "allowedDataClasses is invalid");
  const result = [...new Set(value.map((item) => enumValue(item, DATA_CLASSES, "allowedDataClasses")))];
  return Object.freeze(result.sort());
}

function auth(value, credential) {
  const scheme = enumValue(value?.scheme ?? "bearer", AUTH_SCHEMES, "auth.scheme");
  const headerName = scheme === "api_key_header" ? value?.headerName : scheme === "bearer" ? "Authorization" : null;
  if (headerName !== null && !HEADER.test(headerName ?? "")) fail("provider_declaration_invalid", "auth.headerName is invalid");
  if (scheme === "none") {
    if (credential !== null && credential !== undefined && credential !== "") fail("provider_credential_invalid", "Unauthenticated providers cannot receive a credential");
  } else if (typeof credential !== "string" || credential.length < 8 || credential.length > 8192 || /[\r\n\x00]/.test(credential)) {
    fail("provider_credential_invalid", "Provider credential is missing or invalid");
  }
  return Object.freeze({ scheme, headerName });
}

function trust(value, customCaPem) {
  const mode = enumValue(value?.mode ?? "system_ca", TRUST_MODES, "trust.mode");
  const serverName = value?.serverName == null ? null : text(value.serverName, "trust.serverName", 253).toLowerCase();
  if (serverName && (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(serverName) || serverName.includes(".."))) fail("provider_trust_invalid", "trust.serverName is invalid");
  if (mode === "custom_ca") {
    if (typeof customCaPem !== "string" || customCaPem.length < 64 || customCaPem.length > 1024 * 1024 || !customCaPem.includes("-----BEGIN CERTIFICATE-----") || !customCaPem.includes("-----END CERTIFICATE-----")) fail("provider_trust_invalid", "A bounded PEM CA bundle is required");
  } else if (customCaPem != null && customCaPem !== "") fail("provider_trust_invalid", "A custom CA bundle requires custom_ca mode");
  return Object.freeze({ mode, serverName });
}

function limits(value = {}) {
  return Object.freeze({
    concurrency: integer(value.concurrency ?? 1, "limits.concurrency", 1, 4096),
    requestsPerMinute: integer(value.requestsPerMinute ?? 60, "limits.requestsPerMinute", 1, 10_000_000),
    tokensPerMinute: value.tokensPerMinute == null ? null : integer(value.tokensPerMinute, "limits.tokensPerMinute", 1, Number.MAX_SAFE_INTEGER),
  });
}

function timeouts(value = {}) {
  const connectMilliseconds = integer(value.connectMilliseconds ?? 5_000, "timeouts.connectMilliseconds", 100, 120_000);
  const requestMilliseconds = integer(value.requestMilliseconds ?? 120_000, "timeouts.requestMilliseconds", connectMilliseconds, 3_600_000);
  const idleStreamMilliseconds = integer(value.idleStreamMilliseconds ?? 30_000, "timeouts.idleStreamMilliseconds", 1_000, 600_000);
  return Object.freeze({ connectMilliseconds, requestMilliseconds, idleStreamMilliseconds });
}

function executionPath(value, name) {
  if (typeof value !== "string" || value.length > 256 || !value.startsWith("/")
      || value.includes("..") || (value.match(/\{request_id\}/g) ?? []).length !== 1
      || !/^\/[A-Za-z0-9._~!$&()*+,;=:@%/{}/-]+$/.test(value)) {
    fail("provider_declaration_invalid", `${name} is invalid`);
  }
  return value;
}

function executionContract(value = {}) {
  const idempotencyMode = enumValue(value.idempotencyMode ?? "none", new Set(["none", "provider_key"]), "executionContract.idempotencyMode");
  const replayAfterAcceptance = enumValue(value.replayAfterAcceptance ?? "prohibited", new Set(["prohibited", "same_provider", "any_provider"]), "executionContract.replayAfterAcceptance");
  const reconcileMode = enumValue(value.reconcileMode ?? "none", new Set(["none", "status"]), "executionContract.reconcileMode");
  const cancellationMode = enumValue(value.cancellationMode ?? "none", new Set(["none", "request"]), "executionContract.cancellationMode");
  const sideEffectClass = enumValue(value.sideEffectClass ?? "none", new Set(["none", "idempotent", "non_idempotent"]), "executionContract.sideEffectClass");
  if ((idempotencyMode === "none" && value.idempotencyHeader != null)
      || (reconcileMode === "none" && value.statusPathTemplate != null)
      || (cancellationMode === "none" && (value.cancelPathTemplate != null || value.cancelMethod != null))) {
    fail("provider_declaration_invalid", "executionContract contains fields for a disabled provider behavior");
  }
  const idempotencyHeader = idempotencyMode === "provider_key" ? (value.idempotencyHeader ?? "Idempotency-Key") : null;
  if (idempotencyHeader !== null && !HEADER.test(idempotencyHeader)) fail("provider_declaration_invalid", "executionContract.idempotencyHeader is invalid");
  const statusPathTemplate = reconcileMode === "status" ? executionPath(value.statusPathTemplate, "executionContract.statusPathTemplate") : null;
  const cancelPathTemplate = cancellationMode === "request" ? executionPath(value.cancelPathTemplate, "executionContract.cancelPathTemplate") : null;
  const cancelMethod = cancellationMode === "request" ? enumValue(value.cancelMethod ?? "POST", new Set(["POST", "DELETE"]), "executionContract.cancelMethod") : null;
  if ((replayAfterAcceptance === "same_provider" && idempotencyMode !== "provider_key")
      || (replayAfterAcceptance === "any_provider" && sideEffectClass !== "none")
      || (sideEffectClass === "non_idempotent" && replayAfterAcceptance !== "prohibited")) {
    fail("provider_declaration_invalid", "executionContract contains an unsafe replay combination");
  }
  return Object.freeze({ idempotencyMode, replayAfterAcceptance, reconcileMode, cancellationMode, sideEffectClass, idempotencyHeader, statusPathTemplate, cancelPathTemplate, cancelMethod });
}

function healthCheck(value = {}) {
  const path = value.path ?? "/models";
  if (typeof path !== "string" || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,255}$/.test(path) || path.includes("..")) fail("provider_declaration_invalid", "healthCheck.path is invalid");
  return Object.freeze({
    path,
    intervalSeconds: integer(value.intervalSeconds ?? 30, "healthCheck.intervalSeconds", 5, 86_400),
    timeoutMilliseconds: integer(value.timeoutMilliseconds ?? 5_000, "healthCheck.timeoutMilliseconds", 100, 120_000),
    failureThreshold: integer(value.failureThreshold ?? 3, "healthCheck.failureThreshold", 1, 100),
  });
}

function modelControlPath(value, name) {
  if (typeof value !== "string" || value.length > 256 || !value.startsWith("/")
      || value.includes("..") || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,255}$/.test(value)) {
    fail("provider_declaration_invalid", `${name} is invalid`);
  }
  return value;
}

function resourceControl(value = null) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.mode !== "model_api") {
    fail("provider_declaration_invalid", "resourceControl is invalid");
  }
  const preparePath = modelControlPath(value.preparePath ?? "/models/prepare", "resourceControl.preparePath");
  const unloadPath = modelControlPath(value.unloadPath ?? "/models/unload", "resourceControl.unloadPath");
  const statusPath = modelControlPath(value.statusPath ?? "/health/ready", "resourceControl.statusPath");
  if (new Set([preparePath, unloadPath, statusPath]).size !== 3) {
    fail("provider_declaration_invalid", "resourceControl paths must be distinct");
  }
  return Object.freeze({
    mode: "model_api",
    preparePath,
    unloadPath,
    statusPath,
    idleSeconds: integer(value.idleSeconds ?? 300, "resourceControl.idleSeconds", 1, 86_400),
  });
}

function costAccounting(value = {}) {
  const currency = value.currency ?? "USD";
  if (!CURRENCY.test(currency)) fail("provider_declaration_invalid", "costAccounting.currency is invalid");
  const metric = (name) => integer(value[name] ?? 0, `costAccounting.${name}`, 0, Number.MAX_SAFE_INTEGER);
  return Object.freeze({
    currency,
    inputMicrounitsPerMillionTokens: metric("inputMicrounitsPerMillionTokens"),
    outputMicrounitsPerMillionTokens: metric("outputMicrounitsPerMillionTokens"),
    imageMicrounitsPerRequest: metric("imageMicrounitsPerRequest"),
    audioMicrounitsPerMinute: metric("audioMicrounitsPerMinute"),
    accountingMode: enumValue(value.accountingMode ?? "provider_reported", new Set(["provider_reported", "platform_estimated", "unpriced"]), "costAccounting.accountingMode"),
  });
}

function mappings(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) fail("provider_declaration_invalid", "At least one bounded model mapping is required");
  const profileIds = new Set();
  return Object.freeze(value.map((item, index) => {
    const modelProfileId = uuid(item?.modelProfileId, `modelMappings.${index}.modelProfileId`);
    if (profileIds.has(modelProfileId)) fail("provider_declaration_invalid", "Model profile mappings must be unique");
    profileIds.add(modelProfileId);
    if (typeof item.providerModelName !== "string" || !MODEL.test(item.providerModelName)) fail("provider_declaration_invalid", `modelMappings.${index}.providerModelName is invalid`);
    if (!Array.isArray(item.operations) || item.operations.length < 1) fail("provider_declaration_invalid", `modelMappings.${index}.operations is invalid`);
    const operations = [...new Set(item.operations.map((operation) => enumValue(operation, OPERATIONS, `modelMappings.${index}.operations`)))].sort();
    return Object.freeze({
      modelProfileId,
      providerModelName: item.providerModelName,
      operations: Object.freeze(operations),
      contextWindow: integer(item.contextWindow, `modelMappings.${index}.contextWindow`, 1, 100_000_000),
      maximumOutputTokens: item.maximumOutputTokens == null ? null : integer(item.maximumOutputTokens, `modelMappings.${index}.maximumOutputTokens`, 1, 10_000_000),
      routingWeight: integer(item.routingWeight ?? 100, `modelMappings.${index}.routingWeight`, 0, 10_000),
      enabled: item.enabled !== false,
    });
  }));
}

function declaration(value, credential, customCaPem) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("provider_declaration_invalid", "Provider declaration is required");
  return Object.freeze({
    providerKey: key(value.providerKey, "providerKey"),
    displayName: text(value.displayName, "displayName", 128),
    endpoint: endpoint(value.endpoint),
    auth: auth(value.auth, credential),
    trust: trust(value.trust, customCaPem),
    allowedDataClasses: dataClasses(value.allowedDataClasses ?? ["public"]),
    limits: limits(value.limits),
    timeouts: timeouts(value.timeouts),
    executionContract: executionContract(value.executionContract),
    resourceControl: resourceControl(value.resourceControl),
    healthCheck: healthCheck(value.healthCheck),
    costAccounting: costAccounting(value.costAccounting),
    modelMappings: mappings(value.modelMappings),
  });
}

function publicProvider(value) {
  return Object.freeze({
    providerId: value.providerId,
    providerKey: value.providerKey,
    displayName: value.displayName,
    endpoint: value.endpoint,
    lifecycleState: value.lifecycleState,
    auth: Object.freeze({ ...value.auth, credentialConfigured: value.credentialSecretKey !== null }),
    trust: Object.freeze({ ...value.trust, customCaConfigured: value.caSecretKey !== null }),
    allowedDataClasses: Object.freeze([...value.allowedDataClasses]),
    limits: Object.freeze(structuredClone(value.limits)),
    timeouts: Object.freeze(structuredClone(value.timeouts)),
    executionContract: Object.freeze(structuredClone(value.executionContract)),
    resourceControl: value.resourceControl == null ? null : Object.freeze(structuredClone(value.resourceControl)),
    healthCheck: Object.freeze(structuredClone(value.healthCheck)),
    health: Object.freeze(structuredClone(value.health)),
    contract: Object.freeze(structuredClone(value.contract)),
    costAccounting: Object.freeze(structuredClone(value.costAccounting)),
    modelMappings: Object.freeze(value.modelMappings.map((mapping) => Object.freeze(structuredClone(mapping)))),
    revision: value.revision,
    createdBy: value.createdBy,
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
  });
}

function translate(error) {
  if (typeof error?.code === "string" && error.code.startsWith("provider_")) throw new PlatformError(error.code, error.message, { status: 409 });
  throw error;
}

export class ExternalProviderService {
  #repository; #secretStore; #probe; #clock; #audit; #idFactory; #healthSink;
  #secretWriter = Object.freeze({ service: "platform-api", permissions: Object.freeze(["secrets:write", "secrets:rotate", "secrets:revoke", "secrets:metadata"]) });
  #secretReader = Object.freeze({ service: "provider-adapter", permissions: Object.freeze(["secrets:read"]) });

  constructor({ repository, secretStore, probe, clock = () => new Date(), audit = async () => {}, idFactory = randomUUID,
    healthSink = null }) {
    const repositoryMethods = ["list", "findById", "findByKey", "create", "setLifecycle", "recordContractTest", "remove"];
    if (!repository || repositoryMethods.some((method) => typeof repository[method] !== "function") || !secretStore?.putInitial || !secretStore?.rotate || !secretStore?.revoke || !secretStore?.withSecret || !probe?.run || typeof clock !== "function" || typeof audit !== "function" || typeof idFactory !== "function" || (healthSink !== null && typeof healthSink.recordProviderHealth !== "function")) throw new TypeError("External provider dependencies are incomplete");
    this.#repository = repository; this.#secretStore = secretStore; this.#probe = probe; this.#clock = clock;
    this.#audit = audit; this.#idFactory = idFactory; this.#healthSink = healthSink;
  }

  async list({ context }) { actor(context, "provider:view"); return Object.freeze({ object: "list", data: Object.freeze((await this.#repository.list()).map(publicProvider)) }); }
  async listOperations({ context }) {
    operationsViewer(context);
    const data = (await this.#repository.list()).map((value) => Object.freeze({
      providerId: value.providerId, providerKey: value.providerKey, displayName: value.displayName,
      lifecycleState: value.lifecycleState, limits: Object.freeze(structuredClone(value.limits)),
      healthCheck: Object.freeze(structuredClone(value.healthCheck)), health: Object.freeze(structuredClone(value.health)),
      modelMappings: Object.freeze(value.modelMappings.map((mapping) => Object.freeze({ modelProfileId: mapping.modelProfileId,
        operations: Object.freeze([...mapping.operations]), contextWindow: mapping.contextWindow, enabled: mapping.enabled }))),
    }));
    return Object.freeze({ object: "list", data: Object.freeze(data) });
  }
  async get({ context, providerId }) { actor(context, "provider:view"); const value = await this.#repository.findById(uuid(providerId, "providerId")); if (!value || value.lifecycleState === "removed") fail("provider_not_found", "External provider was not found", 404); return publicProvider(value); }

  async create({ context, input }) {
    const owner = actor(context, "provider:manage");
    const providerId = uuid(this.#idFactory(), "providerId");
    const normalized = declaration(input, input?.credential, input?.customCaPem);
    if (await this.#repository.findByKey(normalized.providerKey)) fail("provider_key_conflict", "Provider key already exists", 409);
    const credentialSecretKey = normalized.auth.scheme === "none" ? null : `provider.${providerId}.auth`;
    const caSecretKey = normalized.trust.mode === "custom_ca" ? `provider.${providerId}.ca` : null;
    const provisioned = [];
    try {
      if (credentialSecretKey) {
        const value = Buffer.from(input.credential, "utf8");
        try { await this.#secretStore.putInitial(credentialSecretKey, value, ["provider-adapter"], this.#secretWriter); provisioned.push(credentialSecretKey); } finally { value.fill(0); }
      }
      if (caSecretKey) {
        const value = Buffer.from(input.customCaPem, "utf8");
        try { await this.#secretStore.putInitial(caSecretKey, value, ["provider-adapter"], this.#secretWriter); provisioned.push(caSecretKey); } finally { value.fill(0); }
      }
      const now = this.#clock();
      const created = await this.#repository.create({
        ...normalized, providerId, credentialSecretKey, caSecretKey,
        lifecycleState: "disabled",
        health: { state: "unknown", latencyMilliseconds: null, errorCode: null, observedAt: null, consecutiveFailures: 0 },
        contract: { state: "untested", evidenceDigest: null, testedAt: null, failedChecks: [] },
        revision: 1, createdBy: owner, createdAt: now, updatedAt: now,
      }).catch(translate);
      await this.#audit({ action: "provider.created", actorIdentityId: owner, providerId, providerKey: normalized.providerKey, credentialConfigured: credentialSecretKey !== null, customCaConfigured: caSecretKey !== null, occurredAt: now.toISOString() });
      return publicProvider(created);
    } catch (error) {
      await Promise.allSettled(provisioned.map((name) => this.#secretStore.revoke(name, this.#secretWriter)));
      throw error;
    }
  }

  async rotateCredential({ context, providerId, credential }) {
    const owner = actor(context, "provider:manage"), id = uuid(providerId, "providerId");
    const current = await this.#repository.findById(id); if (!current) fail("provider_not_found", "External provider was not found", 404);
    if (current.lifecycleState === "removed") fail("provider_not_found", "External provider was not found", 404);
    if (!current.credentialSecretKey || current.auth.scheme === "none") fail("provider_credential_not_configured", "Provider does not use an authentication credential", 409);
    if (typeof credential !== "string" || credential.length < 8 || credential.length > 8192 || /[\r\n\x00]/.test(credential)) fail("provider_credential_invalid", "Provider credential is invalid");
    const value = Buffer.from(credential, "utf8");
    let metadata;
    try { metadata = await this.#secretStore.rotate(current.credentialSecretKey, value, ["provider-adapter"], this.#secretWriter); } finally { value.fill(0); }
    const now = this.#clock();
    await this.#audit({ action: "provider.credential_rotated", actorIdentityId: owner, providerId: id, secretVersion: metadata.activeVersion, occurredAt: now.toISOString() });
    return Object.freeze({ providerId: id, credentialConfigured: true, activeVersion: metadata.activeVersion, rotatedAt: now.toISOString() });
  }

  async setEnabled({ context, providerId, expectedRevision, enabled }) {
    const owner = actor(context, "provider:manage"), id = uuid(providerId, "providerId"), current = await this.#repository.findById(id);
    if (!current) fail("provider_not_found", "External provider was not found", 404);
    if (current.lifecycleState === "removed") fail("provider_not_found", "External provider was not found", 404);
    if (enabled === true && current.contract.state !== "passed") fail("provider_contract_not_passed", "Provider must pass its capability contract before enablement", 409);
    const now = this.#clock();
    const value = await this.#repository.setLifecycle(id, integer(expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER), enabled ? "healthy" : "disabled", now).catch(translate);
    await this.#audit({ action: enabled ? "provider.enabled" : "provider.disabled", actorIdentityId: owner, providerId: id, revision: value.revision, occurredAt: now.toISOString() });
    return publicProvider(value);
  }

  async remove({ context, providerId, expectedRevision }) {
    const owner = actor(context, "provider:manage"), id = uuid(providerId, "providerId");
    const current = await this.#repository.findById(id);
    if (!current || current.lifecycleState === "removed") fail("provider_not_found", "External provider was not found", 404);
    if (current.lifecycleState !== "disabled") fail("provider_must_be_disabled", "External provider must be disabled before removal", 409);
    const now = this.#clock();
    const removed = await this.#repository.remove(id, integer(expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER), now).catch(translate);
    const secretNames = [removed.credentialSecretKey, removed.caSecretKey].filter(Boolean);
    const revoked = await Promise.allSettled(secretNames.map((name) => this.#secretStore.revoke(name, this.#secretWriter)));
    if (revoked.some((result) => result.status === "rejected")) {
      await this.#audit({ action: "provider.secret_revoke_failed", actorIdentityId: owner, providerId: id, occurredAt: now.toISOString() });
      fail("provider_secret_revoke_failed", "Provider was removed but one or more protected secrets require reconciliation", 500);
    }
    await this.#audit({ action: "provider.removed", actorIdentityId: owner, providerId: id, providerKey: removed.providerKey, revision: removed.revision, occurredAt: now.toISOString() });
    return Object.freeze({ providerId: id, providerKey: removed.providerKey, removedAt: now.toISOString() });
  }

  async #withProbeSecrets(provider, callback) {
    const withCa = (credential) => provider.caSecretKey
      ? this.#secretStore.withSecret(provider.caSecretKey, this.#secretReader, (customCa) => callback(credential, customCa))
      : callback(credential, null);
    return provider.credentialSecretKey
      ? this.#secretStore.withSecret(provider.credentialSecretKey, this.#secretReader, (credential) => withCa(credential))
      : withCa(null);
  }

  async testContract({ context, providerId, expectedRevision }) {
    const owner = actor(context, "provider:manage"), id = uuid(providerId, "providerId"), current = await this.#repository.findById(id);
    if (!current) fail("provider_not_found", "External provider was not found", 404);
    if (current.lifecycleState === "removed") fail("provider_not_found", "External provider was not found", 404);
    let result;
    try {
      result = await this.#withProbeSecrets(current, (credential, customCa) => this.#probe.run({ provider: current, credential, customCa, signal: AbortSignal.timeout(current.timeouts.requestMilliseconds) }));
    } catch (error) {
      const code = error?.code ?? "provider_probe_failed";
      const boundedEvidence = JSON.stringify({ schemaVersion: 1, providerId: id, outcome: "probe_failed", errorCode: code });
      result = { passed: false, evidenceDigest: `sha256:${createHash("sha256").update(boundedEvidence).digest("hex")}`, latencyMilliseconds: null, failedChecks: [code] };
    }
    if (!result || typeof result.passed !== "boolean" || (result.evidenceDigest !== null && !/^sha256:[a-f0-9]{64}$/.test(result.evidenceDigest)) || (result.passed && result.evidenceDigest === null)
        || (result.latencyMilliseconds !== null && result.latencyMilliseconds !== undefined && (!Number.isSafeInteger(result.latencyMilliseconds) || result.latencyMilliseconds < 0 || result.latencyMilliseconds > 3_600_000))
        || !Array.isArray(result.failedChecks) || result.failedChecks.length > 2048
        || result.failedChecks.some((check) => typeof check !== "string" || !/^[a-z][a-z0-9_.:-]{1,191}$/.test(check))) fail("provider_probe_invalid", "Provider probe returned invalid evidence", 502);
    // Contract probes can legitimately take minutes for model-backed operations. A
    // health observation describes the completed probe, not when it started; using
    // the start time can make a freshly tested Provider stale before its first job.
    const observedAt = this.#clock();
    const next = await this.#repository.recordContractTest(id, integer(expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER), {
      lifecycleState: current.lifecycleState === "disabled" ? "disabled" : result.passed ? "healthy" : "unavailable",
      health: { state: result.passed ? "healthy" : "unavailable", latencyMilliseconds: result.latencyMilliseconds ?? null, errorCode: result.passed ? null : result.failedChecks[0] ?? "provider_contract_failed", observedAt, consecutiveFailures: result.passed ? 0 : current.health.consecutiveFailures + 1 },
      contract: { state: result.passed ? "passed" : "failed", evidenceDigest: result.evidenceDigest, testedAt: observedAt, failedChecks: [...new Set(result.failedChecks)].sort() },
      updatedAt: observedAt, actorIdentityId: owner,
    }).catch(translate);
    try { await this.#healthSink?.recordProviderHealth(next); }
    catch (error) { await this.#audit({ action: "provider.health_publish_failed", actorIdentityId: owner, providerId: id, errorCode: typeof error?.code === "string" ? error.code : "diagnostic_sink_failed", occurredAt: observedAt.toISOString() }); }
    await this.#audit({ action: "provider.contract_tested", actorIdentityId: owner, providerId: id, passed: result.passed, failedChecks: next.contract.failedChecks, evidenceDigest: result.evidenceDigest, occurredAt: observedAt.toISOString() });
    return publicProvider(next);
  }
}
