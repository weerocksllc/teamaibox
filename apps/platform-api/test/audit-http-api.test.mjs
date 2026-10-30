import assert from "node:assert/strict";
import test from "node:test";

import { AuditHttpApi, matchesAuditHttpRoute } from "../src/audit/audit-http-api.mjs";

test("audit HTTP API exposes bounded read and verification routes only", async () => {
  const calls = [], service = {
    async listEvents(input) { calls.push(["list", input]); return { object: "list", data: [] }; },
    async verifyChain(input) { calls.push(["verify", input]); return { valid: true }; },
  };
  const api = new AuditHttpApi({ service }), context = { identityId: "018f6f18-24d7-7c21-9b62-8c017419958b", permissions: ["audit:view"] };
  const events = await api.handle({ method: "GET", pathname: "/api/v1/admin/audit/events", context, query: new URLSearchParams("domain=provider&correlationId=request-audit-12345678&cursor=42&limit=25") });
  assert.equal(events.status, 200); assert.equal(calls[0][1].domain, "provider"); assert.equal(calls[0][1].correlationId, "request-audit-12345678"); assert.equal(calls[0][1].cursor, "42"); assert.equal(calls[0][1].limit, "25");
  const verified = await api.handle({ method: "GET", pathname: "/api/v1/admin/audit/verify", context });
  assert.equal(verified.body.valid, true);
  assert.equal(matchesAuditHttpRoute("POST", "/api/v1/admin/audit/verify"), false);
});
