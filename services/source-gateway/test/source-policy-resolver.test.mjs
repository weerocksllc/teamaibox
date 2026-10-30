import assert from "node:assert/strict";
import test from "node:test";

import { SourcePolicyResolver } from "../src/source-policy-resolver.mjs";

const SOURCE = "018f6f18-24d7-7c21-9b62-8c0174199501";
const base = { ecosystem: "pip", environment: "agent", enabled: true, offlineMode: "allow-online", sources: [{ sourceId: SOURCE, priority: 10 }], packageRules: [] };

test("source policy resolution prefers the most specific team and sandbox match and hydrates sources", async () => {
  const repository = {
    listPolicies: async () => [
      { ...base, policyId: "global", policyKey: "pip.global", selector: { teamKey: null, sandboxProfileKey: null, architecture: "all" } },
      { ...base, policyId: "team", policyKey: "pip.engineering", selector: { teamKey: "engineering", sandboxProfileKey: "python", architecture: "arm64" }, offlineMode: "prefer-offline" },
    ],
    findSource: async () => ({ sourceId: SOURCE, ecosystem: "pip", kind: "proxy-cache", packageScopes: ["*"], enabled: true }),
  };
  const result = await new SourcePolicyResolver({ repository }).resolve({ ecosystem: "pip", environment: "agent", architecture: "arm64", teamKey: "engineering", sandboxProfileKey: "python" });
  assert.equal(result.policyKey, "pip.engineering");
  assert.equal(result.offlineMode, "prefer-offline");
  assert.equal(result.sources[0].source.kind, "proxy-cache");
});

test("source policy resolution fails closed for missing and inconsistent routes", async () => {
  const empty = new SourcePolicyResolver({ repository: { listPolicies: async () => [], findSource: async () => null } });
  await assert.rejects(empty.resolve({ ecosystem: "pip", environment: "agent", architecture: "arm64" }), { code: "source_policy_unavailable" });
  const inconsistent = new SourcePolicyResolver({ repository: { listPolicies: async () => [{ ...base, policyKey: "pip.bad", selector: { teamKey: null, sandboxProfileKey: null, architecture: "arm64" } }], findSource: async () => null } });
  await assert.rejects(inconsistent.resolve({ ecosystem: "pip", environment: "agent", architecture: "arm64" }), { code: "source_policy_inconsistent" });
});
