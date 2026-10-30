import assert from "node:assert/strict";
import test from "node:test";

import { NodeAgentMaintenancePreflightInspector } from "../src/updates/node-agent-maintenance-preflight-inspector.mjs";

const PLAN = "018f6f18-24d7-7c21-9b62-8c0174199601";
const NODE_A = "018f6f18-24d7-7c21-9b62-8c0174199701";
const NODE_B = "018f6f18-24d7-7c21-9b62-8c0174199702";
const DIGEST = `sha256:${"a".repeat(64)}`;
const EVIDENCE = `sha256:${"b".repeat(64)}`;

function candidate(kind = "host", allowedSecureBootStates = ["enabled"]) {
  return { kind, digest: DIGEST, execution: { preflightRequirements: { expectedArchitecture: "arm64",
    minimumDockerApiVersion: "1.48", requireNvidiaContainerIntegration: true, allowedSecureBootStates } } };
}

function fixture(response = {}) {
  const calls = [];
  const inspector = new NodeAgentMaintenancePreflightInspector({
    localNodeId: NODE_A,
    nodeRepository: { async findNode(nodeId) { return { nodeId, generation: nodeId === NODE_A ? 7 : 9, lifecycleState: "ready" }; } },
    nodeAgentRouter: { async maintenancePreflight(input) { calls.push(structuredClone(input)); return { planId: PLAN,
      nodeId: input.nodeId, nodeGeneration: input.nodeGeneration, passed: true, blockers: [], warnings: ["managed_workloads_require_drain"],
      secureBootState: "enabled", nvidiaContainerIntegrationMode: "cdi", activeManagedWorkloads: 3,
      evidenceDigest: EVIDENCE, ...response[input.nodeId] }; } },
  });
  return { inspector, calls };
}

test("inspects only the local appliance without exposing transport or host facts", async () => {
  const value = fixture();
  const result = await value.inspector.inspect({ planId: PLAN, kind: "host", candidate: candidate(), targetNodes: [{ nodeId: NODE_A }] });
  assert.equal(result.passed, true);
  assert.equal(result.secureBootCompatible, true);
  assert.equal(result.runtimeCompatible, true);
  assert.deepEqual(result.warnings, ["managed_workloads_require_drain"]);
  assert.match(result.evidenceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(value.calls.map((item) => [item.nodeId, item.nodeGeneration]), [[NODE_A, 7]]);
  assert.equal(value.calls[0].planId, PLAN);
  assert.equal(value.calls[0].requirements.requireNvidiaContainerIntegration, true);
  assert.equal(JSON.stringify(result).includes("kernelVersion"), false);
});

test("fails closed for a node mismatch, transport loss, and candidate requirement drift", async () => {
  const mismatch = fixture({ [NODE_A]: { passed: false, blockers: ["secure_boot_state_incompatible"] } });
  const blocked = await mismatch.inspector.inspect({ planId: PLAN, kind: "host", candidate: candidate(), targetNodes: [{ nodeId: NODE_A }] });
  assert.equal(blocked.passed, false);
  assert.equal(blocked.secureBootCompatible, false);
  assert.deepEqual(blocked.blockers, ["secure_boot_state_incompatible"]);

  const unavailable = new NodeAgentMaintenancePreflightInspector({
    localNodeId: NODE_A,
    nodeRepository: { async findNode(nodeId) { return { nodeId, generation: 1, lifecycleState: "ready" }; } },
    nodeAgentRouter: { async maintenancePreflight() { throw new Error("transport unavailable"); } },
  });
  const failed = await unavailable.inspect({ planId: PLAN, kind: "platform", candidate: candidate("platform", ["enabled", "disabled", "unknown"]), targetNodes: [{ nodeId: NODE_A }] });
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.blockers, ["node_preflight_unavailable"]);
  assert.equal(failed.runtimeCompatible, false);

  await assert.rejects(unavailable.inspect({ planId: PLAN, kind: "host", candidate: { ...candidate(), execution: { preflightRequirements: { expectedArchitecture: "amd64" } } }, targetNodes: [{ nodeId: NODE_A }] }), /requirements are invalid/);
});

test("rejects foreign or multiple targets before contacting an agent", async () => {
  const { inspector, calls } = fixture();
  for (const targetNodes of [[{ nodeId: NODE_B }], [{ nodeId: NODE_A }, { nodeId: NODE_B }], []]) {
    await assert.rejects(inspector.inspect({ planId: PLAN, kind: "host", candidate: candidate(), targetNodes }), /inspection is invalid/);
  }
  assert.equal(calls.length, 0);
});
