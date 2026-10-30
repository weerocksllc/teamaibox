import assert from "node:assert/strict";
import test from "node:test";

import { RoutingPolicyHttpApi } from "../src/providers/routing-policy-http-api.mjs";

const ID = "00000000-0000-4000-8000-000000000010";
test("routing policy HTTP API exposes revision-fenced administrator CRUD without a user route", async () => {
  const calls = [];
  const service = new Proxy({}, { get(_target, method) { return async (input) => { calls.push([method, input]); return { policyId: ID }; }; } });
  const api = new RoutingPolicyHttpApi({ service });
  const context = { identityId: ID, permissions: ["provider:view", "provider:manage"] };
  assert.equal(api.matches("GET", "/api/v1/admin/routing-policies"), true);
  assert.equal(api.matches("GET", "/api/v1/routing-policies"), false);
  assert.equal((await api.handle({ method: "GET", pathname: "/api/v1/admin/routing-policies", context })).status, 200);
  assert.equal((await api.handle({ method: "POST", pathname: "/api/v1/admin/routing-policies", body: { policyKey: "default" }, context })).status, 201);
  assert.equal((await api.handle({ method: "GET", pathname: `/api/v1/admin/routing-policies/${ID}`, context })).status, 200);
  assert.equal((await api.handle({ method: "PATCH", pathname: `/api/v1/admin/routing-policies/${ID}`, body: { expectedRevision: 1, declaration: { enabled: false } }, context })).status, 200);
  assert.deepEqual(calls.map(([method]) => method), ["list", "create", "get", "update"]);
  assert.equal(calls[3][1].expectedRevision, 1);
});
