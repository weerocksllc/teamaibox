import assert from "node:assert/strict";
import test from "node:test";

import {
  MAXIMUM_APPLIANCE_RESTART_WINDOW_MILLISECONDS,
  MAXIMUM_WORKER_CONTROL_TIMEOUT_MILLISECONDS,
  ProtectedNodeAgentClient,
} from "../src/protected-node-agent-client.mjs";

const NODE = "00000000-0000-4000-8000-000000000101";
const WORKER = "00000000-0000-4000-8000-000000000201";
const LEASE = "00000000-0000-4000-8000-000000000301";
const EXECUTION_LEASE = "00000000-0000-4000-8000-000000000302";
const COMMAND = "00000000-0000-4000-8000-000000000401";
const JOB = "00000000-0000-4000-8000-000000000501";
const ATTEMPT = "00000000-0000-4000-8000-000000000502";
const CONTROL_LEASE = "00000000-0000-4000-8000-000000000503";
const FLEET_OPERATION = "00000000-0000-4000-8000-000000000601";
const FLEET_DIGEST = `sha256:${"a".repeat(64)}`;

test("Node Agent client signs the exact body with node generation and verifies the fenced response", async () => {
  let signed, posted;
  const client = new ProtectedNodeAgentClient({
    nodeId: NODE, nodeGeneration: 7,
    transport: { async postCommand(request) {
      posted = request;
      const envelope = JSON.parse(request.body);
      return { commandId: envelope.commandId, nodeId: NODE, nodeGeneration: 7, fencingToken: 11, status: "succeeded", payload: { status: "running" } };
    } },
    commandSigner: { async sign(value) { signed = value; return { keyId: "scheduler-a", nonce: "nonce-command-a", signature: "signed-command-a" }; } },
    workerSpecFactory: { async buildStartPayload({ worker }) { return { workerId: worker.workerId, attemptId: "00000000-0000-4000-8000-000000000501" }; } },
    clock: () => new Date("2026-08-11T08:00:00Z"), idFactory: () => COMMAND,
  });
  const result = await client.startWorker({ worker: { workerId: WORKER }, authority: { leaseId: LEASE, fencingToken: 11, nodeGeneration: 7 }, correlationId: "correlation-node-a" });
  const envelope = JSON.parse(posted.body);
  assert.equal(envelope.nodeGeneration, 7);
  assert.equal(envelope.commandId, COMMAND);
  assert.equal(signed.body, posted.body);
  assert.equal(posted.headers["x-teamaibox-signature"], "signed-command-a");
  assert.equal(result.status, "running");
});

test("client rejects stale generation before signing or transport", async () => {
  let called = false;
  const client = new ProtectedNodeAgentClient({
    nodeId: NODE, nodeGeneration: 8,
    transport: { async postCommand() { called = true; } },
    commandSigner: { async sign() { called = true; } },
    workerSpecFactory: { async buildStartPayload() { return {}; } },
  });
  await assert.rejects(client.workerHealth({ workerId: WORKER, authority: { leaseId: LEASE, fencingToken: 11, nodeGeneration: 7 }, correlationId: "correlation-node-a" }), /authority is invalid/);
  assert.equal(called, false);
});

test("stop transport outlives the declared Docker grace period", async () => {
  let posted;
  const client = new ProtectedNodeAgentClient({ nodeId: NODE, nodeGeneration: 7,
    transport: { async postCommand(request) { posted = request; const envelope = JSON.parse(request.body); return {
      commandId: envelope.commandId, nodeId: NODE, nodeGeneration: 7, fencingToken: 11, status: "succeeded", payload: { status: "removed" } }; } },
    commandSigner: { async sign() { return { keyId: "scheduler-a", nonce: "nonce-command-stop-a", signature: "signed-command-stop-a" }; } },
    workerSpecFactory: { async buildStartPayload() { return {}; } },
  });
  await client.stopWorker({ workerId: WORKER, authority: { leaseId: LEASE, fencingToken: 11, nodeGeneration: 7 },
    gracePeriodSeconds: 30, correlationId: "correlation-node-stop-a" });
  assert.equal(posted.timeoutMilliseconds, 40_000);
});

test("appliance restart signs the exact policy-bound replay and accepts only durable restart phases", async () => {
  const posted = [];
  const restartId = "00000000-0000-4000-8000-000000000611";
  const policyDigest = `sha256:${"b".repeat(64)}`;
  const idempotencyKey = `sha256:${"c".repeat(64)}`;
  const identity = (character, startedAt) => ({
    containerId: character.repeat(64), imageId: `sha256:${character.repeat(64)}`,
    imageReference: `registry.local/appliance@sha256:${character.repeat(64)}`,
    configurationDigest: `sha256:${character.repeat(64)}`, startedAt,
    status: "running", health: "healthy",
  });
  let complete = false;
  const client = new ProtectedNodeAgentClient({ nodeId: NODE, nodeGeneration: 7,
    transport: { async postCommand(request) {
      posted.push(request);
      const envelope = JSON.parse(request.body);
      return {
        commandId: envelope.commandId, nodeId: NODE, nodeGeneration: 7,
        fencingToken: 21, status: complete ? "succeeded" : "restart-required",
        payload: {
          restartId, policyDigest, idempotencyKey,
          phase: complete ? "complete" : "agent_restart_armed",
          pre: {
            platform: identity("a", "2026-08-11T07:00:00.000Z"),
            nodeAgent: identity("b", "2026-08-11T07:00:00.000Z"),
          },
          post: {
            platform: identity("a", "2026-08-11T08:00:10.000Z"),
            ...(complete ? { nodeAgent: identity("b", "2026-08-11T08:00:20.000Z") } : {}),
          },
          journalRevisions: {
            prepared: 21, platformRestarting: 22, platformVerified: 23, agentRestartArmed: 24,
            ...(complete ? { complete: 25 } : {}),
          },
          updatedAt: complete ? "2026-08-11T08:00:20.000Z" : "2026-08-11T08:00:10.000Z",
        },
      };
    } },
    commandSigner: { async sign() { return {
      keyId: "scheduler-a", nonce: "nonce-appliance-restart-a", signature: "signed-appliance-restart-a",
    }; } },
    workerSpecFactory: { async buildStartPayload() { return {}; } },
    clock: () => new Date("2026-08-11T08:00:00.000Z"),
  });
  const request = {
    restartId, journalRevision: 21, policyDigest, idempotencyKey,
    issuedAt: "2026-08-11T07:59:00.000Z", deadlineAt: "2026-08-11T08:10:00.000Z",
    correlationId: "protected-office:restart:a",
  };
  assert.equal((await client.executeApplianceRuntimeRestart(request)).phase, "agent_restart_armed");
  complete = true;
  assert.equal((await client.executeApplianceRuntimeRestart(request)).phase, "complete");
  const envelopes = posted.map((entry) => JSON.parse(entry.body));
  assert.deepEqual(envelopes[0], envelopes[1]);
  assert.equal(envelopes[0].type, "appliance.runtime.restart");
  assert.equal(envelopes[0].commandId, restartId);
  assert.equal(envelopes[0].leaseId, restartId);
  assert.equal(envelopes[0].fencingToken, 21);
  assert.equal(envelopes[0].idempotency, idempotencyKey);
  assert.deepEqual(envelopes[0].payload, { restartId, journalRevision: 21, policyDigest, idempotencyKey });
});

test("appliance restart rejects an unbounded window and inexact journal response", async () => {
  const restartId = "00000000-0000-4000-8000-000000000612";
  const policyDigest = `sha256:${"b".repeat(64)}`;
  const idempotencyKey = `sha256:${"c".repeat(64)}`;
  let sent = 0;
  const client = new ProtectedNodeAgentClient({ nodeId: NODE, nodeGeneration: 7,
    transport: { async postCommand(request) {
      sent += 1;
      const envelope = JSON.parse(request.body);
      return { commandId: envelope.commandId, nodeId: NODE, nodeGeneration: 7,
        fencingToken: 21, status: "restart-required", payload: {
          restartId, policyDigest, idempotencyKey, phase: "agent_restart_armed",
          pre: {}, post: {}, journalRevisions: {}, updatedAt: "2026-08-11T08:00:00.000Z",
        } };
    } },
    commandSigner: { async sign() { return {
      keyId: "scheduler-a", nonce: "nonce-appliance-restart-b", signature: "signed-appliance-restart-b",
    }; } },
    workerSpecFactory: { async buildStartPayload() { return {}; } },
    clock: () => new Date("2026-08-11T08:00:00.000Z"),
  });
  const request = { restartId, journalRevision: 21, policyDigest, idempotencyKey,
    issuedAt: "2026-08-11T08:00:00.000Z", deadlineAt: new Date(Date.parse("2026-08-11T08:00:00.000Z")
      + MAXIMUM_APPLIANCE_RESTART_WINDOW_MILLISECONDS + 1).toISOString(),
    correlationId: "protected-office:restart:b" };
  await assert.rejects(client.executeApplianceRuntimeRestart(request), /request is invalid/);
  assert.equal(sent, 0);
  await assert.rejects(client.executeApplianceRuntimeRestart({ ...request,
    deadlineAt: "2026-08-11T08:10:00.000Z" }), { code: "node_agent_protocol_mismatch" });
  assert.equal(sent, 1);
});

test("application fetch uses the enlarged bounded mTLS command response and decodes exact bytes", async () => {
  let posted;
  const body = Buffer.from("<h1>ready</h1>");
  const client = new ProtectedNodeAgentClient({ nodeId: NODE, nodeGeneration: 7,
    transport: { async postCommand(request) { posted = request; const envelope = JSON.parse(request.body); return {
      commandId: envelope.commandId, nodeId: NODE, nodeGeneration: 7, fencingToken: 11, status: "succeeded",
      payload: { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: body.toString("base64") },
    }; } },
    commandSigner: { async sign() { return { keyId: "scheduler-a", nonce: "nonce-command-fetch-a", signature: "signed-command-fetch-a" }; } },
    workerSpecFactory: { async buildStartPayload() { return {}; } },
  });
  const result = await client.fetchApplication({ workerId: WORKER, method: "GET", path: "/plugins/example.team-notes?theme=dark",
    authority: { leaseId: LEASE, fencingToken: 11, nodeGeneration: 7 }, correlationId: "correlation-plugin-fetch-a" });
  assert.equal(JSON.parse(posted.body).type, "worker.application.fetch");
  assert.equal(posted.maximumResponseBytes, 24 << 20);
  assert.equal(posted.timeoutMilliseconds, 30_000);
  assert.equal(result.body.toString(), "<h1>ready</h1>");
});

test("worker control separates container authority from the bound attempt authority", async () => {
  let posted;
  const request = { protocolVersion: 1, messageId: COMMAND, workerId: WORKER, type: "worker.prepare.request",
    sentAt: "2026-08-11T08:00:00.000Z", correlationId: "correlation-worker-control-a", jobId: null, attemptId: null,
    leaseId: EXECUTION_LEASE, fencingToken: 19, payload: { generation: 2 } };
  const client = new ProtectedNodeAgentClient({ nodeId: NODE, nodeGeneration: 7,
    transport: { async postCommand(value) { posted = value; const envelope = JSON.parse(value.body); return {
      commandId: envelope.commandId, nodeId: NODE, nodeGeneration: 7, fencingToken: 11, status: "succeeded",
      payload: { protocolVersion: 1, workerId: WORKER, status: "ready" },
    }; } },
    commandSigner: { async sign() { return { keyId: "scheduler-a", nonce: "nonce-command-control-a", signature: "signed-command-control-a" }; } },
    workerSpecFactory: { async buildStartPayload() { return {}; } },
    clock: () => new Date("2026-08-11T08:00:00Z"),
  });
  const result = await client.workerControl({ workerId: WORKER, request,
    authority: { leaseId: LEASE, fencingToken: 11, nodeGeneration: 7 }, correlationId: request.correlationId,
    timeoutMilliseconds: MAXIMUM_WORKER_CONTROL_TIMEOUT_MILLISECONDS });
  const envelope = JSON.parse(posted.body);
  assert.equal(envelope.type, "worker.control");
  assert.equal(envelope.leaseId, LEASE);
  assert.equal(envelope.fencingToken, 11);
  assert.deepEqual(envelope.payload, { workerId: WORKER, request });
  assert.equal(posted.timeoutMilliseconds, MAXIMUM_WORKER_CONTROL_TIMEOUT_MILLISECONDS);
  assert.equal(envelope.deadlineAt, "2026-08-11T08:10:00.000Z");
  assert.equal(result.status, "ready");
});

test("worker control rejects a timeout beyond the authenticated transport window", async () => {
  const client = new ProtectedNodeAgentClient({ nodeId: NODE, nodeGeneration: 7,
    transport: { async postCommand() { throw new Error("must not send"); } },
    commandSigner: { async sign() { throw new Error("must not sign"); } },
    workerSpecFactory: { async buildStartPayload() { return {}; } },
  });
  await assert.rejects(client.workerControl({ workerId: WORKER,
    request: { protocolVersion: 1, messageId: COMMAND, workerId: WORKER, type: "worker.execute.request",
      sentAt: "2026-08-11T08:00:00.000Z", correlationId: "correlation-worker-control-b",
      jobId: null, attemptId: null, leaseId: LEASE, fencingToken: 11, payload: { generation: 2 } },
    authority: { leaseId: LEASE, fencingToken: 11, nodeGeneration: 7 }, correlationId: "correlation-worker-control-b",
    timeoutMilliseconds: MAXIMUM_WORKER_CONTROL_TIMEOUT_MILLISECONDS + 1 }), /worker control request is invalid/);
});

test("worker runtime forwarding loss is classified as a fatal Worker transport failure", async () => {
  const client = new ProtectedNodeAgentClient({ nodeId: NODE, nodeGeneration: 7,
    transport: { async postCommand(request) { const envelope = JSON.parse(request.body); return {
      commandId: envelope.commandId, nodeId: NODE, nodeGeneration: 7,
      fencingToken: 11, status: "failed", errorCode: "worker_control_failed", retryable: true,
    }; } },
    commandSigner: { async sign() { return { keyId: "scheduler-a", nonce: "nonce-command-control-loss", signature: "signed-command-control-loss" }; } },
    workerSpecFactory: { async buildStartPayload() { return {}; } },
  });
  await assert.rejects(client.workerControl({ workerId: WORKER,
    request: { protocolVersion: 1, messageId: COMMAND, workerId: WORKER, type: "worker.execute.request",
      correlationId: "correlation.worker-control-loss", jobId: JOB, attemptId: ATTEMPT,
      leaseId: LEASE, fencingToken: 12, payload: { generation: 2, input: {} }, sentAt: new Date() },
    authority: { leaseId: CONTROL_LEASE, fencingToken: 11, nodeGeneration: 7 },
    correlationId: "correlation.worker-control-loss" }), (error) => {
    assert.equal(error.code, "worker_transport_lost");
    assert.equal(error.retryable, true);
    assert.equal(error.fatalWorker, true);
    return true;
  });
});

test("Node Agent connection loss during Worker control is classified as uncertain fatal transport loss", async () => {
  const client = new ProtectedNodeAgentClient({ nodeId: NODE, nodeGeneration: 7,
    transport: { async postCommand() { const error = new Error("socket closed"); error.code = "ECONNRESET"; throw error; } },
    commandSigner: { async sign() { return { keyId: "scheduler-a", nonce: "nonce-node-agent-loss", signature: "signed-node-agent-loss" }; } },
    workerSpecFactory: { async buildStartPayload() { return {}; } },
  });
  await assert.rejects(client.workerControl({ workerId: WORKER,
    request: { protocolVersion: 1, messageId: COMMAND, workerId: WORKER, type: "worker.execute.request",
      correlationId: "correlation.node-agent-loss", jobId: JOB, attemptId: ATTEMPT,
      leaseId: LEASE, fencingToken: 12, payload: { generation: 2, input: {} }, sentAt: new Date() },
    authority: { leaseId: CONTROL_LEASE, fencingToken: 11, nodeGeneration: 7 },
    correlationId: "correlation.node-agent-loss" }), (error) => {
    assert.equal(error.code, "worker_transport_lost");
    assert.equal(error.retryable, true);
    assert.equal(error.fatalWorker, true);
    assert.equal(error.cause?.code, "node_agent_transport_unavailable");
    return true;
  });
});

test("exclusive conflict operations are fenced and validate the Node Agent result", async () => {
  const posted = [];
  const client = new ProtectedNodeAgentClient({ nodeId: NODE, nodeGeneration: 7,
    transport: { async postCommand(request) { posted.push(request); const envelope = JSON.parse(request.body); const payload =
      envelope.type === "worker.conflicts.list" ? { workers: [{ workerId: "ocr.vlm", containerName: "ocr-vlm", state: "running", health: "healthy", wasRunning: true, leasesReleased: false }] }
      : envelope.type === "worker.conflict.drain" ? { workerId: "ocr.vlm", containerName: "ocr-vlm", state: "exited", health: "healthy", wasRunning: true, leasesReleased: true }
      : { workerId: "ocr.vlm", containerName: "ocr-vlm", state: "running", health: "healthy", wasRunning: true, leasesReleased: true };
      return { commandId: envelope.commandId, nodeId: NODE, nodeGeneration: 7, fencingToken: 11, status: "succeeded", payload }; } },
    commandSigner: { async sign() { return { keyId: "scheduler-a", nonce: "nonce-command-exclusive-a", signature: "signed-command-exclusive-a" }; } },
    workerSpecFactory: { async buildStartPayload() { return {}; } },
  });
  const input = { exclusiveJobId: WORKER, authority: { leaseId: LEASE, fencingToken: 11, nodeGeneration: 7 }, correlationId: "correlation-exclusive-a" };
  assert.equal((await client.listConflictingWorkers(input))[0].workerId, "ocr.vlm");
  assert.equal((await client.drainConflictingWorker({ ...input, targetKey: "ocr.vlm" })).state, "exited");
  assert.equal((await client.restoreConflictingWorker({ ...input, targetKey: "ocr.vlm" })).state, "running");
  assert.deepEqual(posted.map((request) => JSON.parse(request.body).type), ["worker.conflicts.list", "worker.conflict.drain", "worker.conflict.restore"]);
  assert.deepEqual(posted.slice(1).map((request) => request.timeoutMilliseconds), [50_000, 50_000]);
});

test("maintenance preflight sends only bounded read-only requirements and validates closed evidence", async () => {
  let posted;
  const planId = "00000000-0000-4000-8000-000000000710";
  const client = new ProtectedNodeAgentClient({ nodeId: NODE, nodeGeneration: 7,
    transport: { async postCommand(request) { posted = request; const envelope = JSON.parse(request.body); return {
      commandId: envelope.commandId, nodeId: NODE, nodeGeneration: 7, fencingToken: 1, status: "succeeded", payload: {
        planId, nodeId: NODE, nodeGeneration: 7, passed: true, blockers: [], warnings: ["managed_workloads_require_drain"],
        architecture: "arm64", dockerVersion: "28.3.3", dockerApiVersion: "1.51", kernelVersion: "6.14.0",
        operatingSystem: "Ubuntu 24.04", secureBootState: "enabled", nvidiaContainerIntegrationAvailable: true,
        nvidiaContainerIntegrationMode: "cdi",
        activeManagedWorkloads: 4, evidenceDigest: `sha256:${"a".repeat(64)}`,
      },
    }; } },
    commandSigner: { async sign() { return { keyId: "scheduler-a", nonce: "nonce-maintenance-a", signature: "signed-maintenance-a" }; } },
    workerSpecFactory: { async buildStartPayload() { return {}; } },
  });
  const result = await client.maintenancePreflight({ planId, kind: "host", candidateDigest: `sha256:${"b".repeat(64)}`,
    requirements: { expectedArchitecture: "arm64", minimumDockerApiVersion: "1.48", requireNvidiaContainerIntegration: true,
      allowedSecureBootStates: ["enabled"] }, authority: { leaseId: planId, fencingToken: 1, nodeGeneration: 7 },
    correlationId: "maintenance:preflight:a" });
  const envelope = JSON.parse(posted.body);
  assert.equal(envelope.type, "maintenance.preflight");
  assert.equal(envelope.leaseId, planId);
  assert.deepEqual(envelope.payload, { planId, kind: "host", candidateDigest: `sha256:${"b".repeat(64)}`,
    expectedArchitecture: "arm64", minimumDockerApiVersion: "1.48", requireNvidiaContainerIntegration: true,
    allowedSecureBootStates: ["enabled"] });
  assert.equal(posted.timeoutMilliseconds, 30_000);
  assert.equal(result.activeManagedWorkloads, 4);
  assert.equal("command" in envelope.payload, false);
  assert.equal("packages" in envelope.payload, false);
});

test("protected maintenance signs the exact full-set window and ordered prior identities", async () => {
  let posted, signed;
  const transactionId = "00000000-0000-4000-8000-000000000720";
  const workerB = "00000000-0000-4000-8000-000000000202";
  const imageA = `registry.local/office-a@sha256:${"a".repeat(64)}`;
  const imageB = `registry.local/office-b@sha256:${"b".repeat(64)}`;
  const targets = [{
    targetKey: "office.assistant", workerId: workerB,
    modelProfileId: "00000000-0000-4000-8000-000000000212",
    containerName: "office-assistant", placementClass: "protected-resident", maintenanceGeneration: 7,
    stageOrder: 2, dependsOnWorkerIds: [WORKER], requiredImageId: `sha256:${"2".repeat(64)}`,
    requiredImageDigest: imageB, requiredConfigDigest: `sha256:${"d".repeat(64)}`,
    requiredLabels: { "com.teamaibox.profile": "office-assistant" }, dependentContainers: [],
  }, {
    targetKey: "office.embedding", workerId: WORKER,
    modelProfileId: "00000000-0000-4000-8000-000000000211",
    containerName: "office-embedding", placementClass: "protected-resident", maintenanceGeneration: 7,
    stageOrder: 1, dependsOnWorkerIds: [], requiredImageId: `sha256:${"1".repeat(64)}`,
    requiredImageDigest: imageA, requiredConfigDigest: `sha256:${"c".repeat(64)}`,
    requiredLabels: { "com.teamaibox.profile": "office-embedding" }, dependentContainers: [],
  }];
  const client = new ProtectedNodeAgentClient({ nodeId: NODE, nodeGeneration: 7,
    transport: { async postCommand(request) { posted = request; const envelope = JSON.parse(request.body); return {
      commandId: envelope.commandId, nodeId: NODE, nodeGeneration: 7, fencingToken: 1, status: "succeeded",
      payload: { transactionId, maintenanceGeneration: 7, journalRevision: 1, phase: "complete",
        nextOperation: 0, planDigest: `sha256:${"f".repeat(64)}` },
    }; } },
    commandSigner: { async sign(value) { signed = value; return {
      keyId: "scheduler-a", nonce: "nonce-protected-maintenance", signature: "signed-protected-maintenance",
    }; } },
    workerSpecFactory: { async buildStartPayload() { return {}; } },
    clock: () => new Date("2026-08-11T08:00:00.000Z"), idFactory: () => COMMAND,
  });
  const value = await client.executeProtectedMaintenanceTransaction({
    transactionId, workerIds: [workerB, WORKER], allowedOperations: ["protected-set.maintenance"],
    operationOrder: ["protected.stop", "protected.restore", "protected.verify"], maintenanceGeneration: 7,
    issuedAt: "2026-08-11T08:00:00.000Z", expiresAt: "2026-08-11T08:15:00.000Z", journalRevision: 1,
    targets, authority: { leaseId: transactionId, fencingToken: 1, nodeGeneration: 7 },
    correlationId: "protected-maintenance:transaction-a",
  });
  const envelope = JSON.parse(posted.body);
  assert.equal(envelope.type, "maintenance.transaction.execute");
  assert.equal(envelope.commandId, transactionId);
  assert.equal(envelope.leaseId, transactionId);
  assert.equal(envelope.fencingToken, 1);
  assert.equal(envelope.issuedAt, "2026-08-11T08:00:00.000Z");
  assert.equal(envelope.deadlineAt, "2026-08-11T08:15:00.000Z");
  assert.deepEqual(envelope.payload.workerIds, [workerB, WORKER]);
  assert.deepEqual(envelope.payload.targets, targets);
  assert.equal(signed.body, posted.body);
  assert.equal(posted.timeoutMilliseconds, 930_000);
  assert.ok(posted.timeoutMilliseconds > MAXIMUM_WORKER_CONTROL_TIMEOUT_MILLISECONDS);
  assert.equal(value.phase, "complete");
});

test("protected maintenance rejects an inexact ordered target set before signing", async () => {
  let called = false;
  const transactionId = "00000000-0000-4000-8000-000000000721";
  const client = new ProtectedNodeAgentClient({ nodeId: NODE, nodeGeneration: 7,
    transport: { async postCommand() { called = true; } },
    commandSigner: { async sign() { called = true; } },
    workerSpecFactory: { async buildStartPayload() { return {}; } },
    clock: () => new Date("2026-08-11T08:00:00.000Z"),
  });
  await assert.rejects(client.executeProtectedMaintenanceTransaction({
    transactionId, workerIds: ["00000000-0000-4000-8000-000000000299"],
    allowedOperations: ["protected-set.maintenance"],
    operationOrder: ["protected.stop", "protected.restore", "protected.verify"], maintenanceGeneration: 7,
    issuedAt: "2026-08-11T07:59:00.000Z", expiresAt: "2026-08-11T08:10:00.000Z", journalRevision: 1,
    targets: [{ targetKey: "office.embedding", workerId: WORKER,
      modelProfileId: "00000000-0000-4000-8000-000000000211", containerName: "office-embedding",
      placementClass: "protected-resident", maintenanceGeneration: 7, stageOrder: 1,
      dependsOnWorkerIds: [], requiredImageId: `sha256:${"1".repeat(64)}`,
      requiredImageDigest: `registry.local/office-a@sha256:${"a".repeat(64)}`,
      requiredConfigDigest: `sha256:${"c".repeat(64)}`, requiredLabels: {}, dependentContainers: [] }],
    authority: { leaseId: transactionId, fencingToken: 1, nodeGeneration: 7 },
    correlationId: "protected-maintenance:transaction-b",
  }), /target set is invalid/);
  assert.equal(called, false);
});

test("protected set transition signs one dependency-first desired/prior cutover and uses its fence as the replay key", async () => {
  let posted, signed;
  const transactionId = "00000000-0000-4000-8000-000000000722";
  const setId = "office.baseline";
  const image = `registry.local/office-a@sha256:${"a".repeat(64)}`;
  const desiredTarget = {
    targetKey: "office.embedding", workerId: WORKER,
    modelProfileId: "00000000-0000-4000-8000-000000000211",
    containerName: "office-embedding", placementClass: "protected-resident", maintenanceGeneration: 7,
    stageOrder: 1, dependsOnWorkerIds: [], requiredImageId: `sha256:${"1".repeat(64)}`,
    requiredImageDigest: image, requiredConfigDigest: `sha256:${"c".repeat(64)}`,
    requiredLabels: { "com.teamaibox.profile": "office-embedding" }, dependentContainers: [],
  };
  const previousTarget = {
    ...desiredTarget, maintenanceGeneration: 6,
    requiredImageId: `sha256:${"2".repeat(64)}`,
    requiredImageDigest: `registry.local/office-a@sha256:${"b".repeat(64)}`,
    requiredConfigDigest: `sha256:${"d".repeat(64)}`,
  };
  const desiredWorker = {
    workerId: WORKER, modelProfileId: desiredTarget.modelProfileId, image,
    placementClass: "protected-resident", maintenanceGeneration: 7,
    configDigest: desiredTarget.requiredConfigDigest,
  };
  const client = new ProtectedNodeAgentClient({ nodeId: NODE, nodeGeneration: 7,
    transport: { async postCommand(request) { posted = request; const envelope = JSON.parse(request.body); return {
      commandId: envelope.commandId, nodeId: NODE, nodeGeneration: 7, fencingToken: 23, status: "succeeded",
      payload: { transactionId, setId, desiredStateRevision: 12, maintenanceGeneration: 7,
        journalRevision: 23, phase: "complete", nextOperation: 0, planDigest: `sha256:${"f".repeat(64)}` },
    }; } },
    commandSigner: { async sign(value) { signed = value; return {
      keyId: "scheduler-a", nonce: "nonce-protected-transition", signature: "signed-protected-transition",
    }; } },
    workerSpecFactory: { async buildStartPayload({ worker }) { return { ...worker, attemptId: ATTEMPT }; } },
    clock: () => new Date("2026-08-11T08:00:00.000Z"), idFactory: () => COMMAND,
  });
  const value = await client.executeProtectedSetTransition({
    transactionId, setId, desiredStateRevision: 12, workerIds: [WORKER],
    allowedOperations: ["protected-set.transition"],
    operationOrder: ["protected.inspect", "protected.stage", "protected.verify", "protected.commit"],
    maintenanceGeneration: 7, issuedAt: "2026-08-11T07:59:00.000Z",
    expiresAt: "2026-08-11T08:10:00.000Z", journalRevision: 23,
    targets: [{ desiredWorker, desiredTarget, previousTarget }],
    authority: { leaseId: transactionId, fencingToken: 23, nodeGeneration: 7 },
    correlationId: "protected-transition:transaction-a",
  });
  const envelope = JSON.parse(posted.body);
  assert.equal(envelope.type, "protected-set.transaction.execute");
  assert.equal(envelope.commandId, transactionId);
  assert.equal(envelope.fencingToken, 23);
  assert.equal(envelope.payload.targets[0].desiredWorker.attemptId, ATTEMPT);
  assert.equal(envelope.payload.targets[0].previousTarget.requiredImageDigest, previousTarget.requiredImageDigest);
  assert.deepEqual(envelope.payload.operationOrder,
    ["protected.inspect", "protected.stage", "protected.verify", "protected.commit"]);
  assert.equal(signed.body, posted.body);
  assert.equal(value.phase, "complete");
});

test("protected set transition preserves an exact legacy migration plan and companion contract", async () => {
  let posted;
  const transactionId = "00000000-0000-4000-8000-000000000723";
  const profileId = "00000000-0000-4000-8000-000000000212";
  const image = `registry.local/office-ocr@sha256:${"a".repeat(64)}`;
  const desiredTarget = {
    targetKey: "office.ocr-hunyuan", workerId: WORKER, modelProfileId: profileId,
    containerName: `teamaibox-worker-${WORKER}`, placementClass: "protected-resident",
    maintenanceGeneration: 7, stageOrder: 1, dependsOnWorkerIds: [],
    requiredImageId: `sha256:${"1".repeat(64)}`, requiredImageDigest: image,
    requiredConfigDigest: `sha256:${"c".repeat(64)}`,
    requiredStartSpecDigest: `sha256:${"e".repeat(64)}`,
    requiredLabels: { "com.teamaibox.profile": "office-ocr" },
  };
  const desiredWorker = {
    workerId: WORKER, modelProfileId: profileId, image, placementClass: "protected-resident",
    maintenanceGeneration: 7, configDigest: desiredTarget.requiredConfigDigest,
    healthCheck: { test: ["CMD-SHELL", "test -r /proc/1/status"], intervalNanoseconds: 10_000_000_000,
      timeoutNanoseconds: 2_000_000_000, startPeriodNanoseconds: 480_000_000_000, retries: 6 },
  };
  const legacyIdentity = {
    containerName: "legacy-office-ocr", containerId: "2".repeat(64),
    requiredImageId: `sha256:${"3".repeat(64)}`, requiredImageReference: "legacy/office-ocr:exact",
    requiredNetworkMode: "bridge", requiredRuntimeDigest: `sha256:${"4".repeat(64)}`,
    requiredMounts: [{ type: "volume", source: "legacy-ocr-model", target: "/model", readOnly: true }],
    requiredEnvironmentDigest: `sha256:${"5".repeat(64)}`, requiredCommandDigest: `sha256:${"6".repeat(64)}`,
    requiredHealthcheckDigest: `sha256:${"7".repeat(64)}`,
    requiredLabels: { "legacy.teamaibox.slot": "ocr-hunyuan" },
  };
  const companion = {
    containerName: "teamaibox-ocr-provider-canonical", parentWorkerId: WORKER,
    image: `registry.local/ocr-provider@sha256:${"8".repeat(64)}`,
    requiredImageId: `sha256:${"9".repeat(64)}`, configDigest: `sha256:${"b".repeat(64)}`,
    network: "compute-internal",
    limits: { memoryBytes: 268435456, cpuQuotaMicros: 100000, pidsLimit: 128,
      ephemeralBytes: 67108864, openFilesLimit: 4096 },
    security: { runAsUid: 10001, runAsGid: 10001, readOnlyRoot: true, dropAllCapabilities: true,
      noNewPrivileges: true, privileged: false, hostPid: false, hostIpc: false,
      hostNetwork: false, dockerSocket: false },
    mounts: [{ type: "bind", source: "/var/lib/teamaibox-provider-runtime/ocr/tls", target: "/run/tls", readOnly: true }],
    publishedPorts: [{ containerPort: 19095, hostPort: 19103, hostIp: "127.0.0.1" }],
    environment: { TEAMAIBOX_OCR_UPSTREAM: `http://teamaibox-worker-${WORKER}:19095` },
    command: ["serve"],
    healthCheck: { test: ["CMD-SHELL", "test -r /proc/1/status"], intervalNanoseconds: 10000000000,
      timeoutNanoseconds: 2000000000, startPeriodNanoseconds: 30000000000, retries: 3 },
    requiredLabels: { "com.teamaibox.office-companion": "ocr-provider" },
  };
  const minimalCompanion = structuredClone(companion);
  minimalCompanion.containerName = "teamaibox-ocr-provider-canonical-minimal";
  delete minimalCompanion.mounts;
  delete minimalCompanion.publishedPorts;
  delete minimalCompanion.command;
  const migrationPlanDigest = `sha256:${"d".repeat(64)}`;
  const faultInjection = {
    stageOrder: 4, targetKey: "office.translation-lmt4", injectionPoint: "after-stage-health",
    failureCode: "protected_set_transition_stage_failed", oneShot: true,
  };
  const client = new ProtectedNodeAgentClient({ nodeId: NODE, nodeGeneration: 7,
    transport: { async postCommand(request) { posted = request; const envelope = JSON.parse(request.body); return {
      commandId: envelope.commandId, nodeId: NODE, nodeGeneration: 7, fencingToken: 24, status: "succeeded",
      payload: { transactionId, setId: "office.baseline", desiredStateRevision: 13, maintenanceGeneration: 7,
        journalRevision: 24, phase: "complete", nextOperation: 0, planDigest: `sha256:${"f".repeat(64)}` },
    }; } },
    commandSigner: { async sign() { return { keyId: "scheduler-a", nonce: "nonce-migration-transition",
      signature: "signed-migration-transition" }; } },
    workerSpecFactory: { async buildStartPayload({ worker }) { return { ...worker, attemptId: ATTEMPT }; } },
    clock: () => new Date("2026-08-11T08:00:00.000Z"), idFactory: () => COMMAND,
  });
  const migrationRequest = {
    transactionId, setId: "office.baseline", desiredStateRevision: 13, workerIds: [WORKER],
    allowedOperations: ["protected-set.transition"],
    operationOrder: ["protected.inspect", "protected.stage", "protected.verify", "protected.commit"],
    maintenanceGeneration: 7, issuedAt: "2026-08-11T07:59:00.000Z",
    expiresAt: "2026-08-11T08:10:00.000Z", journalRevision: 24,
    migrationPlanId: "legacy-office-v1", migrationPlanDigest, faultInjection,
    targets: [{ desiredWorker, desiredTarget, previousTarget: null,
      legacyPreviousTarget: { primary: legacyIdentity },
      desiredCompanions: [companion, minimalCompanion] }],
    authority: { leaseId: transactionId, fencingToken: 24, nodeGeneration: 7 },
    correlationId: "protected-transition:migration-a",
  };
  await client.executeProtectedSetTransition(migrationRequest);
  const payload = JSON.parse(posted.body).payload;
  assert.equal(payload.migrationPlanId, "legacy-office-v1");
  assert.equal(payload.migrationPlanDigest, migrationPlanDigest);
  assert.deepEqual(payload.faultInjection, faultInjection);
  assert.equal(posted.timeoutMilliseconds, 1_122_000);
  assert.equal(payload.targets[0].desiredTarget.requiredStartSpecDigest,
    desiredTarget.requiredStartSpecDigest);
  assert.deepEqual(payload.targets[0].legacyPreviousTarget.primary, legacyIdentity);
  assert.deepEqual(payload.targets[0].desiredTarget.dependentContainers, []);
  assert.deepEqual(payload.targets[0].legacyPreviousTarget.dependentContainers, []);
  assert.deepEqual(payload.targets[0].desiredCompanions[0], companion);
  assert.deepEqual(payload.targets[0].desiredCompanions[1], {
    ...minimalCompanion, mounts: [], publishedPorts: [], command: [],
  });

  await client.executeProtectedSetTransition({
    ...migrationRequest,
    targets: [{ desiredWorker, desiredTarget, previousTarget: null,
      legacyPreviousTarget: { primary: legacyIdentity } }],
  });
  const companionlessPayload = JSON.parse(posted.body).payload;
  assert.equal(Object.hasOwn(companionlessPayload.targets[0], "desiredCompanions"), false);

  const canonicalTarget = { ...desiredTarget, dependentContainers: [{
    containerName: companion.containerName, requiredImageId: companion.requiredImageId,
    requiredImageDigest: companion.image, requiredConfigDigest: companion.configDigest,
    requiredStartSpecDigest: `sha256:${"c".repeat(64)}`, requiredLabels: companion.requiredLabels,
  }] };
  const canonicalRequest = { ...migrationRequest, migrationPlanId: undefined, migrationPlanDigest: undefined,
    faultInjection: undefined, targets: [{ desiredWorker, desiredTarget: canonicalTarget,
      previousTarget: desiredTarget, desiredCompanions: [companion] }] };
  await client.executeProtectedSetTransition(canonicalRequest);
  const canonicalPayload = JSON.parse(posted.body).payload;
  assert.deepEqual(canonicalPayload.targets[0].desiredCompanions, [companion]);
  assert.equal(canonicalPayload.targets[0].desiredTarget.dependentContainers[0].requiredStartSpecDigest,
    canonicalTarget.dependentContainers[0].requiredStartSpecDigest);
  const unbound = structuredClone(canonicalRequest);
  delete unbound.targets[0].desiredTarget.dependentContainers[0].requiredStartSpecDigest;
  await assert.rejects(client.executeProtectedSetTransition(unbound), /transition target 0 is invalid/);
});

test("protected set transition rejects unbound legacy migration identities", async () => {
  let called = false;
  const client = new ProtectedNodeAgentClient({ nodeId: NODE, nodeGeneration: 7,
    transport: { async postCommand() { called = true; } },
    commandSigner: { async sign() { throw new Error("must not sign"); } },
    workerSpecFactory: { async buildStartPayload({ worker }) { return worker; } },
    clock: () => new Date("2026-08-11T08:00:00.000Z"), idFactory: () => COMMAND,
  });
  await assert.rejects(client.executeProtectedSetTransition({
    transactionId: "00000000-0000-4000-8000-000000000724", setId: "office.baseline",
    desiredStateRevision: 13, workerIds: [WORKER], allowedOperations: ["protected-set.transition"],
    operationOrder: ["protected.inspect", "protected.stage", "protected.verify", "protected.commit"],
    maintenanceGeneration: 7, issuedAt: "2026-08-11T07:59:00.000Z",
    expiresAt: "2026-08-11T08:10:00.000Z", journalRevision: 25,
    migrationPlanId: "legacy-office-v1", targets: [{}],
    authority: { leaseId: "00000000-0000-4000-8000-000000000724", fencingToken: 25, nodeGeneration: 7 },
    correlationId: "protected-transition:migration-invalid",
  }), /migration binding is invalid/);
  assert.equal(called, false);
});

test("protected set transition inspection is migration-bound and rejects spoofed Docker facts", async () => {
  const transactionId = "00000000-0000-4000-8000-000000000725";
  const migrationPlanDigest = `sha256:${"d".repeat(64)}`;
  const targetKeys = [
    "office.embedding-qwen3", "office.asr-whisper", "office.ocr-hunyuan",
    "office.translation-lmt4", "office.assistant-qwen38", "office.drawing-flux2",
  ];
  let posted;
  let spoof = false;
  let mutateInspection = () => {};
  const client = new ProtectedNodeAgentClient({ nodeId: NODE, nodeGeneration: 7,
    transport: { async postCommand(request) {
      posted = request;
      const envelope = JSON.parse(request.body);
      const payload = {
        schemaVersion: 1, readOnly: true, mutationCount: 0, nodeId: NODE, nodeGeneration: 7,
        transactionId, setId: "office.baseline", migrationPlanId: "legacy-office-v1",
        migrationPlanDigest: spoof ? `sha256:${"0".repeat(64)}` : migrationPlanDigest,
        sourceSetDigest: `sha256:${"1".repeat(64)}`, desiredSetDigest: `sha256:${"2".repeat(64)}`,
        runtimeState: "desired-exact",
        journal: { transactionId, setId: "office.baseline", desiredStateRevision: 15,
          maintenanceGeneration: 7, journalRevision: 26, phase: "complete", nextOperation: 0,
          planDigest: `sha256:${"3".repeat(64)}`, updatedAt: "2026-08-11T08:00:01.000Z" },
        targets: targetKeys.map((targetKey, index) => ({
          targetKey, stageOrder: index + 1,
          workerId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          modelProfileId: `00000000-0000-4000-9000-${String(index + 1).padStart(12, "0")}`,
          runtimeState: "desired-exact",
          desired: { containerName: `teamaibox-worker-${index + 1}`,
            containerId: String(index + 1).repeat(64),
            imageReference: `registry.local/office-${index + 1}@sha256:${String(index + 1).repeat(64)}`,
            imageId: `sha256:${String(index + 1).repeat(64)}`,
            imageManifestDigest: `sha256:${String(index + 1).repeat(64)}`,
            runtimeDigest: `sha256:${"a".repeat(64)}`, networkMode: "compute-internal",
            state: "running", health: "healthy", startSpecDigest: `sha256:${"b".repeat(64)}`,
            oomKilled: false, exact: true },
          desiredCompanions: [], legacyDependents: [], mountsExact: true,
          readOnlyModelMount: true, modelMaterialMode: index === 1 ? "image-contained" : "read-only-mounts",
          healthcheckExact: true, runtimeLimitsExact: true,
          legacyHostNetworkRemoved: index === 3, tmpfsExecutable: index !== 1,
        })),
        rollbackTargetKeys: [], canonicalContainersRemaining: [], rollbackContainersRemaining: [],
        transitionHelpersRemaining: [], oomKilled: false, restartPersistenceObserved: false,
      };
      mutateInspection(payload);
      return { commandId: envelope.commandId, nodeId: NODE, nodeGeneration: 7,
        fencingToken: 1, status: "succeeded", payload };
    } },
    commandSigner: { async sign() { return { keyId: "scheduler-a", nonce: "nonce-migration-inspection",
      signature: "signed-migration-inspection" }; } },
    workerSpecFactory: { async buildStartPayload() { return {}; } },
    clock: () => new Date("2026-08-11T08:00:00.000Z"), idFactory: () => COMMAND,
  });
  const result = await client.inspectProtectedSetTransition({
    transactionId, migrationPlanId: "legacy-office-v1", migrationPlanDigest,
    mode: "success", correlationId: "protected-transition:inspection-a",
  });
  const envelope = JSON.parse(posted.body);
  assert.equal(envelope.type, "protected-set.transaction.inspect");
  assert.equal(envelope.commandId, COMMAND);
  assert.equal(envelope.leaseId, COMMAND);
  assert.equal(envelope.fencingToken, 1);
  assert.equal(envelope.payload.transactionId, transactionId);
  assert.equal(result.restartPersistenceObserved, false);
  assert.equal(result.targets[5].modelMaterialMode, "read-only-mounts");

  spoof = true;
  await assert.rejects(client.inspectProtectedSetTransition({
    transactionId, migrationPlanId: "legacy-office-v1", migrationPlanDigest,
    mode: "success", correlationId: "protected-transition:inspection-spoof",
  }), (error) => error?.code === "node_agent_protocol_mismatch");

  spoof = false;
  for (const targetIndex of [0, 2, 3, 4, 5]) {
    mutateInspection = (payload) => { payload.targets[targetIndex].tmpfsExecutable = false; };
    await assert.rejects(client.inspectProtectedSetTransition({
      transactionId, migrationPlanId: "legacy-office-v1", migrationPlanDigest,
      mode: "success", correlationId: `protected-transition:inspection-no-exec-${targetIndex}`,
    }), (error) => error?.code === "node_agent_protocol_mismatch");
  }

  mutateInspection = (payload) => { payload.targets[1].tmpfsExecutable = true; };
  await assert.rejects(client.inspectProtectedSetTransition({
    transactionId, migrationPlanId: "legacy-office-v1", migrationPlanDigest,
    mode: "success", correlationId: "protected-transition:inspection-asr-exec",
  }), (error) => error?.code === "node_agent_protocol_mismatch");

  mutateInspection = (payload) => { payload.targets[3].legacyHostNetworkRemoved = false; };
  await assert.rejects(client.inspectProtectedSetTransition({
    transactionId, migrationPlanId: "legacy-office-v1", migrationPlanDigest,
    mode: "success", correlationId: "protected-transition:inspection-lmt4-host-network",
  }), (error) => error?.code === "node_agent_protocol_mismatch");

  mutateInspection = (payload) => { payload.targets[0].legacyHostNetworkRemoved = true; };
  await assert.rejects(client.inspectProtectedSetTransition({
    transactionId, migrationPlanId: "legacy-office-v1", migrationPlanDigest,
    mode: "success", correlationId: "protected-transition:inspection-embedding-host-network",
  }), (error) => error?.code === "node_agent_protocol_mismatch");
});

test("canonical qualification fault is policy-bound and its recovered inspection exposes exact prior identities", async () => {
  const transactionId = "00000000-0000-4000-8000-000000000726";
  const qualificationDigest = `sha256:${"d".repeat(64)}`;
  const targetPolicyDigest = `sha256:${"e".repeat(64)}`;
  const targetKeys = [
    "office.embedding-qwen3", "office.asr-whisper", "office.ocr-hunyuan",
    "office.translation-lmt4", "office.assistant-qwen38", "office.drawing-flux2",
  ];
  const targets = targetKeys.map((targetKey, index) => {
    const character = String(index + 1);
    const workerId = `00000000-0000-4000-8000-${String(index + 21).padStart(12, "0")}`;
    const modelProfileId = `00000000-0000-4000-9000-${String(index + 21).padStart(12, "0")}`;
    const desiredTarget = {
      targetKey, workerId, modelProfileId, containerName: `teamaibox-worker-${workerId}`,
      placementClass: "protected-resident", maintenanceGeneration: 7, stageOrder: index + 1,
      dependsOnWorkerIds: [], requiredImageId: `sha256:${character.repeat(64)}`,
      requiredImageDigest: `registry.local/office-${index + 1}@sha256:${character.repeat(64)}`,
      requiredConfigDigest: `sha256:${"a".repeat(64)}`,
      requiredStartSpecDigest: `sha256:${"b".repeat(64)}`, requiredLabels: {}, dependentContainers: [],
    };
    return { desiredTarget, previousTarget: structuredClone(desiredTarget), legacyPreviousTarget: null,
      desiredWorker: { workerId, modelProfileId, image: desiredTarget.requiredImageDigest,
        configDigest: desiredTarget.requiredConfigDigest, placementClass: "protected-resident",
        maintenanceGeneration: 7 } };
  });
  const faultInjection = { stageOrder: 6, targetKey: "office.drawing-flux2",
    injectionPoint: "after-stage-health", failureCode: "protected_set_transition_stage_failed", oneShot: true };
  const requests = [];
  let mutateInspection = () => {};
  const client = new ProtectedNodeAgentClient({ nodeId: NODE, nodeGeneration: 7,
    transport: { async postCommand(request) {
      requests.push(request);
      const envelope = JSON.parse(request.body);
      if (envelope.type === "protected-set.transaction.execute") return {
        commandId: transactionId, nodeId: NODE, nodeGeneration: 7, fencingToken: 27,
        status: "failed", errorCode: faultInjection.failureCode, retryable: false,
      };
      const container = (index) => ({ containerName: `teamaibox-worker-${index + 1}`,
        containerId: String(index + 1).repeat(64),
        imageReference: `registry.local/office-${index + 1}@sha256:${String(index + 1).repeat(64)}`,
        imageId: `sha256:${String(index + 1).repeat(64)}`,
        imageManifestDigest: `sha256:${String(index + 1).repeat(64)}`,
        runtimeDigest: `sha256:${"a".repeat(64)}`, networkMode: "compute-internal",
        state: "running", health: "healthy", startSpecDigest: `sha256:${"b".repeat(64)}`,
        oomKilled: false, exact: true });
      const response = { commandId: envelope.commandId, nodeId: NODE, nodeGeneration: 7, fencingToken: 1,
        status: "succeeded", payload: {
          schemaVersion: 1, readOnly: true, mutationCount: 0, nodeId: NODE, nodeGeneration: 7,
          transactionId, setId: "office.baseline", qualificationId: "protected-office-set-v5",
          qualificationDigest, protectedTargetPolicyDigest: targetPolicyDigest, runtimeState: "canonical-exact",
          journal: { transactionId, setId: "office.baseline", desiredStateRevision: 16,
            maintenanceGeneration: 7, journalRevision: 27, phase: "recovered", nextOperation: 0,
            planDigest: `sha256:${"f".repeat(64)}`, failureCode: faultInjection.failureCode,
            faultInjectionConsumed: true, faultInjectionStageOrder: 6,
            faultInjectionTargetKey: "office.drawing-flux2", faultInjectionAfterHealthy: true,
            updatedAt: "2026-08-11T08:00:01.000Z" },
          targets: targetKeys.map((targetKey, index) => ({ targetKey, stageOrder: index + 1,
            workerId: targets[index].desiredTarget.workerId, modelProfileId: targets[index].desiredTarget.modelProfileId,
            runtimeState: "canonical-exact", canonicalPrevious: container(index), desiredCompanions: [],
            legacyDependents: [], mountsExact: false, readOnlyModelMount: false, modelMaterialMode: "",
            healthcheckExact: false, runtimeLimitsExact: false, legacyHostNetworkRemoved: false,
            tmpfsExecutable: false })),
          rollbackTargetKeys: [...targetKeys].reverse(), canonicalContainersRemaining: [],
          rollbackContainersRemaining: [], transitionHelpersRemaining: [], oomKilled: false,
          restartPersistenceObserved: false,
        } };
      // Real Go protectedTransitionSnapshot emits imageManifestDigest for the
      // pinned OCR companion, but omits startSpecDigest for prior dependents.
      const companion = { ...container(2), containerName: "teamaibox-protected-office-ocr-provider-v1" };
      delete companion.startSpecDigest;
      response.payload.targets[2].canonicalDependents = [companion];
      mutateInspection(response.payload);
      return response;
    } },
    commandSigner: { async sign() { return { keyId: "scheduler-a", nonce: "nonce-qualification",
      signature: "signed-qualification" }; } },
    workerSpecFactory: { async buildStartPayload({ worker }) { return { ...worker, attemptId: ATTEMPT }; } },
    clock: () => new Date("2026-08-11T08:00:00.000Z"), idFactory: () => COMMAND,
  });
  const executeRequest = {
    transactionId, setId: "office.baseline", desiredStateRevision: 16,
    workerIds: targets.map((item) => item.desiredTarget.workerId),
    allowedOperations: ["protected-set.transition"],
    operationOrder: ["protected.inspect", "protected.stage", "protected.verify", "protected.commit"],
    maintenanceGeneration: 7, issuedAt: "2026-08-11T07:59:00.000Z",
    expiresAt: "2026-08-11T08:10:00.000Z", journalRevision: 27,
    qualificationId: "protected-office-set-v5", qualificationDigest, faultInjection, targets,
    authority: { leaseId: transactionId, fencingToken: 27, nodeGeneration: 7 },
    correlationId: "protected-transition:qualification-a",
  };
  await assert.rejects(client.executeProtectedSetTransition(executeRequest),
    (error) => error?.code === faultInjection.failureCode);
  const executePayload = JSON.parse(requests[0].body).payload;
  assert.equal(executePayload.qualificationId, "protected-office-set-v5");
  assert.equal(executePayload.targets.every((item) => item.previousTarget != null), true);

  const inspection = await client.inspectProtectedSetTransition({ transactionId,
    qualificationId: "protected-office-set-v5", qualificationDigest,
    protectedTargetPolicyDigest: targetPolicyDigest, mode: "fault", faultInjection,
    correlationId: "protected-transition:qualification-inspect" });
  assert.equal(inspection.runtimeState, "canonical-exact");
  assert.equal(inspection.journal.faultInjectionConsumed, true);
  assert.equal(inspection.targets[2].canonicalDependents[0].imageManifestDigest, `sha256:${"3".repeat(64)}`);
  assert.equal(JSON.parse(requests[1].body).payload.migrationPlanId, undefined);
  for (const mutate of [
    (item) => { item.imageManifestDigest = `sha256:${"9".repeat(64)}`; },
    (item) => { delete item.imageManifestDigest; },
    (item) => { item.startSpecDigest = `sha256:${"a".repeat(64)}`; },
    (item) => { item.imageReference = "registry.local/ocr-provider:unpinned"; },
    (item) => { item.health = "unhealthy"; },
    (item) => { item.oomKilled = true; },
  ]) {
    mutateInspection = (value) => mutate(value.targets[2].canonicalDependents[0]);
    await assert.rejects(client.inspectProtectedSetTransition({ transactionId,
      qualificationId: "protected-office-set-v5", qualificationDigest,
      protectedTargetPolicyDigest: targetPolicyDigest, mode: "fault", faultInjection,
      correlationId: "protected-transition:qualification-inspect-reject" }),
    (error) => error?.code === "node_agent_protocol_mismatch");
  }
  mutateInspection = (value) => { value.targets[0].canonicalPrevious.imageManifestDigest = `sha256:${"9".repeat(64)}`; };
  await assert.rejects(client.inspectProtectedSetTransition({ transactionId,
    qualificationId: "protected-office-set-v5", qualificationDigest,
    protectedTargetPolicyDigest: targetPolicyDigest, mode: "fault", faultInjection,
    correlationId: "protected-transition:qualification-inspect-primary-drift" }),
  (error) => error?.code === "node_agent_protocol_mismatch");
  const missingPrior = structuredClone(executeRequest);
  missingPrior.targets[0].previousTarget = null;
  await assert.rejects(client.executeProtectedSetTransition(missingPrior), /transition target 0 is invalid/);
  const driftedPrior = structuredClone(executeRequest);
  driftedPrior.targets[0].previousTarget.requiredConfigDigest = `sha256:${"9".repeat(64)}`;
  await assert.rejects(client.executeProtectedSetTransition(driftedPrior), /transition target 0 is invalid/);
  await assert.rejects(client.executeProtectedSetTransition({ ...executeRequest,
    migrationPlanId: "legacy-office-v1", migrationPlanDigest: `sha256:${"9".repeat(64)}` }),
  /authority is ambiguous/);
});
