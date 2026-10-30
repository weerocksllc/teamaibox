import assert from "node:assert/strict";
import { test } from "node:test";

import {
  administratorNavigation,
  isVisible,
  personalSettingsNavigation,
  routeBoundary,
  visibleNavigation,
} from "../src/authorization/view-policy.mjs";
import {
  grantedPermissions,
  principalFromRoleKeys,
} from "../../../packages/authorization/src/index.mjs";

function contextFor(roleKey) {
  const principal = principalFromRoleKeys({
    id: roleKey,
    status: "active",
    identityKind: "local_user",
  }, [roleKey]);
  return { permissions: grantedPermissions({ principal }) };
}

test("ordinary members see no administrator navigation or route", () => {
  const context = contextFor("member");
  assert.deepEqual(visibleNavigation(administratorNavigation, context), []);
  assert.deepEqual(routeBoundary(administratorNavigation[3], context), {
    allowed: false,
    redirectTo: "/forbidden",
  });
});

test("ordinary personal settings omit API keys while authorized developers see credentials", () => {
  assert.deepEqual(visibleNavigation(personalSettingsNavigation, contextFor("member")), []);
  assert.deepEqual(visibleNavigation(personalSettingsNavigation, contextFor("guest")), []);
  assert.deepEqual(
    visibleNavigation(personalSettingsNavigation, contextFor("developer")).map((item) => item.id),
    ["developer-credentials"],
  );
  assert.equal(personalSettingsNavigation.some((item) => item.id.includes("api-key")), false);
});

test("domain administrators see only matching administrator navigation", () => {
  assert.deepEqual(
    visibleNavigation(administratorNavigation, contextFor("compute_admin")).map((item) => item.id),
    ["device", "phones", "computers", "models", "queues", "providers", "audit"],
  );
  assert.deepEqual(
    visibleNavigation(administratorNavigation, contextFor("application_admin")).map((item) => item.id),
    ["plugins", "audit"],
  );
  assert.deepEqual(
    visibleNavigation(administratorNavigation, contextFor("system_admin")).map((item) => item.id),
    ["users", "roles", "device", "phones", "computers", "storage", "sources", "encryption", "updates", "audit"],
  );
  assert.deepEqual(
    visibleNavigation(administratorNavigation, contextFor("team_admin")).map((item) => item.id),
    ["team"],
  );
});

test("owner sees the complete administrator navigation", () => {
  assert.equal(visibleNavigation(administratorNavigation, contextFor("owner")).length, administratorNavigation.length);
});

test("plugin navigation fails closed on unknown permission declarations", () => {
  const untrustedItem = { id: "unsafe", href: "/plugins/unsafe", requiredPermissions: ["root:anything"] };
  assert.equal(isVisible(untrustedItem, contextFor("owner")), false);
});

test("nested plugin categories retain only authorized application entries", () => {
  const navigation = [{
    id: "ai-applications",
    requiredPermissions: [],
    children: [
      { id: "assistant", href: "/apps/assistant", requiredPermissions: ["ai:invoke"] },
      { id: "model-reports", href: "/apps/model-reports", requiredPermissions: ["model:manage"] },
    ],
  }];
  assert.deepEqual(
    visibleNavigation(navigation, contextFor("member"))[0].children.map((item) => item.id),
    ["assistant"],
  );
});
