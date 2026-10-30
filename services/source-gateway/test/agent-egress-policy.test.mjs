import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AgentEgressAuthorizer } from "../src/agent-egress-policy.mjs";

const SANDBOX = "018f6f18-24d7-7c21-9b62-8c017419958b";
const POLICY = JSON.parse(await readFile(new URL("../../../deploy/agent/egress-policy.v1.json", import.meta.url), "utf8"));

test("general Internet remains disabled while internal package repository access remains enabled", async () => {
  const audits = [];
  const authorizer = new AgentEgressAuthorizer({
    policy: POLICY,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    audit: async (event) => audits.push(event),
  });
  assert.equal(POLICY.packageRepositories.enabled, true);
  assert.equal(POLICY.packageRepositories.mode, "internal-only");
  await assert.rejects(authorizer.authorize({ sandboxId: SANDBOX, hostname: "example.com", port: 443, protocol: "https:" }), { code: "agent_egress_denied" });
  assert.equal(audits[0].reason, "administrator_policy");
});

test("enabled Internet permits only exact administrator hosts with public DNS results", async () => {
  const policy = structuredClone(POLICY);
  policy.generalInternet.enabled = true;
  policy.generalInternet.allowedHosts = ["api.example.com"];
  let resolution = [{ address: "93.184.216.34", family: 4 }];
  const authorizer = new AgentEgressAuthorizer({ policy, resolve: async () => resolution });
  const allowed = await authorizer.authorize({ sandboxId: SANDBOX, hostname: "api.example.com", port: 443, protocol: "https:" });
  assert.equal(allowed.address, "93.184.216.34");
  await assert.rejects(authorizer.authorize({ sandboxId: SANDBOX, hostname: "other.example.com", port: 443, protocol: "https:" }), { code: "agent_egress_denied" });
  resolution = [{ address: "169.254.169.254", family: 4 }];
  await assert.rejects(authorizer.authorize({ sandboxId: SANDBOX, hostname: "api.example.com", port: 443, protocol: "https:" }), { code: "agent_egress_resolution_denied" });
});
