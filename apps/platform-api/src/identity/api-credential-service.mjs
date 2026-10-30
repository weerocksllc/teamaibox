import { createHmac, randomBytes } from "node:crypto";

import {
  assertPermissionKey,
  evaluateAuthorization,
} from "../../../../packages/authorization/src/index.mjs";
import { PlatformError } from "../../../../packages/observability/src/index.mjs";
import { CredentialRepositoryError } from "./memory-credential-repository.mjs";

const TOKEN_PREFIX = "taib_sk_";
const TOKEN_PATTERN = /^taib_sk_[A-Za-z0-9_-]{43}$/;
const RESOURCE_KIND = /^[a-z][a-z0-9_.-]{1,63}$/;
const DEFAULT_POLICY = Object.freeze({
  minimumLifetimeMs: 5 * 60 * 1000,
  developerMaximumLifetimeMs: 90 * 24 * 60 * 60 * 1000,
  serviceMaximumLifetimeMs: 365 * 24 * 60 * 60 * 1000,
  maximumScopes: 32,
});

export const developerCredentialPermissions = Object.freeze([
  "application:catalog:view",
  "ai:invoke",
  "file:read",
  "file:write",
  "message:read",
  "message:write",
  "task:own:view",
  "task:own:manage",
  "team:view",
]);

const developerPermissionSet = new Set(developerCredentialPermissions);

function publicCredential(record) {
  return Object.freeze({
    id: record.id,
    subjectIdentityId: record.subjectIdentityId,
    kind: record.kind,
    displayName: record.displayName,
    hint: record.hint,
    scopes: Object.freeze(record.scopes.map((scope) => Object.freeze({ ...scope }))),
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    lastUsedAt: record.lastUsedAt ? new Date(record.lastUsedAt).toISOString() : null,
    revokedAt: record.revokedAt ? new Date(record.revokedAt).toISOString() : null,
    revokeReason: record.revokeReason ?? null,
  });
}

function safeDisplayName(value) {
  if (typeof value !== "string") {
    throw new PlatformError("invalid_credential", "Credential name is invalid", { status: 400 });
  }
  const normalized = value.normalize("NFC").trim();
  if ([...normalized].length < 1 || [...normalized].length > 128 || /\p{Cc}/u.test(normalized)) {
    throw new PlatformError("invalid_credential", "Credential name is invalid", { status: 400 });
  }
  return normalized;
}

function safeRevokeReason(value) {
  const normalized = typeof value === "string" ? value.normalize("NFC").trim() : "revoked_by_user";
  if ([...normalized].length < 1 || [...normalized].length > 128 || /\p{Cc}/u.test(normalized)) {
    throw new PlatformError("invalid_credential", "Credential revoke reason is invalid", { status: 400 });
  }
  return normalized;
}

function normalizeScope(scope) {
  try {
    assertPermissionKey(scope?.permissionKey);
  } catch {
    throw new PlatformError("invalid_credential_scope", "Credential scope is invalid", { status: 400 });
  }
  const resourceKind = scope?.resourceKind ?? "appliance";
  const resourceKey = scope?.resourceKey ?? (resourceKind === "appliance" ? "*" : null);
  if (!RESOURCE_KIND.test(resourceKind)
    || typeof resourceKey !== "string"
    || resourceKey.length < 1
    || resourceKey.length > 256
    || (resourceKind === "appliance" && resourceKey !== "*")) {
    throw new PlatformError("invalid_credential_scope", "Credential scope is invalid", { status: 400 });
  }
  return { permissionKey: scope.permissionKey, resourceKind, resourceKey };
}

function normalizeScopes(scopes, maximumScopes) {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > maximumScopes) {
    throw new PlatformError("invalid_credential_scope", "Credential scopes are invalid", { status: 400 });
  }
  const unique = new Map();
  for (const raw of scopes) {
    const scope = normalizeScope(raw);
    unique.set(`${scope.permissionKey}\0${scope.resourceKind}\0${scope.resourceKey}`, scope);
  }
  if (unique.size !== scopes.length) {
    throw new PlatformError("invalid_credential_scope", "Credential scopes must be unique", { status: 400 });
  }
  return [...unique.values()].sort((left, right) =>
    `${left.permissionKey}:${left.resourceKind}:${left.resourceKey}`
      .localeCompare(`${right.permissionKey}:${right.resourceKind}:${right.resourceKey}`),
  );
}

function expiryWithin(value, now, minimumMs, maximumMs) {
  const expiresAt = value instanceof Date ? new Date(value) : new Date(value);
  const lifetime = expiresAt.getTime() - now.getTime();
  if (!Number.isFinite(expiresAt.getTime()) || lifetime < minimumMs || lifetime > maximumMs) {
    throw new PlatformError("invalid_credential_expiry", "Credential expiry is outside the allowed range", { status: 400 });
  }
  return expiresAt;
}

function scopeResource(scope) {
  return { kind: scope.resourceKind, key: scope.resourceKey };
}

function scopeCovers(granted, requested) {
  if (granted.permissionKey !== requested.permissionKey) return false;
  if (granted.resourceKind === "appliance" && granted.resourceKey === "*") return true;
  return granted.resourceKind === requested.resourceKind && granted.resourceKey === requested.resourceKey;
}

function activeGrantCovers(grant, scope, expiresAt, now) {
  return !grant.revokedAt
    && new Date(grant.expiresAt) > now
    && new Date(grant.expiresAt) >= expiresAt
    && scopeCovers(grant, scope);
}

function permissionGranted(principal, permission, resource, now) {
  return evaluateAuthorization({ principal, permission, resource, now }).allowed;
}

export class ApiCredentialService {
  #repository;
  #audit;
  #clock;
  #policy;
  #pepper;

  constructor({
    repository,
    credentialPepper,
    audit = async () => {},
    clock = () => new Date(),
    policy = {},
  }) {
    const requiredMethods = [
      "loadPrincipalAccess", "insertCredential", "findCredentialByHash",
      "findCredentialById", "listCredentialsForSubject", "touchCredential",
      "revokeCredential",
    ];
    if (!repository || requiredMethods.some((method) => typeof repository[method] !== "function")) {
      throw new TypeError("credential repository is required");
    }
    if (!(credentialPepper instanceof Uint8Array) || credentialPepper.byteLength < 32) {
      throw new TypeError("credential pepper must contain at least 32 bytes");
    }
    this.#repository = repository;
    this.#audit = audit;
    this.#clock = clock;
    this.#policy = Object.freeze({ ...DEFAULT_POLICY, ...policy });
    this.#pepper = Buffer.from(credentialPepper);
  }

  async #emit(action, fields = {}) {
    await this.#audit({ action, occurredAt: this.#clock().toISOString(), ...fields });
  }

  #hash(secret) {
    return createHmac("sha256", this.#pepper).update(secret, "utf8").digest("hex");
  }

  async #loadActivePrincipal(identityId) {
    const principal = await this.#repository.loadPrincipalAccess(identityId);
    if (!principal || principal.status !== "active") {
      throw new PlatformError("invalid_session", "Identity is unavailable", { status: 401 });
    }
    return principal;
  }

  async #requireActorPermission(context, permission) {
    if (!context?.identityId || !context.permissions?.includes(permission)) {
      throw new PlatformError("access_denied", "Permission denied", { status: 403 });
    }
    const principal = await this.#loadActivePrincipal(context.identityId);
    if (!permissionGranted(principal, permission, { kind: "appliance", key: "*" }, this.#clock())) {
      throw new PlatformError("access_denied", "Permission denied", { status: 403 });
    }
    return principal;
  }

  async #persist({ actorIdentityId, subjectIdentityId, kind, displayName, scopes, expiresAt }) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const secret = TOKEN_PREFIX + randomBytes(32).toString("base64url");
      const record = {
        subjectIdentityId,
        kind,
        displayName,
        hint: secret.slice(0, TOKEN_PREFIX.length + 8),
        tokenHash: this.#hash(secret),
        scopes,
        createdByIdentityId: actorIdentityId,
        createdAt: this.#clock(),
        expiresAt,
        lastUsedAt: null,
        revokedAt: null,
        revokeReason: null,
      };
      try {
        const stored = await this.#repository.insertCredential(record);
        await this.#emit("credential.issued", {
          credentialId: stored.id,
          actorIdentityId,
          subjectIdentityId,
          credentialKind: kind,
          scopeCount: scopes.length,
          expiresAt: expiresAt.toISOString(),
          success: true,
        });
        return Object.freeze({ credential: publicCredential(stored), secret });
      } catch (error) {
        if (!(error instanceof CredentialRepositoryError) || error.code !== "credential_collision" || attempt === 2) {
          throw error;
        }
      }
    }
    throw new PlatformError("credential_unavailable", "Credential could not be created", { status: 503, retryable: true });
  }

  async issueDeveloperCredential({ context, displayName, scopes, expiresAt }) {
    const now = this.#clock();
    const principal = await this.#requireActorPermission(context, "developer_credential:create");
    if (principal.identityKind !== "local_user") {
      throw new PlatformError("access_denied", "Developer credentials require a local user", { status: 403 });
    }
    const normalizedScopes = normalizeScopes(scopes, this.#policy.maximumScopes);
    for (const scope of normalizedScopes) {
      if (!developerPermissionSet.has(scope.permissionKey)
        || !permissionGranted(principal, scope.permissionKey, scopeResource(scope), now)) {
        throw new PlatformError("access_denied", "Requested credential scope is not permitted", { status: 403 });
      }
    }
    const boundedExpiry = expiryWithin(
      expiresAt,
      now,
      this.#policy.minimumLifetimeMs,
      this.#policy.developerMaximumLifetimeMs,
    );
    return this.#persist({
      actorIdentityId: context.identityId,
      subjectIdentityId: context.identityId,
      kind: "developer",
      displayName: safeDisplayName(displayName),
      scopes: normalizedScopes,
      expiresAt: boundedExpiry,
    });
  }

  async issueServiceCredential({ context, serviceIdentityId, displayName, scopes, expiresAt }) {
    const now = this.#clock();
    await this.#requireActorPermission(context, "service_credential:manage");
    const subject = await this.#loadActivePrincipal(serviceIdentityId);
    if (subject.identityKind !== "service_account") {
      throw new PlatformError("invalid_service_account", "Target identity is not a service account", { status: 400 });
    }
    const normalizedScopes = normalizeScopes(scopes, this.#policy.maximumScopes);
    const boundedExpiry = expiryWithin(
      expiresAt,
      now,
      this.#policy.minimumLifetimeMs,
      this.#policy.serviceMaximumLifetimeMs,
    );
    for (const scope of normalizedScopes) {
      if (!(subject.serviceGrants ?? []).some((grant) =>
        activeGrantCovers(grant, scope, boundedExpiry, now),
      )) {
        throw new PlatformError("access_denied", "Requested service scope is not actively granted", { status: 403 });
      }
    }
    return this.#persist({
      actorIdentityId: context.identityId,
      subjectIdentityId: serviceIdentityId,
      kind: "service",
      displayName: safeDisplayName(displayName),
      scopes: normalizedScopes,
      expiresAt: boundedExpiry,
    });
  }

  async authenticate({ secret, permission, resource = { kind: "appliance", key: "*" } }) {
    const requested = normalizeScope({
      permissionKey: permission,
      resourceKind: resource?.kind,
      resourceKey: resource?.key,
    });
    if (typeof secret !== "string" || !TOKEN_PATTERN.test(secret)) {
      await this.#emit("credential.authentication_failed", { reason: "malformed", success: false });
      throw new PlatformError("invalid_credential", "Credential is invalid or expired", { status: 401 });
    }
    const credential = await this.#repository.findCredentialByHash(this.#hash(secret));
    const now = this.#clock();
    const unavailable = !credential || credential.revokedAt || new Date(credential.expiresAt) <= now;
    if (unavailable) {
      await this.#emit("credential.authentication_failed", {
        credentialId: credential?.id ?? null,
        reason: credential?.revokedAt ? "revoked" : credential ? "expired" : "unknown",
        success: false,
      });
      throw new PlatformError("invalid_credential", "Credential is invalid or expired", { status: 401 });
    }
    const principal = await this.#repository.loadPrincipalAccess(credential.subjectIdentityId);
    const credentialAllows = credential.scopes.some((scope) => scopeCovers(scope, requested));
    const principalAllows = principal?.status === "active"
      && permissionGranted(principal, permission, resource, now);
    const remainsDeveloper = credential.kind !== "developer"
      || (principal?.identityKind === "local_user"
        && permissionGranted(principal, "developer_credential:create", { kind: "appliance", key: "*" }, now));
    if (!credentialAllows || !principalAllows || !remainsDeveloper) {
      await this.#emit("credential.authentication_failed", {
        credentialId: credential.id,
        subjectIdentityId: credential.subjectIdentityId,
        reason: principal?.status !== "active" ? "identity_unavailable" : "scope_denied",
        success: false,
      });
      throw new PlatformError("access_denied", "Credential does not permit this operation", { status: 403 });
    }
    await this.#repository.touchCredential(credential.id, now);
    await this.#emit("credential.authenticated", {
      credentialId: credential.id,
      subjectIdentityId: credential.subjectIdentityId,
      credentialKind: credential.kind,
      permission,
      resourceKind: resource.kind,
      success: true,
    });
    return Object.freeze({
      identityId: credential.subjectIdentityId,
      identityKind: principal.identityKind,
      credentialId: credential.id,
      credentialKind: credential.kind,
      permissions: Object.freeze([permission]),
      permission,
      resource: Object.freeze({ ...resource }),
    });
  }

  async listCredentials({ context, subjectIdentityId = context?.identityId }) {
    if (!context?.identityId) throw new PlatformError("invalid_session", "Session is invalid", { status: 401 });
    if (subjectIdentityId !== context.identityId) {
      await this.#requireActorPermission(context, "service_credential:manage");
    } else {
      await this.#loadActivePrincipal(context.identityId);
    }
    const records = await this.#repository.listCredentialsForSubject(subjectIdentityId);
    return Object.freeze(records.map(publicCredential));
  }

  async revokeCredential({ context, credentialId, reason = "revoked_by_user" }) {
    if (!context?.identityId) throw new PlatformError("invalid_session", "Session is invalid", { status: 401 });
    const credential = await this.#repository.findCredentialById(credentialId);
    if (!credential) throw new PlatformError("credential_not_found", "Credential was not found", { status: 404 });
    if (credential.subjectIdentityId !== context.identityId) {
      await this.#requireActorPermission(context, "service_credential:manage");
    } else {
      await this.#loadActivePrincipal(context.identityId);
    }
    const revokeReason = safeRevokeReason(reason);
    const revoked = await this.#repository.revokeCredential(credentialId, this.#clock(), revokeReason);
    await this.#emit("credential.revoked", {
      credentialId,
      actorIdentityId: context.identityId,
      subjectIdentityId: credential.subjectIdentityId,
      credentialKind: credential.kind,
      reason: revokeReason,
      success: revoked,
    });
    return Object.freeze({ credentialId, revoked });
  }
}

export const credentialPolicyDefaults = DEFAULT_POLICY;
