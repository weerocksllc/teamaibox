import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRoutingPolicyRepository } from "../src/memory-routing-policy-repository.mjs";
import { RoutingPolicyRegistry } from "../src/routing-policy-registry.mjs";

const uuid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const context = { identityId: uuid(1), permissions: ["provider:view", "provider:manage"] };
const NOW = new Date("2026-08-11T12:00:00Z");
function declaration(overrides = {}) { return { policyKey: "overflow.default", displayName: "Default overflow", selector: {}, priority: 100, routing: { mode: "internal_first", externalProcessingApproved: true }, enabled: true, ...structuredClone(overrides) }; }
function fixture() { let next = 10; const repository = new MemoryRoutingPolicyRepository(); return { repository, registry: new RoutingPolicyRegistry({ repository, clock: () => NOW, idFactory: () => uuid(next++) }) }; }

test("administrator creates a revisioned explicit routing policy", async () => {
  const { registry } = fixture();
  const created = await registry.create({ context, declaration: declaration() });
  assert.equal(created.routing.mode, "internal_first");
  assert.equal(created.routing.allowExternal, true);
  assert.equal(created.revision, 1);
  const updated = await registry.update({ context, policyId: created.policyId, expectedRevision: 1, declaration: { routing: { mode: "external_first" } } });
  assert.equal(updated.routing.mode, "external_first");
  assert.equal(updated.revision, 2);
});

test("resolution uses the most specific matching scope before priority and defaults internal-only", async () => {
  const { registry } = fixture();
  await registry.create({ context, declaration: declaration({ policyKey: "broad.high", priority: 10_000 }) });
  await registry.create({ context, declaration: declaration({ policyKey: "team.specific", priority: 1, selector: { teamId: uuid(2), capabilityId: uuid(3), operation: "responses", dataClasses: ["internal"] }, routing: { mode: "pinned", pinnedTargetId: "provider-a", externalProcessingApproved: true } }) });
  const selected = await registry.resolve({ capabilityId: uuid(3), operation: "responses", teamId: uuid(2), dataClass: "internal" });
  assert.equal(selected.policyKey, "team.specific");
  assert.equal(selected.mode, "pinned");
  const fallback = await registry.resolve({ capabilityId: uuid(4), operation: "ocr", teamId: uuid(5), dataClass: "restricted" });
  assert.equal(fallback.policyKey, "broad.high");
  const empty = new RoutingPolicyRegistry({ repository: new MemoryRoutingPolicyRepository() });
  assert.equal((await empty.resolve({ capabilityId: uuid(4), operation: "ocr", teamId: null, dataClass: "restricted" })).mode, "internal_only");
});

test("invalid pins, weights, selectors, revisions, and member access fail closed", async () => {
  const { registry } = fixture();
  await assert.rejects(() => registry.create({ context, declaration: declaration({ routing: { mode: "pinned" } }) }), { code: "routing_policy_invalid" });
  await assert.rejects(() => registry.create({ context, declaration: declaration({ routing: { mode: "weighted", targetWeights: { "provider-a": -1 } } }) }), { code: "routing_policy_invalid" });
  await assert.rejects(() => registry.create({ context, declaration: declaration({ selector: { dataClasses: ["secret"] } }) }), { code: "routing_policy_invalid" });
  const created = await registry.create({ context, declaration: declaration() });
  await assert.rejects(() => registry.update({ context, policyId: created.policyId, expectedRevision: 2, declaration: {} }), { code: "routing_policy_revision_conflict" });
  await assert.rejects(() => registry.list({ context: { identityId: uuid(2), permissions: [] } }), { code: "access_denied" });
});
