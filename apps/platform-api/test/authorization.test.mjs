import assert from "node:assert/strict";
import { test } from "node:test";

import { AuthorizationService } from "../src/authorization/authorization-service.mjs";
import { MemoryAuthorizationRepository } from "../src/authorization/memory-repository.mjs";

function rolePrincipal(id, roleKey, scopeKind = "appliance", scopeKey = "*") {
  return {
    id,
    status: "active",
    identityKind: "local_user",
    roleBindings: [{ roleKey, scopeKind, scopeKey, expiresAt: null }],
    serviceGrants: [],
  };
}

test("API boundary permits only the matching administrative domain", async () => {
  const repository = new MemoryAuthorizationRepository([
    rolePrincipal("compute", "compute_admin"),
    rolePrincipal("apps", "application_admin"),
  ]);
  const authorization = new AuthorizationService({ repository });
  await authorization.require({ identityId: "compute", permission: "model:manage", operation: "models.place" });
  await assert.rejects(
    authorization.require({ identityId: "compute", permission: "plugin:manage", operation: "plugins.enable" }),
    (error) => error.code === "access_denied" && error.status === 403,
  );
  await authorization.require({ identityId: "apps", permission: "plugin:manage", operation: "plugins.enable" });
});

test("denied member administration is audited without granting by UI claims", async () => {
  const audit = [];
  const repository = new MemoryAuthorizationRepository([rolePrincipal("member", "member")]);
  const authorization = new AuthorizationService({ repository, audit: async (event) => audit.push(event) });
  await assert.rejects(
    authorization.require({
      identityId: "member",
      permission: "queue:manage",
      operation: "queues.update_policy",
      resource: { kind: "appliance", key: "*" },
    }),
    (error) => error.code === "access_denied",
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "authorization.denied");
  assert.equal(audit[0].operation, "queues.update_policy");
  assert.equal(audit[0].actorIdentityId, "member");
  assert.equal(audit[0].reason, "role_scope_denied");
});

test("API boundary re-evaluates exact team scope on every operation", async () => {
  const repository = new MemoryAuthorizationRepository([
    rolePrincipal("team-admin", "team_admin", "team", "alpha"),
  ]);
  const authorization = new AuthorizationService({ repository });
  await authorization.require({
    identityId: "team-admin",
    permission: "team:manage",
    resource: { kind: "team", key: "alpha" },
  });
  await assert.rejects(
    authorization.require({
      identityId: "team-admin",
      permission: "team:manage",
      resource: { kind: "team", key: "beta" },
    }),
    (error) => error.code === "access_denied",
  );
});

test("service-account roles are ignored and expired grants fail closed", async () => {
  let current = new Date("2026-08-10T00:00:00.000Z");
  const repository = new MemoryAuthorizationRepository([{
    id: "worker",
    status: "active",
    identityKind: "service_account",
    roleBindings: [{ roleKey: "owner", scopeKind: "appliance", scopeKey: "*" }],
    serviceGrants: [{
      permissionKey: "ai:invoke",
      resourceKind: "team",
      resourceKey: "alpha",
      expiresAt: "2026-08-10T01:00:00.000Z",
    }],
  }]);
  const authorization = new AuthorizationService({ repository, clock: () => new Date(current) });
  const context = await authorization.require({
    identityId: "worker",
    permission: "ai:invoke",
    resource: { kind: "team", key: "alpha" },
  });
  assert.deepEqual(context.roles, []);
  assert.deepEqual(context.permissions, ["ai:invoke"]);
  await assert.rejects(
    authorization.require({ identityId: "worker", permission: "identity:manage" }),
    (error) => error.code === "access_denied",
  );
  current = new Date("2026-08-10T01:00:00.000Z");
  await assert.rejects(
    authorization.require({
      identityId: "worker",
      permission: "ai:invoke",
      resource: { kind: "team", key: "alpha" },
    }),
    (error) => error.code === "access_denied",
  );
});

test("inactive principals cannot obtain an API access context", async () => {
  const principal = rolePrincipal("disabled", "owner");
  principal.status = "disabled";
  const authorization = new AuthorizationService({
    repository: new MemoryAuthorizationRepository([principal]),
  });
  await assert.rejects(
    authorization.accessContext({ identityId: "disabled" }),
    (error) => error.code === "invalid_session" && error.status === 401,
  );
});

