import { PlatformError } from "../../../../packages/observability/src/index.mjs";
import {
  evaluateAuthorization,
  grantedPermissions,
} from "../../../../packages/authorization/src/index.mjs";

function publicRoles(principal) {
  if (principal.identityKind === "service_account") return [];
  return [...new Set((principal.roleBindings ?? []).map((binding) => binding.roleKey))].sort();
}

export class AuthorizationService {
  #repository;
  #audit;
  #clock;

  constructor({ repository, audit = async () => {}, clock = () => new Date() }) {
    if (!repository || typeof repository.loadPrincipalAccess !== "function") {
      throw new TypeError("authorization repository is required");
    }
    this.#repository = repository;
    this.#audit = audit;
    this.#clock = clock;
  }

  async accessContext({ identityId, resource }) {
    const principal = await this.#repository.loadPrincipalAccess(identityId);
    if (!principal || principal.status !== "active") {
      throw new PlatformError("invalid_session", "Session is invalid or expired", { status: 401 });
    }
    return Object.freeze({
      identityId: principal.id,
      identityKind: principal.identityKind,
      roles: Object.freeze(publicRoles(principal)),
      permissions: grantedPermissions({ principal, resource, now: this.#clock() }),
      resource: Object.freeze(resource ?? { kind: "appliance", key: "*" }),
    });
  }

  async require({ identityId, permission, resource, operation = permission }) {
    const principal = await this.#repository.loadPrincipalAccess(identityId);
    const decision = evaluateAuthorization({
      principal,
      permission,
      resource,
      now: this.#clock(),
    });
    if (!decision.allowed) {
      await this.#audit({
        action: "authorization.denied",
        occurredAt: this.#clock().toISOString(),
        actorIdentityId: principal?.id ?? identityId ?? null,
        actorKind: principal?.identityKind ?? "unknown",
        operation,
        permission,
        resourceKind: decision.resource.kind,
        resourceKey: decision.resource.key,
        reason: decision.reason,
        success: false,
      });
      throw new PlatformError("access_denied", "Permission denied", {
        status: 403,
        details: { permission, resourceKind: decision.resource.kind },
      });
    }
    return Object.freeze({
      identityId: principal.id,
      identityKind: principal.identityKind,
      roles: Object.freeze(publicRoles(principal)),
      permissions: grantedPermissions({ principal, resource, now: this.#clock() }),
      decision,
    });
  }
}

