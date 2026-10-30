import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { SourceCenterHttpApi } from "../src/sources/source-center-http-api.mjs";

test("Source Center HTTP API exposes administrator overview, data planes, sources, health, and policies", async () => {
  const calls = [];
  const service = new Proxy({}, { get(_target, method) { return async (input) => { calls.push([method, input]); return method === "createSource" || method === "createPolicy" ? { id: randomUUID() } : { object: "list", data: [] }; }; } });
  const api = new SourceCenterHttpApi({ service, dataPlaneStatus: { getStatus: async () => ({ schemaVersion: 1, state: "ready" }) } });
  const context = { identityId: randomUUID(), permissions: ["source:view", "source:manage"] };
  const sourceId = randomUUID(), policyId = randomUUID();
  assert.equal(api.matches("GET", "/api/v1/admin/source-center/overview"), true);
  assert.equal((await api.handle({ method: "GET", pathname: "/api/v1/admin/source-center/overview", context })).status, 200);
  assert.equal((await api.handle({ method: "GET", pathname: "/api/v1/admin/source-center/data-planes", context })).body.state, "ready");
  assert.equal((await api.handle({ method: "POST", pathname: "/api/v1/admin/source-center/sources", body: { sourceKey: "pip.cache" }, context })).status, 201);
  assert.equal((await api.handle({ method: "PATCH", pathname: `/api/v1/admin/source-center/sources/${sourceId}`, body: { expectedRevision: 1, declaration: { enabled: false } }, context })).status, 200);
  assert.equal((await api.handle({ method: "POST", pathname: `/api/v1/admin/source-center/sources/${sourceId}/health`, body: { expectedRevision: 2, observation: { state: "healthy" } }, context })).status, 200);
  assert.equal((await api.handle({ method: "GET", pathname: "/api/v1/admin/source-center/policies", query: new URLSearchParams("ecosystem=pip"), context })).status, 200);
  assert.equal((await api.handle({ method: "PATCH", pathname: `/api/v1/admin/source-center/policies/${policyId}`, body: { expectedRevision: 1, declaration: { enabled: false } }, context })).status, 200);
  assert.deepEqual(calls.map(([method]) => method), ["overview", "overview", "createSource", "updateSource", "reportHealth", "listPolicies", "updatePolicy"]);
  assert.equal(calls[5][1].ecosystem, "pip");
});
