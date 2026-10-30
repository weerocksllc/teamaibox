import assert from "node:assert/strict";
import test from "node:test";

import { matchesOperationsHttpRoute, OperationsHttpApi } from "../src/operations/operations-http-api.mjs";

const NODE = "018f6f18-24d7-7c21-9b62-8c0174199502";

test("operations route exposes only this appliance and removes node selectors", async () => {
  const calls = [], context = { identityId: NODE };
  const api = new OperationsHttpApi({ service: { async getDashboard(input) { calls.push(["dashboard", input]); return { cluster: {} }; }, async getNode(input) { calls.push(["node", input]); return { node: {} }; } } });
  assert.equal(matchesOperationsHttpRoute("GET", "/api/v1/admin/appliance"), true);
  assert.equal(matchesOperationsHttpRoute("POST", "/api/v1/admin/appliance"), false);
  assert.equal((await api.handle({ method: "GET", pathname: "/api/v1/admin/appliance", context })).status, 200);
  assert.equal(matchesOperationsHttpRoute("GET", `/api/v1/admin/operations/nodes/${NODE}`), false);
  assert.equal(matchesOperationsHttpRoute("GET", "/api/v1/admin/operations/dashboard"), false);
  assert.equal(calls.length, 1);
});

test("operations routes expose gated health, correlation, export, and retention actions", async () => {
  const calls = [], context = { identityId: NODE }, correlationId = "request-diagnostic-12345678";
  const diagnostics = {
    async getHealth(input) { calls.push(["health", input]); return { data: [] }; },
    async getAlerts(input) { calls.push(["alerts", input]); return { data: [] }; },
    async getCorrelation(input) { calls.push(["correlation", input]); return { signals: [] }; },
    async exportDiagnostics(input) { calls.push(["export", input]); return { exportId: NODE }; },
    async runRetention(input) { calls.push(["retention", input]); return { deleted: {} }; },
  };
  const api = new OperationsHttpApi({ diagnostics });
  assert.equal(matchesOperationsHttpRoute("GET", "/api/v1/admin/operations/health"), true);
  assert.equal(matchesOperationsHttpRoute("POST", "/api/v1/admin/operations/diagnostic-exports"), true);
  assert.equal((await api.handle({ method: "GET", pathname: "/api/v1/admin/operations/alerts", query: new URLSearchParams("status=resolved"), context })).status, 200);
  await api.handle({ method: "GET", pathname: `/api/v1/admin/operations/correlations/${correlationId}`, context });
  assert.equal(calls.at(-1)[1].correlationId, correlationId);
  await api.handle({ method: "GET", pathname: "/api/v1/admin/operations/correlations/request%3Adiagnostic-12345678", context });
  assert.equal(calls.at(-1)[1].correlationId, "request:diagnostic-12345678");
  assert.equal((await api.handle({ method: "POST", pathname: "/api/v1/admin/operations/diagnostic-exports", body: { correlationId }, context })).status, 201);
  assert.equal((await api.handle({ method: "POST", pathname: "/api/v1/admin/operations/retention/run", body: {}, context })).status, 200);
  assert.equal(calls[0][1].status, "resolved");
  await api.handle({ method: "GET", pathname: "/api/v1/admin/operations/alerts", query: new URLSearchParams("limit=37&cursor=next-alert"), context });
  assert.equal(calls.at(-1)[1].limit, 37); assert.equal(calls.at(-1)[1].cursor, "next-alert");
  await api.handle({ method: "GET", pathname: `/api/v1/admin/operations/correlations/${correlationId}`, query: new URLSearchParams("limit=38&cursor=next-correlation"), context });
  assert.equal(calls.at(-1)[1].limit, 38); assert.equal(calls.at(-1)[1].cursor, "next-correlation");
});
