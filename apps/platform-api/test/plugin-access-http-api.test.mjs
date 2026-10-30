import assert from "node:assert/strict";
import test from "node:test";

import { PluginAccessHttpApi } from "../src/plugins/plugin-access-http-api.mjs";

const pluginId = "example.team-notes";
const delegationId = "00000000-0000-4000-8000-000000001301";
const token = `taibp_v1_${Buffer.alloc(32, 7).toString("base64url")}`;

function fixture() {
  const calls = [];
  const api = new PluginAccessHttpApi({
    delegations: {
      async issue(input) { calls.push(["issue", input]); return { token, delegation: { delegationId, pluginId } }; },
      async revoke(input) { calls.push(["revoke", input]); return { delegationId, revoked: true }; },
      async authenticate(input) { calls.push(["authenticate", input]); return { identityId: delegationId,
        permission: "file:read", resource: input.resource, submittedByPluginId: pluginId }; },
    },
    dispatcher: { async invoke(input) { calls.push(["invoke", input]); return { object: "list", data: [] }; } },
  });
  return { api, calls };
}

test("user delegation issuance is distinct from delegated invocation", async () => {
  const { api, calls } = fixture();
  assert.equal(api.matches("POST", `/api/v1/plugins/${pluginId}/delegations`), true);
  assert.equal(api.routeKind("POST", `/api/v1/plugins/${pluginId}/delegations`), "user");
  const issued = await api.handle({ method: "POST", pathname: `/api/v1/plugins/${pluginId}/delegations`,
    context: { identityId: delegationId }, body: { grants: [{ scope: "files:read", resource: { kind: "team", key: "team.default" } }], ttlSeconds: 30 } });
  assert.equal(issued.status, 201);
  assert.equal(issued.body.token, token);
  assert.equal(calls[0][1].pluginId, pluginId);
  assert.equal(api.routeKind("POST", "/api/plugin/v1/invoke"), "delegated");
});

test("delegated invocation authenticates the exact bearer, plugin, scope, resource, then dispatches", async () => {
  const { api, calls } = fixture();
  const result = await api.handle({ method: "POST", pathname: "/api/plugin/v1/invoke",
    headers: { authorization: `Bearer ${token}`, "x-teamaibox-plugin-id": pluginId },
    body: { scope: "files:read", resource: { kind: "team", key: "team.default" }, operation: "files.list",
      body: { path: "/notes", pageSize: 50 } } });
  assert.deepEqual(result.body, { object: "list", data: [] });
  assert.equal(calls[0][0], "authenticate");
  assert.equal(calls[0][1].token, token);
  assert.equal(calls[1][0], "invoke");
  await assert.rejects(api.handle({ method: "POST", pathname: "/api/plugin/v1/invoke",
    headers: { authorization: "Bearer invalid", "x-teamaibox-plugin-id": pluginId },
    body: { scope: "files:read", resource: { kind: "team", key: "team.default" }, operation: "files.list" } }),
  (error) => error.code === "plugin_delegation_invalid" && error.status === 401);
  await assert.rejects(api.handle({ method: "POST", pathname: "/api/plugin/v1/invoke",
    headers: { authorization: `Bearer ${token}`, "x-teamaibox-plugin-id": "bad_plugin" },
    body: { scope: "files:read", resource: { kind: "team", key: "team.default" }, operation: "files.list" } }),
  (error) => error.code === "plugin_invoke_invalid" && error.status === 400);
});

test("a user can revoke only through the authenticated user route", async () => {
  const { api, calls } = fixture();
  const path = `/api/v1/plugin-delegations/${delegationId}`;
  assert.equal(api.matches("DELETE", path), true);
  assert.equal(api.routeKind("DELETE", path), "user");
  const result = await api.handle({ method: "DELETE", pathname: path, context: { identityId: delegationId } });
  assert.equal(result.body.revoked, true);
  assert.equal(calls[0][0], "revoke");
});
