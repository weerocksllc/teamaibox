import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  grantedPermissions,
  principalFromRoleKeys,
} from "../../../../packages/authorization/src/index.mjs";
import { PlatformError } from "../../../../packages/observability/src/index.mjs";
import { PasswordHasher } from "./password.mjs";
import { IdentityRepositoryError } from "./repository-error.mjs";

const LOGIN = /^[a-z][a-z0-9._-]{2,63}$/;
const DEFAULT_POLICY = Object.freeze({
  absoluteSessionMs: 12 * 60 * 60 * 1000,
  idleSessionMs: 30 * 60 * 1000,
  sessionTouchMs: 60 * 1000,
  failureWindowMs: 15 * 60 * 1000,
  accountFailureLimit: 5,
  accountLockMs: 15 * 60 * 1000,
  networkFailureLimit: 20,
  networkBlockMs: 15 * 60 * 1000,
  recoveryCodeCount: 8,
});

function normalizedLogin(value) {
  if (typeof value !== "string") throw new PlatformError("invalid_credentials", "Invalid login or password", { status: 401 });
  const login = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (!LOGIN.test(login)) throw new PlatformError("invalid_credentials", "Invalid login or password", { status: 401 });
  return login;
}

function safeDisplayName(value) {
  if (typeof value !== "string") throw new PlatformError("invalid_display_name", "Display name is invalid", { status: 400 });
  const name = value.normalize("NFC").trim();
  if ([...name].length < 1 || [...name].length > 128 || /\p{Cc}/u.test(name)) {
    throw new PlatformError("invalid_display_name", "Display name is invalid", { status: 400 });
  }
  return name;
}

function opaque(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value);
}

function publicIdentity(identity) {
  return {
    id: identity.id,
    identityKind: identity.identityKind,
    loginName: identity.loginName,
    displayName: identity.displayName,
    status: identity.status,
    roles: [...identity.roles],
    preferredLocale: identity.preferredLocale ?? "zh-CN",
    preferredLocaleExplicit: identity.preferredLocaleExplicit === true,
    preferredTheme: identity.preferredTheme ?? "system",
  };
}

function generateRecoveryCodes(count) {
  return Array.from({ length: count }, () => "taib-recovery-" + opaque(24));
}

function requirePermission(context, permission) {
  if (!context?.permissions?.includes(permission)) {
    throw new PlatformError("access_denied", "Permission denied", { status: 403 });
  }
}

export class LocalAuthentication {
  #repository;
  #hasher;
  #dummyHash;
  #audit;
  #clock;
  #policy;
  #recoveryAuthority;

  static async create({
    repository,
    hasher = new PasswordHasher(),
    audit = async () => {},
    clock = () => new Date(),
    policy = {},
    recoveryAuthority = { verify: async () => false },
  }) {
    if (!repository) throw new TypeError("identity repository is required");
    const dummyHash = await hasher.hash("dummy authentication passphrase", {
      loginName: "nobody",
      displayName: "Nobody",
    });
    return new LocalAuthentication({
      repository,
      hasher,
      dummyHash,
      audit,
      clock,
      policy: Object.freeze({ ...DEFAULT_POLICY, ...policy }),
      recoveryAuthority,
    });
  }

  constructor({ repository, hasher, dummyHash, audit, clock, policy, recoveryAuthority }) {
    this.#repository = repository;
    this.#hasher = hasher;
    this.#dummyHash = dummyHash;
    this.#audit = audit;
    this.#clock = clock;
    this.#policy = policy;
    this.#recoveryAuthority = recoveryAuthority;
  }

  async #emit(action, fields = {}) {
    await this.#audit({ action, occurredAt: this.#clock().toISOString(), ...fields });
  }

  async bootstrapState() {
    if (typeof this.#repository.bootstrapState !== "function") {
      throw new TypeError("identity repository does not expose bootstrap state");
    }
    const state = await this.#repository.bootstrapState();
    return Object.freeze({ required: state.complete !== true });
  }

  async bootstrapOwner({ loginName, displayName, password }) {
    const normalized = normalizedLogin(loginName);
    const shownName = safeDisplayName(displayName);
    const passwordHash = await this.#hasher.hash(password, { loginName: normalized, displayName: shownName });
    const recoveryCodes = generateRecoveryCodes(this.#policy.recoveryCodeCount);
    try {
      const identity = await this.#repository.bootstrapOwner({
        loginName: normalized,
        normalizedLoginName: normalized,
        displayName: shownName,
        passwordHash,
        recoveryCodeHashes: recoveryCodes.map(digest),
        now: this.#clock(),
      });
      await this.#emit("auth.owner_bootstrapped", { identityId: identity.id, success: true });
      return { identity: publicIdentity(identity), recoveryCodes };
    } catch (error) {
      recoveryCodes.fill("[INVALIDATED]");
      await this.#emit("auth.owner_bootstrapped", { success: false, reason: error.code ?? "failed" });
      if (error instanceof IdentityRepositoryError && error.code === "bootstrap_complete") {
        throw new PlatformError("bootstrap_complete", "Appliance owner bootstrap is already complete", { status: 409 });
      }
      throw error;
    }
  }

  async signIn({ loginName, password, networkIdentifier, userAgent = "" }) {
    const now = this.#clock();
    const normalized = normalizedLogin(loginName);
    if (typeof password !== "string" || [...password].length > 256) {
      throw new PlatformError("invalid_credentials", "Invalid login or password", { status: 401 });
    }
    const networkHash = digest(String(networkIdentifier ?? "unknown"));
    if (await this.#repository.networkThrottle(networkHash, now)) {
      await this.#emit("auth.sign_in", { success: false, reason: "network_throttled" });
      throw new PlatformError("authentication_throttled", "Too many authentication attempts", { status: 429, retryable: true });
    }
    const identity = await this.#repository.findByNormalizedLogin(normalized);
    const validPassword = await this.#hasher.verify(password, identity?.passwordHash ?? this.#dummyHash);
    const accountThrottle = identity ? await this.#repository.accountThrottle(identity.id, now) : null;
    if (!identity || !validPassword || identity.status !== "active" || accountThrottle) {
      const outcome = await this.#repository.recordFailedLogin(identity?.id ?? null, networkHash, now, this.#policy);
      const reason = !identity || !validPassword
        ? "invalid_credentials"
        : identity.status !== "active" ? "account_unavailable" : "account_throttled";
      await this.#emit("auth.sign_in", {
        identityId: identity?.id ?? null,
        success: false,
        reason,
        accountLocked: Boolean(outcome.account?.blockedUntil),
        networkBlocked: Boolean(outcome.network?.blockedUntil),
      });
      throw new PlatformError("invalid_credentials", "Invalid login or password", { status: 401 });
    }

    await this.#repository.clearFailedLogins(identity.id, networkHash, now);
    const sessionToken = opaque();
    const csrfToken = opaque();
    const session = {
      id: randomUUID(),
      identityId: identity.id,
      tokenHash: digest(sessionToken),
      csrfHash: digest(csrfToken),
      passwordVersion: identity.passwordVersion,
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: new Date(now.getTime() + this.#policy.idleSessionMs),
      expiresAt: new Date(now.getTime() + this.#policy.absoluteSessionMs),
      userAgentHash: digest(String(userAgent).slice(0, 1024)),
      networkHash,
      revokedAt: null,
      revokeReason: null,
    };
    await this.#repository.createSession(session);
    await this.#emit("auth.sign_in", { identityId: identity.id, sessionId: session.id, success: true });
    return {
      identity: publicIdentity(identity),
      sessionToken,
      csrfToken,
      expiresAt: session.expiresAt.toISOString(),
      idleExpiresAt: session.idleExpiresAt.toISOString(),
    };
  }

  async authenticateSession({ sessionToken, csrfToken = null, requireCsrf = false }) {
    if (!safeToken(sessionToken) || (requireCsrf && !safeToken(csrfToken))) {
      throw new PlatformError("invalid_session", "Session is invalid or expired", { status: 401 });
    }
    const tokenHash = digest(sessionToken);
    const record = await this.#repository.findSession(tokenHash);
    const now = this.#clock();
    const invalid = !record
      || !record.identity
      || record.session.revokedAt
      || record.identity.status !== "active"
      || record.identity.passwordVersion !== record.session.passwordVersion
      || record.session.expiresAt <= now
      || record.session.idleExpiresAt <= now;
    if (invalid) throw new PlatformError("invalid_session", "Session is invalid or expired", { status: 401 });
    if (requireCsrf) {
      const actual = Buffer.from(digest(csrfToken), "hex");
      const expected = Buffer.from(record.session.csrfHash, "hex");
      const valid = actual.length === expected.length && timingSafeEqual(actual, expected);
      actual.fill(0);
      expected.fill(0);
      if (!valid) throw new PlatformError("csrf_failed", "Request verification failed", { status: 403 });
    }
    if (now.getTime() - record.session.lastSeenAt.getTime() >= this.#policy.sessionTouchMs) {
      const idleExpiresAt = new Date(Math.min(
        record.session.expiresAt.getTime(),
        now.getTime() + this.#policy.idleSessionMs,
      ));
      await this.#repository.touchSession(tokenHash, now, idleExpiresAt);
    }
    const principal = principalFromRoleKeys(record.identity, record.identity.roles);
    const teamMemberships = typeof this.#repository.listTeamMemberships === "function"
      ? await this.#repository.listTeamMemberships(record.identity.id) : [];
    const teamRoles = Object.freeze(Object.fromEntries(teamMemberships.map((membership) => [
      membership.teamKey,
      membership.roleKey === "team_admin" ? "manager" : membership.roleKey,
    ])));
    return {
      identity: publicIdentity(record.identity),
      identityId: record.identity.id,
      roles: [...record.identity.roles],
      sessionId: record.session.id,
      permissions: grantedPermissions({ principal, now }),
      teamMemberships: Object.freeze(teamMemberships.map((membership) => Object.freeze({ ...membership }))),
      teamRoles,
    };
  }

  async signOut(sessionToken) {
    if (!safeToken(sessionToken)) return;
    const tokenHash = digest(sessionToken);
    const record = await this.#repository.findSession(tokenHash);
    await this.#repository.revokeSession(tokenHash, this.#clock(), "user_sign_out");
    await this.#emit("auth.sign_out", {
      identityId: record?.identity?.id ?? null,
      sessionId: record?.session?.id ?? null,
      success: true,
    });
  }

  async disableAccount(identityId, context) {
    requirePermission(context, "identity:manage");
    try {
      const identity = await this.#repository.disableIdentity(identityId, this.#clock());
      await this.#emit("auth.account_disabled", { identityId, actorIdentityId: context.identityId, success: true });
      return publicIdentity(identity);
    } catch (error) {
      await this.#emit("auth.account_disabled", { identityId, actorIdentityId: context.identityId, success: false, reason: error.code ?? "failed" });
      if (error instanceof IdentityRepositoryError) {
        throw new PlatformError(error.code, error.message, { status: error.code === "identity_not_found" ? 404 : 409 });
      }
      throw error;
    }
  }

  async rotateRecoveryCodes(identityId, context) {
    requirePermission(context, "identity:manage");
    if (context.identityId !== identityId || !context.roles?.includes("owner")) {
      throw new PlatformError("access_denied", "Only the authenticated owner can rotate recovery codes", { status: 403 });
    }
    const recoveryCodes = generateRecoveryCodes(this.#policy.recoveryCodeCount);
    await this.#repository.replaceRecoveryCodes(identityId, recoveryCodes.map(digest), this.#clock());
    await this.#emit("auth.recovery_codes_rotated", { identityId, success: true });
    return recoveryCodes;
  }

  async recoverOwner({ recoveryCode, newPassword, localRecoveryChallenge, localRecoveryProof }) {
    if (!safeToken(String(recoveryCode).replace(/^taib-recovery-/, ""))) {
      throw new PlatformError("recovery_failed", "Owner recovery failed", { status: 401 });
    }
    if (!(await this.#recoveryAuthority.verify({ challenge: localRecoveryChallenge, proof: localRecoveryProof }))) {
      await this.#emit("auth.owner_recovery", { success: false, reason: "local_presence_denied" });
      throw new PlatformError("recovery_failed", "Owner recovery failed", { status: 401 });
    }
    const passwordHash = await this.#hasher.hash(newPassword);
    const replacementCodes = generateRecoveryCodes(this.#policy.recoveryCodeCount);
    try {
      const identity = await this.#repository.recoverOwner({
        codeHash: digest(recoveryCode),
        passwordHash,
        replacementCodeHashes: replacementCodes.map(digest),
        now: this.#clock(),
      });
      await this.#emit("auth.owner_recovery", { identityId: identity.id, success: true });
      return { identity: publicIdentity(identity), recoveryCodes: replacementCodes };
    } catch (error) {
      replacementCodes.fill("[INVALIDATED]");
      await this.#emit("auth.owner_recovery", { success: false, reason: "invalid_recovery_code" });
      throw new PlatformError("recovery_failed", "Owner recovery failed", { status: 401 });
    }
  }
}

export const authenticationPolicyDefaults = DEFAULT_POLICY;
