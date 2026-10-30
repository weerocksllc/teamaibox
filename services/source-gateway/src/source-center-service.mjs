import { randomUUID } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_.-]{2,127}$/;
const SCOPE = /^[A-Za-z0-9@*][A-Za-z0-9@*._/+:-]{0,190}$/;
const ECOSYSTEMS = new Set(["pip", "npm", "apt"]);
const SOURCE_KINDS = new Set(["hosted", "proxy-cache", "upstream", "mirror", "offline-media"]);
const NETWORK_ZONES = new Set(["internal", "lan", "internet"]);
const ONLINE_MODES = new Set(["auto", "online", "offline"]);
const ARCHITECTURES = new Set(["arm64", "amd64", "all", "source"]);
const SIGNATURE_POLICIES = new Set(["required", "preferred", "not-available"]);
const CACHE_MODES = new Set(["none", "read-through", "hosted", "immutable-offline"]);
const HEALTH_STATES = new Set(["unknown", "healthy", "degraded", "offline", "detached"]);
const ENVIRONMENTS = new Set(["agent", "application-build", "model-build"]);
const OFFLINE_MODES = new Set(["allow-online", "prefer-offline", "require-offline"]);
const RULE_DECISIONS = new Set(["allow", "deny", "pin"]);

function fail(code, message, status = 400, details = null) {
  throw new PlatformError(code, message, { status, details });
}

function actor(context, permission) {
  if (!UUID.test(context?.identityId ?? "")) fail("invalid_session", "Authentication is required", 401);
  if (!context.permissions?.includes(permission)) fail("source_permission_required", "Software source permission is required", 403);
  return context.identityId;
}

function key(value, field) {
  if (typeof value !== "string" || !KEY.test(value)) fail("source_input_invalid", `${field} is invalid`, 400, { field });
  return value;
}

function text(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) fail("source_input_invalid", `${field} is invalid`, 400, { field });
  return value.trim();
}

function integer(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("source_input_invalid", `${field} is invalid`, 400, { field });
  return value;
}

function uuid(value, field) {
  if (typeof value !== "string" || !UUID.test(value)) fail("source_input_invalid", `${field} is invalid`, 400, { field });
  return value;
}

function optionalKey(value, field) {
  return value === null || value === undefined ? null : key(value, field);
}

function enumValue(value, values, field) {
  if (!values.has(value)) fail("source_input_invalid", `${field} is invalid`, 400, { field });
  return value;
}

function uniqueStrings(value, field, pattern) {
  if (!Array.isArray(value) || value.length < 1 || value.some((item) => typeof item !== "string" || !pattern.test(item)) || new Set(value).size !== value.length) fail("source_input_invalid", `${field} is invalid`, 400, { field });
  return Object.freeze([...value].sort());
}

function endpoint(value, kind) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("source_input_invalid", "endpoint is invalid");
  const networkZone = enumValue(value.networkZone, NETWORK_ZONES, "endpoint.networkZone");
  let parsed;
  try { parsed = new URL(value.url); } catch { fail("source_input_invalid", "endpoint.url is invalid", 400, { field: "endpoint.url" }); }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) fail("source_input_invalid", "endpoint.url is invalid", 400, { field: "endpoint.url" });
  if (networkZone === "internet" && parsed.protocol !== "https:") fail("source_tls_required", "Internet package sources require HTTPS", 400);
  if (kind === "offline-media" && networkZone !== "internal") fail("source_input_invalid", "Offline media endpoints must be internal");
  return Object.freeze({ url: parsed.href, networkZone });
}

function sourceDeclaration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("source_input_invalid", "Software source declaration is invalid");
  const ecosystem = enumValue(value.ecosystem, ECOSYSTEMS, "ecosystem");
  const kind = enumValue(value.kind, SOURCE_KINDS, "kind");
  const architectures = uniqueStrings(value.architectures, "architectures", /^(?:arm64|amd64|all|source)$/);
  const packageScopes = uniqueStrings(value.packageScopes, "packageScopes", SCOPE);
  const secret = value.credentialSecretKey === null || value.credentialSecretKey === undefined ? null : key(value.credentialSecretKey, "credentialSecretKey");
  if (secret && !secret.startsWith(`source.${ecosystem}.`)) fail("source_credential_reference_invalid", "Credential secret key does not match the ecosystem");
  if (secret && !new Set(["upstream", "mirror"]).has(kind)) fail("source_credential_reference_invalid", "Only external sources may use credentials");
  const storagePoolId = value.storagePoolId === null || value.storagePoolId === undefined ? null : uuid(value.storagePoolId, "storagePoolId");
  if (kind === "offline-media" && storagePoolId === null) fail("source_storage_required", "Offline media requires a storage pool binding");
  const trust = value.trust;
  if (!trust || typeof trust !== "object" || trust.checksumRequired !== true) fail("source_trust_invalid", "Package checksum verification is mandatory");
  const signaturePolicy = enumValue(trust.signaturePolicy, SIGNATURE_POLICIES, "trust.signaturePolicy");
  const cache = value.cache;
  if (!cache || typeof cache !== "object") fail("source_cache_invalid", "Source cache policy is invalid");
  const cacheMode = enumValue(cache.mode, CACHE_MODES, "cache.mode");
  if (kind === "offline-media" && cacheMode !== "immutable-offline") fail("source_cache_invalid", "Offline media must use immutable-offline cache mode");
  return Object.freeze({
    sourceKey: key(value.sourceKey, "sourceKey"), displayName: text(value.displayName, "displayName"),
    ecosystem, kind, endpoint: endpoint(value.endpoint, kind),
    priority: integer(value.priority, "priority", 0, 10_000), packageScopes, architectures,
    trust: Object.freeze({ checksumRequired: true, signaturePolicy, tlsRequired: value.endpoint.networkZone === "internet" }),
    credentialSecretKey: secret, onlineMode: enumValue(value.onlineMode, ONLINE_MODES, "onlineMode"),
    cache: Object.freeze({
      mode: cacheMode,
      maximumBytes: integer(cache.maximumBytes, "cache.maximumBytes", 0, Number.MAX_SAFE_INTEGER),
      ttlSeconds: integer(cache.ttlSeconds, "cache.ttlSeconds", 0, Number.MAX_SAFE_INTEGER),
      retainVerified: cache.retainVerified === true,
    }),
    storagePoolId, enabled: value.enabled !== false,
  });
}

function health(value, now) {
  if (!value || typeof value !== "object") fail("source_health_invalid", "Source health observation is invalid");
  const state = enumValue(value.state, HEALTH_STATES, "health.state");
  const latencyMilliseconds = value.latencyMilliseconds === null || value.latencyMilliseconds === undefined ? null : integer(value.latencyMilliseconds, "health.latencyMilliseconds", 0, 300_000);
  const errorCode = value.errorCode === null || value.errorCode === undefined ? null : key(value.errorCode, "health.errorCode");
  if (state === "healthy" && errorCode !== null) fail("source_health_invalid", "Healthy sources cannot retain an error code");
  return Object.freeze({ state, latencyMilliseconds, errorCode, observedAt: now.toISOString() });
}

function policyDeclaration(value, sources) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("source_policy_invalid", "Source policy declaration is invalid");
  const ecosystem = enumValue(value.ecosystem, ECOSYSTEMS, "ecosystem");
  const selector = value.selector;
  if (!selector || typeof selector !== "object") fail("source_policy_invalid", "Source policy selector is invalid");
  const architecture = enumValue(selector.architecture, ARCHITECTURES, "selector.architecture");
  if (!Array.isArray(value.sources) || value.sources.length < 1) fail("source_policy_invalid", "Source policy requires ordered sources");
  const sourceOrder = value.sources.map((item, ordinal) => {
    const sourceId = uuid(item?.sourceId, `sources.${ordinal}.sourceId`);
    const source = sources.get(sourceId);
    if (!source || source.ecosystem !== ecosystem) fail("source_policy_invalid", "Policy source ecosystem does not match", 409);
    return Object.freeze({ sourceId, priority: integer(item.priority, `sources.${ordinal}.priority`, 0, 10_000) });
  });
  if (new Set(sourceOrder.map((item) => item.sourceId)).size !== sourceOrder.length || new Set(sourceOrder.map((item) => item.priority)).size !== sourceOrder.length) fail("source_policy_invalid", "Policy sources and priorities must be unique");
  const packageRules = Array.isArray(value.packageRules) ? value.packageRules.map((rule, ordinal) => {
    if (!rule || typeof rule.pattern !== "string" || !SCOPE.test(rule.pattern)) fail("source_policy_invalid", `packageRules.${ordinal}.pattern is invalid`);
    const decision = enumValue(rule.decision, RULE_DECISIONS, `packageRules.${ordinal}.decision`);
    const version = rule.version === null || rule.version === undefined ? null : text(rule.version, `packageRules.${ordinal}.version`, 128);
    if ((decision === "pin") !== (version !== null)) fail("source_policy_invalid", "Only pin rules declare a version");
    return Object.freeze({ pattern: rule.pattern, decision, version });
  }) : [];
  return Object.freeze({
    policyKey: key(value.policyKey, "policyKey"), displayName: text(value.displayName, "displayName"), ecosystem,
    environment: enumValue(value.environment, ENVIRONMENTS, "environment"),
    selector: Object.freeze({ teamKey: optionalKey(selector.teamKey, "selector.teamKey"), sandboxProfileKey: optionalKey(selector.sandboxProfileKey, "selector.sandboxProfileKey"), architecture }),
    offlineMode: enumValue(value.offlineMode, OFFLINE_MODES, "offlineMode"),
    sources: Object.freeze(sourceOrder.sort((left, right) => left.priority - right.priority)),
    packageRules: Object.freeze(packageRules), enabled: value.enabled !== false,
  });
}

function publicSource(value) {
  return Object.freeze({
    sourceId: value.sourceId, sourceKey: value.sourceKey, displayName: value.displayName,
    ecosystem: value.ecosystem, kind: value.kind, endpoint: Object.freeze(structuredClone(value.endpoint)),
    priority: value.priority, packageScopes: Object.freeze([...value.packageScopes]), architectures: Object.freeze([...value.architectures]),
    trust: Object.freeze(structuredClone(value.trust)), credentialConfigured: value.credentialSecretKey !== null,
    credentialSecretKey: value.credentialSecretKey, onlineMode: value.onlineMode,
    cache: Object.freeze(structuredClone(value.cache)), storagePoolId: value.storagePoolId,
    health: Object.freeze(structuredClone(value.health)), enabled: value.enabled, revision: value.revision,
    createdBy: value.createdBy, createdAt: new Date(value.createdAt).toISOString(), updatedAt: new Date(value.updatedAt).toISOString(),
  });
}

function publicPolicy(value) {
  return Object.freeze({ ...structuredClone(value), sources: Object.freeze(value.sources.map((item) => Object.freeze(structuredClone(item)))), packageRules: Object.freeze(value.packageRules.map((item) => Object.freeze(structuredClone(item)))), createdAt: new Date(value.createdAt).toISOString(), updatedAt: new Date(value.updatedAt).toISOString() });
}

function translated(error) {
  if (typeof error?.code === "string" && error.code.startsWith("source_")) fail(error.code, error.message, 409);
  throw error;
}

export class SourceCenterService {
  #repository; #clock; #audit; #idFactory; #healthSink;
  constructor({ repository, clock = () => new Date(), audit = async () => {}, idFactory = randomUUID, healthSink = null }) {
    const methods = ["listSources", "findSource", "findSourceByKey", "createSource", "updateSource", "recordHealth", "listPolicies", "findPolicy", "findPolicyByKey", "createPolicy", "updatePolicy"];
    if (!repository || methods.some((method) => typeof repository[method] !== "function") || typeof clock !== "function" || typeof audit !== "function" || typeof idFactory !== "function" || (healthSink !== null && typeof healthSink.recordSourceHealth !== "function")) throw new TypeError("Source Center dependencies are incomplete");
    this.#repository = repository; this.#clock = clock; this.#audit = audit; this.#idFactory = idFactory; this.#healthSink = healthSink;
  }

  async overview({ context }) {
    actor(context, "source:view");
    const sources = await this.#repository.listSources(), policies = await this.#repository.listPolicies();
    const byEcosystem = Object.fromEntries([...ECOSYSTEMS].sort().map((ecosystem) => {
      const values = sources.filter((source) => source.ecosystem === ecosystem);
      return [ecosystem, { sources: values.length, enabled: values.filter((source) => source.enabled).length, healthy: values.filter((source) => source.health.state === "healthy").length, offline: values.filter((source) => new Set(["offline", "detached"]).has(source.health.state)).length, policies: policies.filter((policy) => policy.ecosystem === ecosystem).length }];
    }));
    return Object.freeze({ schemaVersion: 1, byEcosystem: Object.freeze(byEcosystem), sourceCount: sources.length, policyCount: policies.length });
  }

  async listSources({ context, ecosystem = null }) { actor(context, "source:view"); if (ecosystem !== null) enumValue(ecosystem, ECOSYSTEMS, "ecosystem"); return Object.freeze({ object: "list", data: Object.freeze((await this.#repository.listSources({ ecosystem })).map(publicSource)) }); }
  async getSource({ context, sourceId }) { actor(context, "source:view"); const value = await this.#repository.findSource(uuid(sourceId, "sourceId")); if (!value) fail("source_not_found", "Software source was not found", 404); return publicSource(value); }

  async createSource({ context, declaration }) {
    const owner = actor(context, "source:manage"), normalized = sourceDeclaration(declaration), now = this.#clock();
    const value = await this.#repository.createSource({ ...normalized, sourceId: this.#idFactory(), health: { state: "unknown", latencyMilliseconds: null, errorCode: null, observedAt: null }, revision: 1, createdBy: owner, createdAt: now, updatedAt: now }).catch(translated);
    await this.#audit({ action: "source_center.source_created", actorIdentityId: owner, sourceId: value.sourceId, sourceKey: value.sourceKey, ecosystem: value.ecosystem, credentialConfigured: value.credentialSecretKey !== null, occurredAt: now.toISOString() });
    return publicSource(value);
  }

  async updateSource({ context, sourceId, expectedRevision, declaration }) {
    const owner = actor(context, "source:manage"), id = uuid(sourceId, "sourceId"), current = await this.#repository.findSource(id); if (!current) fail("source_not_found", "Software source was not found", 404);
    const normalized = sourceDeclaration({ ...current, ...structuredClone(declaration), endpoint: { ...current.endpoint, ...declaration?.endpoint }, trust: { ...current.trust, ...declaration?.trust }, cache: { ...current.cache, ...declaration?.cache } });
    const now = this.#clock(); const value = await this.#repository.updateSource(id, integer(expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER), { ...normalized, health: current.health, updatedBy: owner, updatedAt: now }).catch(translated); if (!value) fail("source_not_found", "Software source was not found", 404);
    await this.#audit({ action: "source_center.source_updated", actorIdentityId: owner, sourceId: id, revision: value.revision, occurredAt: now.toISOString() }); return publicSource(value);
  }

  async reportHealth({ context, sourceId, expectedRevision, observation }) {
    const owner = actor(context, "source:manage"), id = uuid(sourceId, "sourceId"), now = this.#clock();
    const value = await this.#repository.recordHealth(id, integer(expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER), health(observation, now), now).catch(translated); if (!value) fail("source_not_found", "Software source was not found", 404);
    try { await this.#healthSink?.recordSourceHealth(value); }
    catch (error) { await this.#audit({ action: "source_center.health_publish_failed", actorIdentityId: owner, sourceId: id, errorCode: typeof error?.code === "string" ? error.code : "diagnostic_sink_failed", occurredAt: now.toISOString() }); }
    await this.#audit({ action: "source_center.health_recorded", actorIdentityId: owner, sourceId: id, state: value.health.state, revision: value.revision, occurredAt: now.toISOString() }); return publicSource(value);
  }

  async listPolicies({ context, ecosystem = null }) { actor(context, "source:view"); if (ecosystem !== null) enumValue(ecosystem, ECOSYSTEMS, "ecosystem"); return Object.freeze({ object: "list", data: Object.freeze((await this.#repository.listPolicies({ ecosystem })).map(publicPolicy)) }); }
  async getPolicy({ context, policyId }) { actor(context, "source:view"); const value = await this.#repository.findPolicy(uuid(policyId, "policyId")); if (!value) fail("source_policy_not_found", "Source policy was not found", 404); return publicPolicy(value); }

  async #normalizedPolicy(declaration) {
    const sources = new Map((await this.#repository.listSources()).map((source) => [source.sourceId, source]));
    return policyDeclaration(declaration, sources);
  }

  async createPolicy({ context, declaration }) {
    const owner = actor(context, "source:manage"), normalized = await this.#normalizedPolicy(declaration), now = this.#clock();
    const value = await this.#repository.createPolicy({ ...normalized, policyId: this.#idFactory(), revision: 1, createdBy: owner, createdAt: now, updatedBy: owner, updatedAt: now }).catch(translated);
    await this.#audit({ action: "source_center.policy_created", actorIdentityId: owner, policyId: value.policyId, policyKey: value.policyKey, ecosystem: value.ecosystem, occurredAt: now.toISOString() }); return publicPolicy(value);
  }

  async updatePolicy({ context, policyId, expectedRevision, declaration }) {
    const owner = actor(context, "source:manage"), id = uuid(policyId, "policyId"), current = await this.#repository.findPolicy(id); if (!current) fail("source_policy_not_found", "Source policy was not found", 404);
    const normalized = await this.#normalizedPolicy({ ...current, ...structuredClone(declaration), selector: { ...current.selector, ...declaration?.selector } }); const now = this.#clock();
    const value = await this.#repository.updatePolicy(id, integer(expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER), { ...normalized, updatedBy: owner, updatedAt: now }).catch(translated); if (!value) fail("source_policy_not_found", "Source policy was not found", 404);
    await this.#audit({ action: "source_center.policy_updated", actorIdentityId: owner, policyId: id, revision: value.revision, occurredAt: now.toISOString() }); return publicPolicy(value);
  }
}
