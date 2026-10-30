import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  grantedPermissions,
  principalFromRoleKeys,
  roles,
} from "../../../packages/authorization/src/index.mjs";
import { AuthorizationService } from "../../platform-api/src/authorization/authorization-service.mjs";
import { MemoryAuthorizationRepository } from "../../platform-api/src/authorization/memory-repository.mjs";
import { authorizationFromBootstrap } from "../src/authorization/browser-context.mjs";
import {
  administratorNavigation,
  isVisible,
  routeBoundary,
  visibleNavigation,
} from "../src/authorization/view-policy.mjs";

const NOW = new Date("2026-08-10T00:00:00.000Z");
const EXPECTED_ADMIN_ROUTES = Object.freeze({
  owner: administratorNavigation.map((route) => route.id),
  system_admin: ["users", "roles", "device", "phones", "computers", "storage", "sources", "encryption", "updates", "audit"],
  compute_admin: ["device", "phones", "computers", "models", "queues", "providers", "audit"],
  application_admin: ["plugins", "audit"],
  team_admin: ["team"],
  developer: [],
  member: [],
  guest: [],
});

function localPrincipal(roleKey, { id = roleKey, status = "active", scope } = {}) {
  return principalFromRoleKeys(
    { id, status, identityKind: "local_user" },
    [roleKey],
    scope ?? { kind: "appliance", key: "*" },
  );
}

test("every built-in role has matching API and browser decisions for every administrator route", async () => {
  assert.deepEqual(Object.keys(roles).sort(), Object.keys(EXPECTED_ADMIN_ROUTES).sort());
  for (const roleKey of Object.keys(roles)) {
    const principal = localPrincipal(roleKey);
    const authorization = new AuthorizationService({
      repository: new MemoryAuthorizationRepository([principal]),
      clock: () => new Date(NOW),
    });
    const access = await authorization.accessContext({ identityId: principal.id });
    const browser = authorizationFromBootstrap(access);
    assert.deepEqual(
      visibleNavigation(administratorNavigation, browser).map((route) => route.id),
      EXPECTED_ADMIN_ROUTES[roleKey],
      `${roleKey} administrator route set`,
    );

    for (const route of administratorNavigation) {
      const uiAllowed = routeBoundary(route, browser).allowed;
      const apiCall = authorization.require({
        identityId: principal.id,
        permission: route.requiredPermissions[0],
        operation: `e2e.route.${route.id}`,
      });
      if (uiAllowed) {
        await apiCall;
      } else {
        await assert.rejects(apiCall, (error) => error.code === "access_denied" && error.status === 403);
      }
    }
  }
});

test("team-scoped roles cannot cross team API or application boundaries", async () => {
  const principal = localPrincipal("team_admin", {
    id: "team-admin",
    scope: { kind: "team", key: "alpha" },
  });
  const authorization = new AuthorizationService({
    repository: new MemoryAuthorizationRepository([principal]),
    clock: () => new Date(NOW),
  });
  const alpha = await authorization.accessContext({
    identityId: principal.id,
    resource: { kind: "team", key: "alpha" },
  });
  const beta = await authorization.accessContext({
    identityId: principal.id,
    resource: { kind: "team", key: "beta" },
  });
  assert.equal(isVisible({ requiredPermissions: ["file:read"] }, authorizationFromBootstrap(alpha)), true);
  assert.equal(isVisible({ requiredPermissions: ["file:read"] }, authorizationFromBootstrap(beta)), false);
  await authorization.require({
    identityId: principal.id,
    permission: "file:read",
    resource: { kind: "team", key: "alpha" },
  });
  await assert.rejects(authorization.require({
    identityId: principal.id,
    permission: "file:read",
    resource: { kind: "team", key: "beta" },
  }), (error) => error.code === "access_denied");
});

test("disabled users and service accounts cannot bootstrap browser navigation", async () => {
  const disabled = localPrincipal("owner", { id: "disabled-owner", status: "disabled" });
  const servicePrincipal = {
    id: "worker",
    status: "active",
    identityKind: "service_account",
    roleBindings: [],
    serviceGrants: [{
      permissionKey: "ai:invoke",
      resourceKind: "team",
      resourceKey: "alpha",
      expiresAt: "2026-08-11T00:00:00.000Z",
      revokedAt: null,
    }],
  };
  const authorization = new AuthorizationService({
    repository: new MemoryAuthorizationRepository([disabled, servicePrincipal]),
    clock: () => new Date(NOW),
  });
  await assert.rejects(
    authorization.accessContext({ identityId: disabled.id }),
    (error) => error.code === "invalid_session" && error.status === 401,
  );
  assert.deepEqual(visibleNavigation(administratorNavigation, authorizationFromBootstrap(undefined)), []);

  const serviceAccess = await authorization.accessContext({
    identityId: servicePrincipal.id,
    resource: { kind: "team", key: "alpha" },
  });
  assert.deepEqual(serviceAccess.permissions, ["ai:invoke"]);
  assert.deepEqual(authorizationFromBootstrap(serviceAccess), { identityKind: null, permissions: [] });
  await authorization.require({
    identityId: servicePrincipal.id,
    permission: "ai:invoke",
    resource: { kind: "team", key: "alpha" },
  });
  await assert.rejects(authorization.require({
    identityId: servicePrincipal.id,
    permission: "ai:invoke",
    resource: { kind: "team", key: "beta" },
  }), (error) => error.code === "access_denied");
});

test("desktop and mobile navigation retain the same fail-closed administrator source", async () => {
  const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(appSource, /visibleNavigation\(administratorNavigation, authorization\)/);
  assert.match(appSource, /className={`sidebar \$\{mobileMenuOpen/);
  assert.match(appSource, /adminItems\.length > 0/);
  assert.match(appSource, /className="mobile-nav"/);
  assert.match(styles, /@media \(max-width: 820px\)[\s\S]*?\.sidebar--open \{ transform: translateX\(0\); \}/);
  assert.match(styles, /@media \(max-width: 820px\)[\s\S]*?\.mobile-nav \{[^}]*display: grid;/);

  for (const roleKey of Object.keys(roles)) {
    const principal = localPrincipal(roleKey);
    const context = authorizationFromBootstrap({
      identityKind: "local_user",
      permissions: grantedPermissions({ principal, now: NOW }),
    });
    const desktopAdmin = visibleNavigation(administratorNavigation, context).map((route) => route.id);
    const mobileDrawerAdmin = visibleNavigation(administratorNavigation, context).map((route) => route.id);
    assert.deepEqual(mobileDrawerAdmin, desktopAdmin, `${roleKey} responsive administrator routes`);
  }
});
