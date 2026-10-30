import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertPermissionKey,
  evaluateAuthorization,
  grantedPermissions,
  permissionKeys,
  principalFromRoleKeys,
  roles,
} from "../src/index.mjs";

const identity = { id: "user-1", status: "active", identityKind: "local_user" };

test("keeps every role permission inside the closed permission catalog", () => {
  for (const role of Object.values(roles)) {
    for (const permission of role.permissions) assert.ok(permissionKeys.includes(permission));
  }
  assert.throws(() => assertPermissionKey("root:anything"), /unknown permission/);
});

test("owner spans registered appliance permissions but domain administrators do not", () => {
  const owner = principalFromRoleKeys(identity, ["owner"]);
  assert.equal(grantedPermissions({ principal: owner }).length, permissionKeys.length);

  const compute = principalFromRoleKeys(identity, ["compute_admin"]);
  assert.equal(evaluateAuthorization({ principal: compute, permission: "model:manage" }).allowed, true);
  assert.equal(evaluateAuthorization({ principal: compute, permission: "operations:manage" }).allowed, true);
  assert.equal(evaluateAuthorization({ principal: compute, permission: "diagnostic_sensitive:view" }).allowed, false);
  assert.equal(evaluateAuthorization({ principal: compute, permission: "plugin:manage" }).allowed, false);
  assert.equal(evaluateAuthorization({ principal: compute, permission: "cast:manage" }).allowed, true);

  const application = principalFromRoleKeys(identity, ["application_admin"]);
  assert.equal(evaluateAuthorization({ principal: application, permission: "plugin:manage" }).allowed, true);
  assert.equal(evaluateAuthorization({ principal: application, permission: "queue:manage" }).allowed, false);
});

test("team roles are limited to their exact team scope", () => {
  const principal = {
    ...identity,
    roleBindings: [{ roleKey: "team_admin", scopeKind: "team", scopeKey: "team-a" }],
  };
  assert.equal(evaluateAuthorization({
    principal,
    permission: "team:manage",
    resource: { kind: "team", key: "team-a" },
  }).allowed, true);
  assert.equal(evaluateAuthorization({
    principal,
    permission: "team:manage",
    resource: { kind: "team", key: "team-b" },
  }).allowed, false);
  assert.equal(evaluateAuthorization({ principal, permission: "queue:manage" }).allowed, false);
  assert.equal(evaluateAuthorization({
    principal, permission: "file:share", resource: { kind: "team", key: "team-a" },
  }).allowed, true);
  assert.equal(evaluateAuthorization({
    principal, permission: "cast:share", resource: { kind: "team", key: "team-a" },
  }).allowed, true);
});

test("member and guest capabilities are intentionally different", () => {
  const member = principalFromRoleKeys(identity, ["member"]);
  const guest = principalFromRoleKeys(identity, ["guest"]);
  assert.equal(evaluateAuthorization({ principal: member, permission: "ai:invoke" }).allowed, true);
  assert.equal(evaluateAuthorization({ principal: guest, permission: "ai:invoke" }).allowed, false);
  assert.equal(evaluateAuthorization({ principal: guest, permission: "file:read" }).allowed, true);
  assert.equal(evaluateAuthorization({ principal: guest, permission: "file:write" }).allowed, false);
  assert.equal(evaluateAuthorization({ principal: member, permission: "file:share" }).allowed, false);
  assert.equal(evaluateAuthorization({ principal: member, permission: "cast:use" }).allowed, true);
  assert.equal(evaluateAuthorization({ principal: member, permission: "cast:view" }).allowed, true);
  assert.equal(evaluateAuthorization({ principal: member, permission: "cast:share" }).allowed, false);
  assert.equal(evaluateAuthorization({ principal: guest, permission: "cast:view" }).allowed, true);
  assert.equal(evaluateAuthorization({ principal: guest, permission: "cast:use" }).allowed, false);
});

test("cast management never implies silent viewing", () => {
  const administrator = principalFromRoleKeys(identity, ["system_admin"]);
  assert.equal(evaluateAuthorization({
    principal: administrator, permission: "cast:manage",
  }).allowed, true);
  assert.equal(evaluateAuthorization({
    principal: administrator, permission: "cast:view",
  }).allowed, false);
});

test("only explicitly authorized developers can create personal credentials", () => {
  const member = principalFromRoleKeys(identity, ["member"]);
  const developer = principalFromRoleKeys(identity, ["developer"]);
  assert.equal(evaluateAuthorization({
    principal: member, permission: "developer_credential:create",
  }).allowed, false);
  assert.equal(evaluateAuthorization({
    principal: developer, permission: "developer_credential:create",
  }).allowed, true);
  assert.equal(evaluateAuthorization({
    principal: developer, permission: "service_credential:manage",
  }).allowed, false);
});

test("service accounts have only exact unexpired grants", () => {
  const principal = {
    id: "service-1",
    identityKind: "service_account",
    status: "active",
    roleBindings: [{ roleKey: "owner", scopeKind: "appliance", scopeKey: "*" }],
    serviceGrants: [{
      permissionKey: "ai:invoke",
      resourceKind: "team",
      resourceKey: "team-a",
      expiresAt: "2026-08-11T00:00:00.000Z",
    }],
  };
  const now = new Date("2026-08-10T00:00:00.000Z");
  assert.equal(evaluateAuthorization({
    principal, permission: "ai:invoke", resource: { kind: "team", key: "team-a" }, now,
  }).allowed, true);
  assert.equal(evaluateAuthorization({
    principal, permission: "ai:invoke", resource: { kind: "team", key: "team-b" }, now,
  }).allowed, false);
  assert.equal(evaluateAuthorization({
    principal, permission: "ai:invoke", resource: { kind: "team", key: "team-a" },
    now: new Date("2026-08-12T00:00:00.000Z"),
  }).allowed, false);
  assert.equal(evaluateAuthorization({ principal, permission: "identity:manage", now }).allowed, false);
});

test("revoked service-account grants fail closed", () => {
  const principal = {
    id: "service-revoked",
    identityKind: "service_account",
    status: "active",
    serviceGrants: [{
      permissionKey: "ai:invoke",
      resourceKind: "appliance",
      resourceKey: "*",
      expiresAt: "2026-08-11T00:00:00.000Z",
      revokedAt: "2026-08-10T00:30:00.000Z",
    }],
  };
  assert.equal(evaluateAuthorization({
    principal,
    permission: "ai:invoke",
    now: new Date("2026-08-10T00:00:00.000Z"),
  }).allowed, false);
});

test("disabled and unknown principals receive no access", () => {
  const disabled = principalFromRoleKeys({ ...identity, status: "disabled" }, ["owner"]);
  assert.equal(evaluateAuthorization({ principal: disabled, permission: "identity:view" }).allowed, false);
  assert.equal(evaluateAuthorization({ principal: null, permission: "identity:view" }).allowed, false);
});
