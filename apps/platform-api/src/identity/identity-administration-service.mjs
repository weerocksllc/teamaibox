import { PlatformError } from "../../../../packages/observability/src/index.mjs";
import { roles as authorizationRoles } from "../../../../packages/authorization/src/index.mjs";
import { PasswordHasher, PasswordPolicyError } from "./password.mjs";
import { IdentityRepositoryError } from "./repository-error.mjs";

const LOGIN = /^[a-z][a-z0-9._-]{2,63}$/;
const ROLE_KEY = /^[a-z][a-z0-9._-]{2,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizedLogin(value) {
  if (typeof value !== "string") {
    throw new PlatformError("identity_login_invalid", "Login name is invalid", { status: 400 });
  }
  const login = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (!LOGIN.test(login)) {
    throw new PlatformError("identity_login_invalid", "Login name is invalid", { status: 400 });
  }
  return login;
}

function safeDisplayName(value) {
  if (typeof value !== "string") {
    throw new PlatformError("invalid_display_name", "Display name is invalid", { status: 400 });
  }
  const displayName = value.normalize("NFC").trim();
  if ([...displayName].length < 1 || [...displayName].length > 128 || /\p{Cc}/u.test(displayName)) {
    throw new PlatformError("invalid_display_name", "Display name is invalid", { status: 400 });
  }
  return displayName;
}

function publicIdentity(identity) {
  return Object.freeze({
    id: identity.id,
    identityKind: identity.identityKind,
    loginName: identity.loginName,
    displayName: identity.displayName,
    status: identity.status,
    roles: Object.freeze([...identity.roles]),
    preferredLocale: identity.preferredLocale ?? "zh-CN",
    preferredTheme: identity.preferredTheme ?? "system",
    lastAuthenticatedAt: identity.lastAuthenticatedAt?.toISOString?.() ?? null,
    disabledAt: identity.disabledAt?.toISOString?.() ?? null,
    createdAt: identity.createdAt?.toISOString?.() ?? null,
    updatedAt: identity.updatedAt?.toISOString?.() ?? null,
  });
}

function publicTeam(team) {
  return Object.freeze({
    id: team.id,
    teamKey: team.teamKey,
    displayName: team.displayName,
    status: team.status,
    systemTeam: team.systemTeam === true,
    memberCount: team.members.length,
    members: Object.freeze(team.members.map((member) => Object.freeze({
      identity: publicIdentity(member.identity),
      roleKey: member.roleKey,
    }))),
    createdAt: team.createdAt?.toISOString?.() ?? null,
    updatedAt: team.updatedAt?.toISOString?.() ?? null,
  });
}

function repositoryFailure(error) {
  if (!(error instanceof IdentityRepositoryError)) throw error;
  const status = new Set(["identity_not_found", "role_not_found", "team_not_found"]).has(error.code) ? 404
    : error.code === "identity_exists" ? 409
      : 409;
  throw new PlatformError(error.code, error.message, { status });
}

function passwordFailure(error) {
  if (error instanceof PasswordPolicyError) {
    throw new PlatformError(error.code, error.message, { status: 400 });
  }
  throw error;
}

function sameValues(left, right) {
  return JSON.stringify([...new Set(left ?? [])].sort()) === JSON.stringify([...new Set(right ?? [])].sort());
}

function verifiedRoleInventory(values) {
  const expectedKeys = Object.keys(authorizationRoles).sort();
  const observedKeys = values.map((role) => role.roleKey).sort();
  const valid = sameValues(expectedKeys, observedKeys) && values.every((role) => {
    const expected = authorizationRoles[role.roleKey];
    return expected && role.systemRole === true
      && sameValues(role.allowedScopes, expected.allowedScopes)
      && sameValues(role.permissions, expected.permissions)
      && Number.isSafeInteger(role.bindingCount) && role.bindingCount >= 0;
  });
  if (!valid) {
    throw new PlatformError("role_policy_drift", "Durable role policy does not match the active authorization policy", { status: 503 });
  }
  return values;
}

export class IdentityAdministrationService {
  #repository;
  #hasher;
  #audit;
  #clock;

  constructor({
    repository,
    hasher = new PasswordHasher(),
    audit = async () => {},
    clock = () => new Date(),
  }) {
    const required = ["listIdentities", "insertIdentity", "disableIdentity", "enableIdentity", "resetIdentityPassword", "listAuthorizationRoles", "setRoleBinding", "listTeams", "setTeamMembership"];
    if (!repository || required.some((method) => typeof repository[method] !== "function")) {
      throw new TypeError("Identity administration repository is incomplete");
    }
    if (typeof hasher?.hash !== "function" || typeof audit !== "function" || typeof clock !== "function") {
      throw new TypeError("Identity administration dependencies are incomplete");
    }
    this.#repository = repository;
    this.#hasher = hasher;
    this.#audit = audit;
    this.#clock = clock;
  }

  async #requirePermission(context, permission, action, identityId = null) {
    if (!context?.identityId) {
      throw new PlatformError("invalid_session", "Authentication is required", { status: 401 });
    }
    if (!context.permissions?.includes(permission)) {
      await this.#audit({
        action,
        actorIdentityId: context.identityId,
        identityId,
        outcome: "denied",
        reasonCode: "access_denied",
      });
      throw new PlatformError("access_denied", "Permission denied", { status: 403 });
    }
  }

  async list({ context, limit = 200 }) {
    await this.#requirePermission(context, "identity:view", "identity.accounts_listed");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new PlatformError("identity_query_invalid", "Identity query is invalid", { status: 400 });
    }
    const identities = await this.#repository.listIdentities(limit);
    return Object.freeze(identities.map(publicIdentity));
  }

  async listPage({ context, limit = 50, offset = 0, query = "" }) {
    await this.#requirePermission(context, "identity:view", "identity.accounts_listed");
    return this.#directoryPage(limit, offset, query);
  }

  async #directoryPage(limit, offset, query) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
      || !Number.isSafeInteger(offset) || offset < 0 || typeof query !== "string") {
      throw new PlatformError("identity_query_invalid", "Identity query is invalid", { status: 400 });
    }
    const search = query.trim();
    const [identities, summary] = await Promise.all([
      this.#repository.listIdentities(limit, { offset, query: search }),
      this.#repository.identitySummary(search),
    ]);
    return Object.freeze({
      object: "list", data: Object.freeze(identities.map(publicIdentity)),
      summary: Object.freeze(summary), offset, limit,
      hasMore: offset + identities.length < summary.matching,
    });
  }

  async listRoles({ context, limit = 200, offset = 0, query = "" }) {
    await this.#requirePermission(context, "role:view", "authorization.roles_listed");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new PlatformError("role_query_invalid", "Role query is invalid", { status: 400 });
    }
    const [unverifiedRoles, page] = await Promise.all([
      this.#repository.listAuthorizationRoles(),
      this.#directoryPage(limit, offset, query),
    ]);
    const roleValues = verifiedRoleInventory(unverifiedRoles);
    return Object.freeze({
      roles: Object.freeze(roleValues.map((role) => Object.freeze({
        roleKey: role.roleKey,
        displayNameKey: role.displayNameKey,
        descriptionKey: role.descriptionKey,
        systemRole: role.systemRole === true,
        allowedScopes: Object.freeze([...role.allowedScopes]),
        permissions: Object.freeze([...role.permissions]),
        bindingCount: role.bindingCount,
      }))),
      identities: page.data,
      identityPage: Object.freeze({ offset, limit, hasMore: page.hasMore, total: page.summary.matching }),
    });
  }

  async setRole({ context, identityId, roleKey, granted }) {
    const action = granted === true ? "authorization.role_granted" : "authorization.role_revoked";
    await this.#requirePermission(context, "role:manage", action, identityId);
    try {
      if (!UUID.test(identityId ?? "") || !ROLE_KEY.test(roleKey ?? "") || typeof granted !== "boolean") {
        throw new PlatformError("role_binding_invalid", "Role binding request is invalid", { status: 400 });
      }
      const [unverifiedRoles, target] = await Promise.all([
        this.#repository.listAuthorizationRoles(),
        this.#repository.findIdentity(identityId),
      ]);
      const roleValues = verifiedRoleInventory(unverifiedRoles);
      if (!target) throw new PlatformError("identity_not_found", "Identity not found", { status: 404 });
      if (target.identityKind !== "local_user") throw new PlatformError("role_binding_invalid", "Appliance roles can only be assigned to local users", { status: 400 });
      const role = roleValues.find((item) => item.roleKey === roleKey && item.systemRole === true);
      if (!role) throw new PlatformError("role_not_found", "Role not found", { status: 404 });
      if (granted && role.permissions.some((permission) => !context.permissions.includes(permission))) {
        throw new PlatformError("role_escalation_forbidden", "A role cannot be granted beyond the actor's permissions", { status: 403 });
      }
      if (roleKey === "owner" && !context.roles?.includes("owner")) {
        throw new PlatformError("role_escalation_forbidden", "Only an owner can change the owner role", { status: 403 });
      }
      if (!granted && identityId === context.identityId && target.roles.includes(roleKey)) {
        const remaining = target.roles.filter((item) => item !== roleKey);
        const remainingPermissions = new Set(roleValues.filter((item) => remaining.includes(item.roleKey)).flatMap((item) => item.permissions));
        if (!remainingPermissions.has("role:manage")) {
          throw new PlatformError("role_self_lockout_forbidden", "The current session cannot remove its own role administration access", { status: 409 });
        }
      }
      const result = await this.#repository.setRoleBinding({
        identityId, roleKey, granted, actorIdentityId: context.identityId, at: this.#clock(),
      });
      await this.#audit({ action, actorIdentityId: context.identityId, identityId, outcome: "succeeded", roleKey, granted, changed: result.changed });
      return Object.freeze({ identity: publicIdentity(result.identity), roleKey, granted, changed: result.changed });
    } catch (error) {
      await this.#audit({ action, actorIdentityId: context.identityId, identityId, outcome: error.status === 403 ? "denied" : "failed", reasonCode: error.code ?? "failed", roleKey });
      if (error instanceof PlatformError) throw error;
      repositoryFailure(error);
    }
  }

  async listTeams({ context, limit = 200, offset = 0, query = "" }) {
    await this.#requirePermission(context, "team:manage", "team.teams_listed");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new PlatformError("team_query_invalid", "Team query is invalid", { status: 400 });
    }
    const [teams, page] = await Promise.all([
      this.#repository.listTeams(),
      this.#directoryPage(limit, offset, query),
    ]);
    return Object.freeze({
      teams: Object.freeze(teams.map(publicTeam)),
      identities: page.data,
      identityPage: Object.freeze({ offset, limit, hasMore: page.hasMore, total: page.summary.matching }),
      membershipRoles: Object.freeze(["team_admin", "member", "guest"]),
    });
  }

  async setTeamMembership({ context, teamId, identityId, roleKey, granted }) {
    const action = granted === true ? "team.member_added" : "team.member_removed";
    await this.#requirePermission(context, "team:manage", action, identityId);
    try {
      if (!UUID.test(teamId ?? "") || !UUID.test(identityId ?? "")
        || !new Set(["team_admin", "member", "guest"]).has(roleKey) || typeof granted !== "boolean") {
        throw new PlatformError("team_membership_invalid", "Team membership request is invalid", { status: 400 });
      }
      const target = await this.#repository.findIdentity(identityId);
      if (!target) throw new PlatformError("identity_not_found", "Identity not found", { status: 404 });
      if (target.identityKind !== "local_user") throw new PlatformError("team_membership_invalid", "Only local users can join a team", { status: 400 });
      const role = authorizationRoles[roleKey];
      if (!role?.allowedScopes.includes("team")) throw new PlatformError("role_not_found", "Role not found", { status: 404 });
      if (granted && role.permissions.some((permission) => !context.permissions.includes(permission))) {
        throw new PlatformError("role_escalation_forbidden", "A team role cannot be granted beyond the actor's permissions", { status: 403 });
      }
      const result = await this.#repository.setTeamMembership({
        teamId, identityId, roleKey, granted, actorIdentityId: context.identityId, at: this.#clock(),
      });
      await this.#audit({ action, actorIdentityId: context.identityId, identityId, teamId, roleKey, granted, changed: result.changed, outcome: "succeeded" });
      return Object.freeze({ team: publicTeam(result.team), identityId, roleKey, granted, changed: result.changed });
    } catch (error) {
      await this.#audit({ action, actorIdentityId: context.identityId, identityId, teamId, roleKey, outcome: error.status === 403 ? "denied" : "failed", reasonCode: error.code ?? "failed" });
      if (error instanceof PlatformError) throw error;
      repositoryFailure(error);
    }
  }

  async createLocalMember({ context, loginName, displayName, password }) {
    await this.#requirePermission(context, "identity:manage", "identity.local_member_created");
    try {
      const login = normalizedLogin(loginName);
      const shownName = safeDisplayName(displayName);
      const passwordHash = await this.#hasher.hash(password, { loginName: login, displayName: shownName });
      const identity = await this.#repository.insertIdentity({
        identityKind: "local_user",
        loginName: login,
        normalizedLoginName: login,
        displayName: shownName,
        passwordHash,
        roles: ["member"],
        createdAt: this.#clock(),
      });
      await this.#audit({
        action: "identity.local_member_created",
        actorIdentityId: context.identityId,
        identityId: identity.id,
        outcome: "succeeded",
        roleKeys: identity.roles,
      });
      return publicIdentity(identity);
    } catch (error) {
      await this.#audit({
        action: "identity.local_member_created",
        actorIdentityId: context.identityId,
        outcome: "failed",
        reasonCode: error.code ?? "failed",
      });
      if (error instanceof PasswordPolicyError) passwordFailure(error);
      repositoryFailure(error);
    }
  }

  async setStatus({ context, identityId, status }) {
    const action = status === "active" ? "identity.account_enabled" : "identity.account_disabled";
    await this.#requirePermission(context, "identity:manage", action, identityId);
    try {
      if (!new Set(["active", "disabled"]).has(status)) {
        throw new PlatformError("identity_status_invalid", "Identity status is invalid", { status: 400 });
      }
      if (status === "disabled" && identityId === context.identityId) {
        throw new PlatformError("identity_self_disable_forbidden", "The current account cannot disable itself", { status: 409 });
      }
      const identity = status === "disabled"
        ? await this.#repository.disableIdentity(identityId, this.#clock())
        : await this.#repository.enableIdentity(identityId, this.#clock());
      await this.#audit({
        action,
        actorIdentityId: context.identityId,
        identityId,
        outcome: "succeeded",
      });
      return publicIdentity(identity);
    } catch (error) {
      await this.#audit({
        action,
        actorIdentityId: context.identityId,
        identityId,
        outcome: "failed",
        reasonCode: error.code ?? "failed",
      });
      if (error instanceof PlatformError) throw error;
      repositoryFailure(error);
    }
  }

  async resetPassword({ context, identityId, password }) {
    await this.#requirePermission(context, "identity:manage", "identity.password_reset_by_administrator", identityId);
    try {
      const identity = await this.#repository.findIdentity(identityId);
      if (!identity) {
        throw new PlatformError("identity_not_found", "Identity not found", { status: 404 });
      }
      const passwordHash = await this.#hasher.hash(password, {
        loginName: identity.loginName,
        displayName: identity.displayName,
      });
      const updated = await this.#repository.resetIdentityPassword(identityId, passwordHash, this.#clock());
      await this.#audit({
        action: "identity.password_reset_by_administrator",
        actorIdentityId: context.identityId,
        identityId,
        outcome: "succeeded",
        sessionsRevoked: true,
      });
      return publicIdentity(updated);
    } catch (error) {
      await this.#audit({
        action: "identity.password_reset_by_administrator",
        actorIdentityId: context.identityId,
        identityId,
        outcome: "failed",
        reasonCode: error.code ?? "failed",
      });
      if (error instanceof PasswordPolicyError) passwordFailure(error);
      if (error instanceof PlatformError) throw error;
      repositoryFailure(error);
    }
  }
}
