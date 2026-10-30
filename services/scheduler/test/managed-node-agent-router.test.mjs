import assert from "node:assert/strict";
import test from "node:test";

import { ManagedNodeAgentRouter } from "../src/managed-node-agent-router.mjs";

const NODE = "00000000-0000-4000-8000-000000000101";
const WORKER = "00000000-0000-4000-8000-000000000201";

function fixture(overrides = {}) {
  const routes = [], calls = [], closes = [];
  const node = {
    nodeId: NODE, nodeKey: "spark-node-02", generation: 7,
    lifecycleState: "ready", health: { state: "healthy" },
    certificateFingerprint: `sha256:${"a".repeat(64)}`,
    ...overrides,
  };
  const router = new ManagedNodeAgentRouter({ localNodeId: NODE,
    nodeRepository: { async findNode() { return node; } },
    async connectorFactory(route) {
      routes.push(route);
      return { ...Object.fromEntries(["startWorker", "workerHealth", "workerControl", "stopWorker"].map((method) => [method, async (input) => {
        calls.push([method, input]); return { status: "running" };
      }])), async maintenancePreflight(input) { calls.push(["maintenancePreflight", input]); return { passed: true }; },
      async executeProtectedMaintenanceTransaction(input) {
        calls.push(["executeProtectedMaintenanceTransaction", input]); return { phase: "complete" };
      },
      async executeProtectedSetTransition(input) {
        calls.push(["executeProtectedSetTransition", input]); return { phase: "complete" };
      },
      async inspectProtectedSetTransition(input) {
        calls.push(["inspectProtectedSetTransition", input]); return { runtimeState: "legacy-exact" };
      },
      async executeApplianceRuntimeRestart(input) {
        calls.push(["executeApplianceRuntimeRestart", input]); return { phase: "complete" };
      },
      close() { closes.push(route.nodeId); } };
    },
  });
  return { router, node, routes, calls, closes };
}

test("worker operations resolve a pinned internal Node Agent without exposing an endpoint", async () => {
  const value = fixture();
  const authority = { leaseId: "lease-a", fencingToken: 11, nodeGeneration: 7 };
  await value.router.startWorker({ worker: { workerId: WORKER, nodeId: NODE, nodeGeneration: 7 }, authority, correlationId: "correlation-a" });
  await value.router.workerHealth({ workerId: WORKER, nodeId: NODE, authority, correlationId: "correlation-a" });
  await value.router.workerControl({ workerId: WORKER, nodeId: NODE, authority,
    request: { workerId: WORKER }, correlationId: "correlation-a", timeoutMilliseconds: 30_000 });
  assert.equal(value.routes[0].expectedServerName, "spark-node-02");
  assert.equal(value.routes[0].port, 9443);
  assert.equal("endpoint" in value.routes[0], false);
  assert.equal("secret" in value.routes[0], false);
  assert.deepEqual(value.calls.map(([method]) => method), ["startWorker", "workerHealth", "workerControl"]);
  assert.deepEqual(value.closes, [NODE, NODE, NODE]);
});

test("drain permits health and stop but blocks starts; a new generation fences every old command", async () => {
  const draining = fixture({ lifecycleState: "draining" });
  const authority = { leaseId: "lease-a", fencingToken: 11, nodeGeneration: 7 };
  await assert.rejects(draining.router.startWorker({ worker: { workerId: WORKER, nodeId: NODE, nodeGeneration: 7 }, authority }), { code: "managed_node_not_ready" });
  await draining.router.stopWorker({ workerId: WORKER, nodeId: NODE, authority, gracePeriodSeconds: 30 });

  const replaced = fixture({ generation: 8 });
  await assert.rejects(replaced.router.stopWorker({ workerId: WORKER, nodeId: NODE, authority }), { code: "stale_node_generation" });
  assert.equal(replaced.routes.length, 0);
});

test("maintenance preflight is routed while ready or draining with a plan-scoped fence", async () => {
  const value = fixture({ lifecycleState: "draining" });
  const planId = "00000000-0000-4000-8000-000000000710";
  const result = await value.router.maintenancePreflight({ nodeId: NODE, nodeGeneration: 7, planId, kind: "host",
    candidateDigest: `sha256:${"b".repeat(64)}`, requirements: { expectedArchitecture: "arm64", minimumDockerApiVersion: "1.48",
      requireNvidiaContainerIntegration: true, allowedSecureBootStates: ["enabled"] }, correlationId: "maintenance:preflight:a" });
  assert.equal(result.passed, true);
  const input = value.calls[0][1];
  assert.deepEqual(input.authority, { leaseId: planId, fencingToken: 1, nodeGeneration: 7 });
  assert.equal(value.closes.length, 1);
});

test("protected full-set maintenance is routed with transaction and journal fencing", async () => {
  const value = fixture({ lifecycleState: "draining" });
  const transactionId = "00000000-0000-4000-8000-000000000720";
  const result = await value.router.executeProtectedMaintenanceTransaction({
    nodeId: NODE, nodeGeneration: 7, transactionId, workerIds: [WORKER],
    allowedOperations: ["protected-set.maintenance"],
    operationOrder: ["protected.stop", "protected.restore", "protected.verify"],
    maintenanceGeneration: 9, issuedAt: "2026-09-04T08:00:00.000Z",
    expiresAt: "2026-09-04T08:10:00.000Z", journalRevision: 4, targets: [{ workerId: WORKER }],
    correlationId: "protected-maintenance:router-a",
  });
  assert.equal(result.phase, "complete");
  const input = value.calls[0][1];
  assert.deepEqual(input.authority, { leaseId: transactionId, fencingToken: 4, nodeGeneration: 7 });
  assert.equal(input.maintenanceGeneration, 9);
  assert.deepEqual(input.workerIds, [WORKER]);
  assert.equal(value.closes.length, 1);
});

test("protected transition fault and read-only inspection preserve the exact plan binding", async () => {
  const value = fixture({ lifecycleState: "draining" });
  const transactionId = "00000000-0000-4000-8000-000000000721";
  const faultInjection = {
    stageOrder: 6, targetKey: "office.drawing-flux2", injectionPoint: "after-stage-health",
    failureCode: "protected_set_transition_stage_failed", oneShot: true,
  };
  await value.router.executeProtectedSetTransition({
    nodeId: NODE, nodeGeneration: 7, transactionId, setId: "office.baseline",
    desiredStateRevision: 13, workerIds: [WORKER], allowedOperations: ["protected-set.transition"],
    operationOrder: ["protected.inspect", "protected.stage", "protected.verify", "protected.commit"],
    maintenanceGeneration: 9, issuedAt: "2026-09-04T08:00:00.000Z",
    expiresAt: "2026-09-04T08:10:00.000Z", journalRevision: 5,
    qualificationId: "protected-office-set-v5", qualificationDigest: `sha256:${"b".repeat(64)}`,
    faultInjection, targets: [{ workerId: WORKER }], correlationId: "protected-transition:router-a",
  });
  await value.router.inspectProtectedSetTransition({
    nodeId: NODE, nodeGeneration: 7, transactionId,
    qualificationId: "protected-office-set-v5", qualificationDigest: `sha256:${"b".repeat(64)}`,
    protectedTargetPolicyDigest: `sha256:${"c".repeat(64)}`,
    mode: "fault", faultInjection, correlationId: "protected-transition:inspect:a",
  });
  assert.deepEqual(value.calls[0][1].authority,
    { leaseId: transactionId, fencingToken: 5, nodeGeneration: 7 });
  assert.deepEqual(value.calls[0][1].faultInjection, faultInjection);
  assert.equal(value.calls[0][1].qualificationId, "protected-office-set-v5");
  assert.deepEqual(value.calls[1][1].faultInjection, faultInjection);
  assert.equal(value.calls[1][1].protectedTargetPolicyDigest, `sha256:${"c".repeat(64)}`);
  assert.deepEqual(value.closes, [NODE, NODE]);
});

test("appliance restart is routed to the pinned mTLS client without broad Docker authority", async () => {
  const value = fixture();
  const restartId = "00000000-0000-4000-8000-000000000722";
  const request = {
    nodeId: NODE, nodeGeneration: 7, restartId, journalRevision: 11,
    policyDigest: `sha256:${"c".repeat(64)}`, idempotencyKey: `sha256:${"d".repeat(64)}`,
    issuedAt: "2026-09-04T08:00:00.000Z", deadlineAt: "2026-09-04T08:10:00.000Z",
    correlationId: "protected-office:restart:router-a",
  };
  assert.equal((await value.router.executeApplianceRuntimeRestart(request)).phase, "complete");
  assert.deepEqual(value.calls[0][1], {
    restartId, journalRevision: 11, policyDigest: request.policyDigest,
    idempotencyKey: request.idempotencyKey, issuedAt: request.issuedAt,
    deadlineAt: request.deadlineAt, correlationId: request.correlationId,
  });
  assert.equal("containerName" in value.calls[0][1], false);
  assert.deepEqual(value.closes, [NODE]);
});
