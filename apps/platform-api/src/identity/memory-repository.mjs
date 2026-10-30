import { randomUUID } from "node:crypto";
import { IdentityRepositoryError } from "./repository-error.mjs";

export { IdentityRepositoryError } from "./repository-error.mjs";

function copy(value) {
  return value === null ? null : structuredClone(value);
}

function advancedCounter(state, now, windowMs) {
  if (!state || now.getTime() - state.windowStartedAt.getTime() >= windowMs) {
    return { failures: 0, windowStartedAt: new Date(now), blockedUntil: null };
  }
  return { ...state };
}

export class MemoryIdentityRepository {
  #identities = new Map();
  #loginToId = new Map();
  #sessions = new Map();
  #accountFailures = new Map();
  #networkFailures = new Map();
  #recoveryCodes = new Map();
  #teams = new Map();
  #bootstrapped = false;

  constructor() {
    this.#teams.set("team.default", {
      id: "00000000-0000-7000-8000-000000000001",
      teamKey: "team.default",
      displayName: "Default team",
      status: "active",
      systemTeam: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      memberships: new Map(),
    });
  }

  async bootstrapState() {
    const owner = [...this.#identities.values()].find((candidate) => candidate.roles.includes("owner"));
    return {
      complete: this.#bootstrapped,
      ownerIdentityId: this.#bootstrapped ? owner?.id ?? null : null,
    };
  }

  async bootstrapOwner({ loginName, normalizedLoginName, displayName, passwordHash, recoveryCodeHashes, now }) {
    if (this.#bootstrapped || this.#identities.size !== 0) {
      throw new IdentityRepositoryError("bootstrap_complete", "Appliance owner bootstrap is complete");
    }
    const identity = {
      id: randomUUID(),
      identityKind: "local_user",
      loginName,
      normalizedLoginName,
      displayName,
      passwordHash,
      passwordVersion: 1,
      status: "active",
      disabledAt: null,
      preferredLocale: "zh-CN",
      preferredLocaleExplicit: false,
      preferredTheme: "system",
      roles: ["owner"],
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
    this.#identities.set(identity.id, identity);
    this.#loginToId.set(normalizedLoginName, identity.id);
    this.#teams.get("team.default").memberships.set(identity.id, "team_admin");
    this.#replaceRecoveryCodes(identity.id, recoveryCodeHashes, now);
    this.#bootstrapped = true;
    return copy(identity);
  }

  async insertIdentity(identity) {
    if (this.#loginToId.has(identity.normalizedLoginName)) throw new IdentityRepositoryError("identity_exists", "Identity already exists");
    const value = {
      identityKind: "local_user",
      passwordVersion: 1,
      status: "active",
      disabledAt: null,
      preferredLocale: "zh-CN",
      preferredLocaleExplicit: false,
      preferredTheme: "system",
      roles: ["member"],
      createdAt: new Date(),
      updatedAt: new Date(),
      ...copy(identity),
      id: identity.id ?? randomUUID(),
    };
    this.#identities.set(value.id, value);
    this.#loginToId.set(value.normalizedLoginName, value.id);
    this.#teams.get("team.default").memberships.set(value.id, "member");
    return copy(value);
  }

  async listTeams() {
    return [...this.#teams.values()].map((team) => ({
      id: team.id, teamKey: team.teamKey, displayName: team.displayName,
      status: team.status, systemTeam: team.systemTeam,
      createdAt: new Date(team.createdAt), updatedAt: new Date(team.updatedAt),
      members: [...team.memberships].map(([identityId, roleKey]) => ({
        identity: copy(this.#identities.get(identityId)), roleKey,
      })).filter((item) => item.identity),
    }));
  }

  async listTeamMemberships(identityId) {
    return [...this.#teams.values()].flatMap((team) => {
      const roleKey = team.memberships.get(identityId);
      return roleKey ? [{ teamId: team.id, teamKey: team.teamKey, teamDisplayName: team.displayName, roleKey }] : [];
    });
  }

  async setTeamMembership({ teamId, identityId, roleKey, granted, at }) {
    const team = [...this.#teams.values()].find((item) => item.id === teamId);
    if (!team) throw new IdentityRepositoryError("team_not_found", "Team not found");
    const identity = this.#identities.get(identityId);
    if (!identity) throw new IdentityRepositoryError("identity_not_found", "Identity not found");
    const present = team.memberships.get(identityId);
    if (!granted && present === undefined) return { team: (await this.listTeams()).find((item) => item.id === teamId), changed: false };
    if (granted && present === roleKey) return { team: (await this.listTeams()).find((item) => item.id === teamId), changed: false };
    if (present === "team_admin" && (!granted || roleKey !== "team_admin")
      && [...team.memberships.values()].filter((item) => item === "team_admin").length <= 1) {
      throw new IdentityRepositoryError("last_team_admin", "The last team administrator cannot be removed");
    }
    if (granted) team.memberships.set(identityId, roleKey); else team.memberships.delete(identityId);
    team.updatedAt = new Date(at);
    return { team: (await this.listTeams()).find((item) => item.id === teamId), changed: true };
  }

  async findByNormalizedLogin(loginName) {
    const id = this.#loginToId.get(loginName);
    return copy(id ? this.#identities.get(id) : null);
  }

  async findIdentity(identityId) {
    return copy(this.#identities.get(identityId) ?? null);
  }

  async listIdentities(limit, { offset = 0, query = "" } = {}) {
    return [...this.#identities.values()]
      .filter((item) => item.identityKind === "local_user"
        && `${item.loginName}\n${item.displayName}`.toLowerCase().includes(query.toLowerCase()))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()
        || left.loginName.localeCompare(right.loginName))
      .slice(offset, offset + limit)
      .map(copy);
  }

  async identitySummary(query = "") {
    const all = [...this.#identities.values()].filter((item) => item.identityKind === "local_user");
    return {
      total: all.length,
      active: all.filter((item) => item.status === "active").length,
      owners: all.filter((item) => item.status === "active" && item.roles.includes("owner")).length,
      matching: all.filter((item) => `${item.loginName}\n${item.displayName}`.toLowerCase().includes(query.toLowerCase())).length,
    };
  }

  async listAuthorizationRoles() {
    const { roles } = await import("../../../../packages/authorization/src/index.mjs");
    return Object.values(roles).map((role) => ({
      roleKey: role.key,
      displayNameKey: `roles.${role.key}.name`,
      descriptionKey: `roles.${role.key}.description`,
      systemRole: true,
      allowedScopes: [...role.allowedScopes],
      permissions: [...role.permissions],
      bindingCount: [...this.#identities.values()].filter((identity) => identity.roles.includes(role.key)).length,
    }));
  }

  async setRoleBinding({ identityId, roleKey, granted, at }) {
    const { roles } = await import("../../../../packages/authorization/src/index.mjs");
    const identity = this.#identities.get(identityId);
    if (!identity) throw new IdentityRepositoryError("identity_not_found", "Identity not found");
    if (!roles[roleKey]) throw new IdentityRepositoryError("role_not_found", "Role not found");
    const present = identity.roles.includes(roleKey);
    if (present === granted) return { identity: copy(identity), changed: false };
    if (!granted && roleKey === "owner") {
      const activeOwners = [...this.#identities.values()].filter((candidate) => candidate.status === "active" && candidate.roles.includes("owner"));
      if (identity.status === "active" && activeOwners.length <= 1) throw new IdentityRepositoryError("last_owner", "The last active owner role cannot be revoked");
    }
    if (!granted && identity.roles.length <= 1) throw new IdentityRepositoryError("role_last_binding", "An identity must retain at least one role");
    identity.roles = granted ? [...identity.roles, roleKey].sort() : identity.roles.filter((item) => item !== roleKey);
    identity.updatedAt = new Date(at);
    return { identity: copy(identity), changed: true };
  }

  async publicIdentitiesByIds(identityIds) {
    const selected = new Set(identityIds);
    return [...this.#identities.values()]
      .filter((identity) => selected.has(identity.id) && identity.identityKind === "local_user" && identity.status === "active")
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id))
      .map(copy);
  }

  async listPublicIdentities(limit, after = 0) {
    return [...this.#identities.values()]
      .filter((identity) => identity.identityKind === "local_user" && identity.status === "active")
      .filter(identity => !identity.loginName.toLowerCase().startsWith("catalog-"))
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id))
      .slice(after, after + limit)
      .map(copy);
  }

  async searchPublicIdentities(query, limit) {
    const needle = query.toLocaleLowerCase("en-US");
    return [...this.#identities.values()]
      .filter((identity) => identity.identityKind === "local_user" && identity.status === "active"
        && `${identity.displayName}\n${identity.loginName}`.toLocaleLowerCase("en-US").includes(needle))
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(copy);
  }

  async networkThrottle(networkHash, now) {
    const state = this.#networkFailures.get(networkHash);
    return state?.blockedUntil && state.blockedUntil > now ? copy(state) : null;
  }

  async accountThrottle(identityId, now) {
    const state = this.#accountFailures.get(identityId);
    return state?.blockedUntil && state.blockedUntil > now ? copy(state) : null;
  }

  async recordFailedLogin(identityId, networkHash, now, policy) {
    const network = advancedCounter(this.#networkFailures.get(networkHash), now, policy.failureWindowMs);
    network.failures += 1;
    if (network.failures >= policy.networkFailureLimit) {
      network.blockedUntil = new Date(now.getTime() + policy.networkBlockMs);
    }
    this.#networkFailures.set(networkHash, network);

    let account = null;
    if (identityId) {
      account = advancedCounter(this.#accountFailures.get(identityId), now, policy.failureWindowMs);
      account.failures += 1;
      if (account.failures >= policy.accountFailureLimit) {
        account.blockedUntil = new Date(now.getTime() + policy.accountLockMs);
      }
      this.#accountFailures.set(identityId, account);
    }
    return { network: copy(network), account: copy(account) };
  }

  async clearFailedLogins(identityId, networkHash, now) {
    this.#accountFailures.delete(identityId);
    this.#networkFailures.set(networkHash, {
      failures: 0,
      windowStartedAt: new Date(now),
      blockedUntil: null,
    });
    const identity = this.#identities.get(identityId);
    if (identity) identity.lastAuthenticatedAt = new Date(now);
  }

  async createSession(session) {
    if (this.#sessions.has(session.tokenHash)) throw new IdentityRepositoryError("session_collision", "Session collision");
    this.#sessions.set(session.tokenHash, copy(session));
  }

  async findSession(tokenHash) {
    const session = this.#sessions.get(tokenHash);
    if (!session) return null;
    return {
      session: copy(session),
      identity: copy(this.#identities.get(session.identityId) ?? null),
    };
  }

  async touchSession(tokenHash, at, idleExpiresAt) {
    const session = this.#sessions.get(tokenHash);
    if (!session || session.revokedAt) return false;
    session.lastSeenAt = new Date(at);
    session.idleExpiresAt = new Date(idleExpiresAt);
    return true;
  }

  async revokeSession(tokenHash, at, reason) {
    const session = this.#sessions.get(tokenHash);
    if (!session || session.revokedAt) return false;
    session.revokedAt = new Date(at);
    session.revokeReason = reason;
    return true;
  }

  async revokeIdentitySessions(identityId, at, reason) {
    let count = 0;
    for (const session of this.#sessions.values()) {
      if (session.identityId === identityId && !session.revokedAt) {
        session.revokedAt = new Date(at);
        session.revokeReason = reason;
        count += 1;
      }
    }
    return count;
  }

  async disableIdentity(identityId, at) {
    const identity = this.#identities.get(identityId);
    if (!identity) throw new IdentityRepositoryError("identity_not_found", "Identity not found");
    if (identity.roles.includes("owner")) {
      const activeOwners = [...this.#identities.values()].filter((candidate) =>
        candidate.status === "active" && candidate.roles.includes("owner"),
      );
      if (activeOwners.length <= 1) throw new IdentityRepositoryError("last_owner", "The last active owner cannot be disabled");
    }
    identity.status = "disabled";
    identity.disabledAt = new Date(at);
    identity.updatedAt = new Date(at);
    await this.revokeIdentitySessions(identityId, at, "account_disabled");
    return copy(identity);
  }

  async enableIdentity(identityId, at) {
    const identity = this.#identities.get(identityId);
    if (!identity) throw new IdentityRepositoryError("identity_not_found", "Identity not found");
    identity.status = "active";
    identity.disabledAt = null;
    identity.updatedAt = new Date(at);
    this.#accountFailures.delete(identityId);
    return copy(identity);
  }

  async resetIdentityPassword(identityId, passwordHash, at) {
    const identity = this.#identities.get(identityId);
    if (!identity) throw new IdentityRepositoryError("identity_not_found", "Identity not found");
    identity.passwordHash = passwordHash;
    identity.passwordVersion += 1;
    identity.updatedAt = new Date(at);
    this.#accountFailures.delete(identityId);
    await this.revokeIdentitySessions(identityId, at, "administrator_password_reset");
    return copy(identity);
  }

  async updatePreferredLocale(identityId, preferredLocale, at) {
    const identity = this.#identities.get(identityId);
    if (!identity) throw new IdentityRepositoryError("identity_not_found", "Identity not found");
    identity.preferredLocale = preferredLocale;
    identity.preferredLocaleExplicit = true;
    identity.updatedAt = new Date(at);
    return copy(identity);
  }

  async updatePreferredTheme(identityId, preferredTheme, at) {
    const identity = this.#identities.get(identityId);
    if (!identity) throw new IdentityRepositoryError("identity_not_found", "Identity not found");
    identity.preferredTheme = preferredTheme;
    identity.updatedAt = new Date(at);
    return copy(identity);
  }

  #replaceRecoveryCodes(identityId, recoveryCodeHashes, now) {
    for (const [hash, record] of this.#recoveryCodes) {
      if (record.identityId === identityId) this.#recoveryCodes.delete(hash);
    }
    for (const hash of recoveryCodeHashes) {
      this.#recoveryCodes.set(hash, {
        identityId,
        createdAt: new Date(now),
        usedAt: null,
      });
    }
  }

  async replaceRecoveryCodes(identityId, recoveryCodeHashes, now) {
    const identity = this.#identities.get(identityId);
    if (!identity || !identity.roles.includes("owner")) throw new IdentityRepositoryError("owner_required", "Recovery codes require an owner");
    this.#replaceRecoveryCodes(identityId, recoveryCodeHashes, now);
  }

  async recoverOwner({ codeHash, passwordHash, replacementCodeHashes, now }) {
    const record = this.#recoveryCodes.get(codeHash);
    if (!record || record.usedAt) throw new IdentityRepositoryError("invalid_recovery_code", "Recovery code is invalid");
    const identity = this.#identities.get(record.identityId);
    if (!identity || !identity.roles.includes("owner")) throw new IdentityRepositoryError("invalid_recovery_code", "Recovery code is invalid");
    identity.passwordHash = passwordHash;
    identity.passwordVersion += 1;
    identity.status = "active";
    identity.disabledAt = null;
    identity.updatedAt = new Date(now);
    this.#accountFailures.delete(identity.id);
    await this.revokeIdentitySessions(identity.id, now, "owner_recovery");
    this.#replaceRecoveryCodes(identity.id, replacementCodeHashes, now);
    return copy(identity);
  }
}
