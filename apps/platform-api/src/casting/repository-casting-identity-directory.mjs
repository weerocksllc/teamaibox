import { grantedPermissions, principalFromRoleKeys } from "../../../../packages/authorization/src/index.mjs";

function publicIdentity(value) {
  return value ? Object.freeze({ identityId: value.id, displayName: value.displayName,
    username: value.loginName, status: value.status }) : null;
}

/** Reads current account, role, and team facts instead of trusting cached session claims. */
export class RepositoryCastingIdentityDirectory {
  #repository;
  #clock;

  constructor({ repository, clock = () => new Date() }) {
    if (!repository?.findIdentity || !repository?.listTeamMemberships || !repository?.listTeams
      || typeof clock !== "function") throw new TypeError("casting identity directory dependencies are incomplete");
    this.#repository = repository;
    this.#clock = clock;
  }

  async authorization(identityId) {
    const identity = await this.#repository.findIdentity(identityId);
    if (!identity || identity.identityKind !== "local_user" || identity.status !== "active") return null;
    const teamMemberships = await this.#repository.listTeamMemberships(identityId);
    return Object.freeze({
      identity: publicIdentity(identity),
      identityId,
      permissions: grantedPermissions({
        principal: principalFromRoleKeys(identity, identity.roles),
        now: this.#clock(),
      }),
      teamMemberships: Object.freeze(teamMemberships.map((item) => Object.freeze({ ...item }))),
    });
  }

  async identity(identityId) { return publicIdentity(await this.#repository.findIdentity(identityId)); }

  async identities(identityIds) {
    return Object.freeze((await Promise.all([...new Set(identityIds)].map((id) => this.identity(id))))
      .filter((identity) => identity?.status === "active"));
  }

  async team(teamId) {
    const team = (await this.#repository.listTeams()).find((item) => item.id === teamId);
    if (!team) return null;
    return Object.freeze({ teamId: team.id, teamKey: team.teamKey, displayName: team.displayName,
      status: team.status, memberIdentityIds: Object.freeze(team.members.filter((item) => item.identity?.status === "active")
        .map((item) => item.identity.id)) });
  }
}
