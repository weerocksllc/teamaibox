import assert from "node:assert/strict";
import test from "node:test";

import { ProviderHttpApi } from "../src/providers/provider-http-api.mjs";

const ID = "00000000-0000-4000-8000-000000000010";

test("provider HTTP API exposes only authenticated administrator registry actions", async () => {
  const calls = [];
  const service = new Proxy({}, { get(_target, method) { return async (input) => { calls.push([method, input]); return { providerId: ID }; }; } });
  const api = new ProviderHttpApi({ service });
  const context = { identityId: ID, permissions: ["provider:view", "provider:manage"] };
  assert.equal(api.matches("GET", "/api/v1/admin/providers"), true);
  assert.equal(api.matches("DELETE", `/api/v1/admin/providers/${ID}`), true);
  assert.equal((await api.handle({ method: "GET", pathname: "/api/v1/admin/providers", context })).status, 200);
  assert.equal((await api.handle({ method: "POST", pathname: "/api/v1/admin/providers", body: { providerKey: "external.lab" }, context })).status, 201);
  assert.equal((await api.handle({ method: "GET", pathname: `/api/v1/admin/providers/${ID}`, context })).status, 200);
  assert.equal((await api.handle({ method: "POST", pathname: `/api/v1/admin/providers/${ID}/test`, body: { expectedRevision: 1 }, context })).status, 200);
  assert.equal((await api.handle({ method: "POST", pathname: `/api/v1/admin/providers/${ID}/enable`, body: { expectedRevision: 2 }, context })).status, 200);
  assert.equal((await api.handle({ method: "POST", pathname: `/api/v1/admin/providers/${ID}/disable`, body: { expectedRevision: 3 }, context })).status, 200);
  assert.equal((await api.handle({ method: "POST", pathname: `/api/v1/admin/providers/${ID}/credential/rotate`, body: { credential: "replacement" }, context })).status, 200);
  assert.equal((await api.handle({ method: "DELETE", pathname: `/api/v1/admin/providers/${ID}`, body: { expectedRevision: 4 }, context })).status, 200);
  assert.deepEqual(calls.map(([method]) => method), ["list", "create", "get", "testContract", "setEnabled", "setEnabled", "rotateCredential", "remove"]);
  assert.deepEqual(calls.slice(4, 6).map(([, input]) => input.enabled), [true, false]);
});
