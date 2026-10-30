import assert from "node:assert/strict";
import { test } from "node:test";

import { authorizationFromBootstrap } from "../src/authorization/browser-context.mjs";
import { administratorNavigation, visibleNavigation } from "../src/authorization/view-policy.mjs";

test("browser authorization fails closed without server bootstrap", () => {
  assert.deepEqual(authorizationFromBootstrap(undefined), { identityKind: null, permissions: [] });
  assert.deepEqual(authorizationFromBootstrap({ identityKind: "local_user", permissions: "node:view" }), { identityKind: null, permissions: [] });
  assert.deepEqual(authorizationFromBootstrap({ identityKind: "service_account", permissions: ["node:view"] }), { identityKind: null, permissions: [] });
});

test("new API permission keys do not hide existing administrator navigation", () => {
  const known = ["identity:view", "node:view", "role:view", "operations:view"];
  const before = authorizationFromBootstrap({ identityKind: "local_user", permissions: known });
  const after = authorizationFromBootstrap({ identityKind: "local_user", permissions: [...known, "future-media:use", "root:anything"] });
  assert.deepEqual(after, before);
  assert.deepEqual(visibleNavigation(administratorNavigation, after), visibleNavigation(administratorNavigation, before));
  assert.ok(visibleNavigation(administratorNavigation, after).length > 0);
  assert.deepEqual(authorizationFromBootstrap({ identityKind: "local_user", permissions: ["root:anything"] }).permissions, []);
});

test("malformed permissions still reject the entire bootstrap without granting access", () => {
  for (const permission of [null, 1, {}, "", "node:*", "node:view ", "Node:view", "node::view"]) {
    assert.deepEqual(authorizationFromBootstrap({ identityKind: "local_user", permissions: ["node:view", permission] }),
      { identityKind: null, permissions: [] });
  }
});

test("browser authorization accepts only registered, deduplicated permissions", () => {
  assert.deepEqual(
    authorizationFromBootstrap({ identityKind: "local_user", permissions: ["node:view", "model:view", "node:view"] }),
    { identityKind: "local_user", permissions: ["model:view", "node:view"] },
  );
});

test("explicit development preview can show the complete owner surface", () => {
  assert.ok(authorizationFromBootstrap(undefined, { developmentFallback: true }).permissions.length > 30);
});
