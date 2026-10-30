import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const PLUGIN_ID = /^[a-z][a-z0-9.-]{2,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^taibp_v1_[A-Za-z0-9_-]{43}$/;
const SCOPE = /^[a-z][a-z0-9:._-]{2,127}$/;
const DEFAULT_POLICY = Object.freeze({ defaultTtlSeconds: 120, maximumTtlSeconds: 300, minimumTtlSeconds: 15 });

export const delegatedScopeCatalogV1 = Object.freeze({
  "ai:invoke": "ai:invoke",
  "files:read": "file:read",
  "files:write": "file:write",
  "files:share": "file:share",
  "messages:read": "message:read",
  "messages:write": "message:write",
  "tasks:read": "task:own:view",
  "tasks:manage": "task:own:manage",
  "team:read": "team:view",
});

export class DelegatedUserTokenError extends Error {
  constructor(code, message, { status = 403, retryable = false } = {}) {
    super(message);
    this.name = "DelegatedUserTokenError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function fail(code, message, options) {
  throw new DelegatedUserTokenError(code, message, options);
}

function validDate(value, label) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return date;
}

function normalizeResource(value) {
  const kind = value?.kind;
  const key = value?.key;
  if (typeof kind !== "string" || !/^[a-z][a-z0-9_.-]{1,63}$/.test(kind)
    || typeof key !== "string" || key.length < 1 || key.length > 256
    || (kind === "appliance" && key !== "*")) {
    fail("plugin_delegation_resource_invalid", "Delegated resource is invalid", { status: 400 });
  }
  return Object.freeze({ kind, key });
}

function normalizeGrants({ grants, manifest, scopeCatalog }) {
  if (!Array.isArray(grants) || grants.length < 1 || grants.length > 64) {
    fail("plugin_delegation_scope_invalid", "At least one bounded delegated scope is required", { status: 400 });
  }
  const declared = new Set(manifest.permissions.platformApiScopes);
  const seen = new Set();
  return Object.freeze(grants.map((grant) => {
    const scope = grant?.scope;
    if (typeof scope !== "string" || !SCOPE.test(scope) || !declared.has(scope) || !scopeCatalog[scope]) {
      fail("plugin_delegation_scope_denied", "Delegated scope is not declared or supported");
    }
    const resource = normalizeResource(grant.resource);
    const identity = `${scope}\n${resource.kind}\n${resource.key}`;
    if (seen.has(identity)) fail("plugin_delegation_scope_invalid", "Delegated scopes must be unique", { status: 400 });
    seen.add(identity);
    return Object.freeze({ scope, permission: scopeCatalog[scope], resource });
  }));
}

function grantCovers(grant, scope, resource) {
  if (grant.scope !== scope) return false;
  if (grant.resource.kind === "appliance" && grant.resource.key === "*") return true;
  return grant.resource.kind === resource.kind && grant.resource.key === resource.key;
}

function publicDelegation(record) {
  return Object.freeze({
    delegationId: record.delegationId,
    audience: record.audience,
    pluginId: record.pluginId,
    pluginVersion: record.pluginVersion,
    pluginGeneration: record.pluginGeneration,
    identityId: record.identityId,
    grants: Object.freeze(structuredClone(record.grants)),
    issuedAt: validDate(record.issuedAt, "issuedAt").toISOString(),
    expiresAt: validDate(record.expiresAt, "expiresAt").toISOString(),
  });
}

export class DelegatedUserTokenService {
  #repository;
  #accessControl;
  #authorityVerifier;
  #audit;
  #pepper;
  #clock;
  #policy;
  #tokenFactory;

  constructor({
    repository,
    accessControl,
    authorityVerifier,
    auditSink,
    tokenPepper,
    clock = () => new Date(),
    policy = {},
    tokenFactory = () => randomBytes(32).toString("base64url"),
  }) {
    if (!repository?.getActivePlugin || !repository?.insertDelegation || !repository?.findDelegationByTokenHash
      || !repository?.touchDelegation || !repository?.revokeDelegation || !repository?.revokeForSession
      || !repository?.revokeForPlugin || !accessControl?.resolveSession || !accessControl?.loadSession
      || !accessControl?.authorize || !authorityVerifier?.verify || !auditSink?.record) {
      throw new TypeError("delegated user token dependencies are required");
    }
    if (!(tokenPepper instanceof Uint8Array) || tokenPepper.byteLength < 32) {
      throw new TypeError("delegated token pepper must contain at least 32 bytes");
    }
    this.#repository = repository;
    this.#accessControl = accessControl;
    this.#authorityVerifier = authorityVerifier;
    this.#audit = auditSink;
    this.#pepper = Buffer.from(tokenPepper);
    this.#clock = clock;
    this.#policy = Object.freeze({ ...DEFAULT_POLICY, ...policy });
    this.#tokenFactory = tokenFactory;
    for (const field of ["defaultTtlSeconds", "maximumTtlSeconds", "minimumTtlSeconds"]) {
      if (!Number.isSafeInteger(this.#policy[field]) || this.#policy[field] < 1) throw new TypeError(`delegated token ${field} is invalid`);
    }
    if (this.#policy.minimumTtlSeconds > this.#policy.defaultTtlSeconds
      || this.#policy.defaultTtlSeconds > this.#policy.maximumTtlSeconds
      || this.#policy.maximumTtlSeconds > 900) {
      throw new TypeError("delegated token TTL policy is invalid");
    }
  }

  #hash(token) {
    return createHmac("sha256", this.#pepper).update(token, "utf8").digest("hex");
  }

  async #emit(action, facts) {
    await this.#audit.record(Object.freeze({
      schemaVersion: 1,
      action,
      occurredAt: validDate(this.#clock(), "clock").toISOString(),
      ...structuredClone(facts),
    }));
  }

  async issue({ context, pluginId, grants, ttlSeconds = this.#policy.defaultTtlSeconds }) {
    if (!PLUGIN_ID.test(pluginId ?? "")) fail("plugin_delegation_plugin_invalid", "Plugin identity is invalid", { status: 400 });
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < this.#policy.minimumTtlSeconds
      || ttlSeconds > this.#policy.maximumTtlSeconds) {
      fail("plugin_delegation_ttl_invalid", "Delegated token lifetime is outside policy", { status: 400 });
    }
    const now = validDate(this.#clock(), "clock");
    const session = await this.#accessControl.resolveSession(context, now);
    if (!session || !UUID.test(session.identityId ?? "") || !UUID.test(session.sessionId ?? "")
      || session.identityKind !== "local_user" || session.status !== "active") {
      fail("plugin_delegation_session_required", "An active local-user session is required", { status: 401 });
    }
    const plugin = await this.#repository.getActivePlugin(pluginId);
    if (!plugin || plugin.pluginType !== "ApplicationPlugin" || plugin.lifecycleState !== "enabled"
      || !plugin.manifest?.permissions?.delegatedUserToken) {
      fail("plugin_delegation_unavailable", "Application plugin delegation is unavailable");
    }
    const normalized = normalizeGrants({ grants, manifest: plugin.manifest, scopeCatalog: delegatedScopeCatalogV1 });
    for (const grant of normalized) {
      const allowed = await this.#accessControl.authorize({
        principal: session.principal,
        identityId: session.identityId,
        sessionId: session.sessionId,
        permission: grant.permission,
        resource: grant.resource,
        now,
      });
      if (allowed !== true) fail("plugin_delegation_scope_denied", "The user cannot delegate a requested scope");
    }
    let token;
    let record;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      token = `taibp_v1_${this.#tokenFactory()}`;
      if (!TOKEN.test(token)) throw new TypeError("delegated token factory returned invalid entropy");
      record = {
        delegationId: randomUUID(),
        pluginId,
        pluginVersion: plugin.currentVersion,
        pluginGeneration: plugin.generation,
        audience: `plugin:${pluginId}`,
        identityId: session.identityId,
        sessionId: session.sessionId,
        tokenHash: this.#hash(token),
        grants: normalized,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
        lastUsedAt: null,
        revokedAt: null,
        revokeReason: null,
      };
      try {
        await this.#repository.insertDelegation(record);
        break;
      } catch (error) {
        if (attempt === 2 || !new Set(["delegated_token_collision", "23505"]).has(error?.code)) throw error;
        record = null;
      }
    }
    if (!record) fail("plugin_delegation_unavailable", "Delegated token could not be issued", { status: 503, retryable: true });
    await this.#emit("plugin.delegation.issued", {
      delegationId: record.delegationId,
      pluginId,
      identityId: session.identityId,
      scopes: normalized.map(({ scope }) => scope),
      expiresAt: record.expiresAt.toISOString(),
    });
    return Object.freeze({ token, delegation: publicDelegation(record) });
  }

  async authenticate({ token, pluginId, requiredScope, resource }) {
    if (typeof token !== "string" || !TOKEN.test(token) || !PLUGIN_ID.test(pluginId ?? "")
      || typeof requiredScope !== "string" || !SCOPE.test(requiredScope)) {
      fail("plugin_delegation_invalid", "Delegated token is invalid or expired", { status: 401 });
    }
    const now = validDate(this.#clock(), "clock");
    const expectedHash = this.#hash(token);
    const record = await this.#repository.findDelegationByTokenHash(expectedHash);
    const storedHash = typeof record?.tokenHash === "string" ? Buffer.from(record.tokenHash, "hex") : Buffer.alloc(0);
    const suppliedHash = Buffer.from(expectedHash, "hex");
    const hashMatches = storedHash.length === suppliedHash.length && timingSafeEqual(storedHash, suppliedHash);
    if (!record || !hashMatches || record.revokedAt || validDate(record.expiresAt, "expiresAt") <= now
      || record.pluginId !== pluginId || record.audience !== `plugin:${pluginId}`) {
      await this.#emit("plugin.delegation.authentication_failed", { pluginId, reason: "unavailable" });
      fail("plugin_delegation_invalid", "Delegated token is invalid or expired", { status: 401 });
    }
    const plugin = await this.#repository.getActivePlugin(pluginId);
    if (!plugin || plugin.pluginType !== "ApplicationPlugin" || plugin.lifecycleState !== "enabled"
      || plugin.currentVersion !== record.pluginVersion || plugin.generation !== record.pluginGeneration) {
      fail("plugin_delegation_stale", "Delegated token is no longer bound to the active plugin", { status: 401 });
    }
    const session = await this.#accessControl.loadSession(record.identityId, record.sessionId, now);
    if (!session || session.identityKind !== "local_user" || session.status !== "active") {
      fail("plugin_delegation_session_inactive", "Delegating session is no longer active", { status: 401 });
    }
    const target = normalizeResource(resource);
    const grant = record.grants.find((candidate) => grantCovers(candidate, requiredScope, target));
    if (!grant || delegatedScopeCatalogV1[requiredScope] !== grant.permission) {
      fail("plugin_delegation_scope_denied", "Delegated scope does not cover this request");
    }
    const stillAllowed = await this.#accessControl.authorize({
      principal: session.principal,
      identityId: record.identityId,
      sessionId: record.sessionId,
      permission: grant.permission,
      resource: target,
      now,
    });
    if (stillAllowed !== true) fail("plugin_delegation_scope_revoked", "Delegated authority has been revoked");
    await this.#repository.touchDelegation(record.delegationId, now);
    await this.#emit("plugin.delegation.authenticated", {
      delegationId: record.delegationId,
      pluginId,
      identityId: record.identityId,
      scope: requiredScope,
    });
    return Object.freeze({
      identityId: record.identityId,
      identityKind: "local_user",
      delegatedBySessionId: record.sessionId,
      submittedByPluginId: pluginId,
      delegationId: record.delegationId,
      permission: grant.permission,
      resource: target,
    });
  }

  async revoke({ context, delegationId, reason = "user_revoked" }) {
    if (!UUID.test(delegationId ?? "") || !/^[a-z][a-z0-9_-]{2,63}$/.test(reason)) {
      fail("plugin_delegation_revoke_invalid", "Delegation revocation request is invalid", { status: 400 });
    }
    const now = validDate(this.#clock(), "clock");
    const session = await this.#accessControl.resolveSession(context, now);
    const record = await this.#repository.getDelegation(delegationId);
    if (!session || !record || session.identityId !== record.identityId) {
      fail("plugin_delegation_revoke_denied", "Delegation cannot be revoked by this user");
    }
    const revoked = await this.#repository.revokeDelegation(delegationId, now, reason);
    await this.#emit("plugin.delegation.revoked", { delegationId, pluginId: record.pluginId, identityId: record.identityId, reason, success: revoked });
    return Object.freeze({ delegationId, revoked });
  }

  async revokeForSession({ authority, identityId, sessionId, reason = "session_revoked" }) {
    await this.#authorityVerifier.verify(authority, { operation: "revoke-session-delegations", identityId, sessionId });
    const now = validDate(this.#clock(), "clock");
    const count = await this.#repository.revokeForSession(identityId, sessionId, now, reason);
    await this.#emit("plugin.delegation.session_revoked", { identityId, sessionId, reason, count });
    return Object.freeze({ count });
  }

  async revokeForPlugin({ authority, pluginId, reason = "plugin_state_changed" }) {
    await this.#authorityVerifier.verify(authority, { operation: "revoke-plugin-delegations", pluginId });
    const now = validDate(this.#clock(), "clock");
    const count = await this.#repository.revokeForPlugin(pluginId, now, reason);
    await this.#emit("plugin.delegation.plugin_revoked", { pluginId, reason, count });
    return Object.freeze({ count });
  }
}
