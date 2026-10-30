import assert from "node:assert/strict";
import test from "node:test";

import { MaintenanceHttpApi, matchesMaintenanceHttpRoute } from "../src/updates/maintenance-http-api.mjs";

const PLAN = "018f6f18-24d7-7c21-9b62-8c0174199601", NODE = "018f6f18-24d7-7c21-9b62-8c0174199701";

test("maintenance HTTP API keeps preflight and execution as separate administrator operations", async () => {
  const calls = [], service = { async administration(input) { calls.push(["administration", input]); return { candidates: [], nodes: [], plans: [] }; },
    async prepare(input) { calls.push(["prepare", input]); return { planId: PLAN, state: "ready" }; }, async get(input) { calls.push(["get", input]); return { planId: input.planId }; },
    async execute(input) { calls.push(["execute", input]); return { planId: input.planId, state: "completed" }; } };
  const api = new MaintenanceHttpApi({ service }), context = { identityId: PLAN, permissions: ["update:view", "update:manage"] };
  assert.equal((await api.handle({ method: "GET", pathname: "/api/v1/admin/updates", context })).status, 200);
  const prepared = await api.handle({ method: "POST", pathname: "/api/v1/admin/updates/plans", context, body: { kind: "host", candidate_key: "host.2026-08", target_node_ids: [NODE], strategy: "single_node_downtime", downtime_acknowledged: true, revalidation_decision: "fence_and_revalidate", operation_key: "host-maintenance-0001" } });
  assert.equal(prepared.status, 201); assert.equal(calls[1][1].candidateKey, "host.2026-08"); assert.equal(calls[1][1].downtimeAcknowledged, true);
  assert.equal((await api.handle({ method: "GET", pathname: `/api/v1/admin/updates/plans/${PLAN}`, context })).body.planId, PLAN);
  const executed = await api.handle({ method: "POST", pathname: `/api/v1/admin/updates/plans/${PLAN}/execute`, context, body: { expected_revision: 1, confirmation: `APPLY ${PLAN}` } });
  assert.equal(executed.body.state, "completed"); assert.equal(calls[3][1].expectedRevision, 1);
  assert.equal(matchesMaintenanceHttpRoute("DELETE", `/api/v1/admin/updates/plans/${PLAN}`), false);
});
