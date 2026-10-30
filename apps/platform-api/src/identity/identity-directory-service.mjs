import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function publicIdentity(identity) {
  return Object.freeze({
    id: identity.id,
    username: identity.loginName,
    displayName: identity.displayName,
  });
}

function isVisibleTeamMember(identity) {
  const loginName = String(identity?.loginName ?? "").toLowerCase();
  return !loginName.startsWith("catalog-");
}

function requireDirectoryPermission(context) {
  if (!context?.identityId) throw new PlatformError("invalid_session", "Authentication is required", { status: 401 });
  if (!context.permissions?.includes("team:view")) {
    throw new PlatformError("access_denied", "Team directory access is denied", { status: 403 });
  }
}

export class IdentityDirectoryService {
  #repository;
  constructor({ repository }) {
    if (!repository?.publicIdentitiesByIds || !repository?.listPublicIdentities || !repository?.searchPublicIdentities) {
      throw new TypeError("Identity directory repository is incomplete");
    }
    this.#repository = repository;
  }
  async byIds({ context, identityIds }) {
    requireDirectoryPermission(context);
    if (!Array.isArray(identityIds) || identityIds.some((id) => !UUID.test(id))) {
      throw new PlatformError("identity_query_invalid", "Identity query is invalid", { status: 400 });
    }
    return Object.freeze((await this.#repository.publicIdentitiesByIds([...new Set(identityIds)]))
      .filter(isVisibleTeamMember).map(publicIdentity));
  }
  async list({ context, limit, after = 0 }) {
    requireDirectoryPermission(context);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(after) || after < 0) {
      throw new PlatformError("identity_query_invalid", "Identity query is invalid", { status: 400 });
    }
    return Object.freeze((await this.#repository.listPublicIdentities(limit, after))
      .filter(isVisibleTeamMember).map(publicIdentity));
  }
  async search({ context, query, limit }) {
    requireDirectoryPermission(context);
    const normalized = typeof query === "string" ? query.normalize("NFKC").trim() : "";
    if (!normalized || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new PlatformError("identity_query_invalid", "Identity query is invalid", { status: 400 });
    }
    return Object.freeze((await this.#repository.searchPublicIdentities(normalized, limit))
      .filter(isVisibleTeamMember).map(publicIdentity));
  }
}
