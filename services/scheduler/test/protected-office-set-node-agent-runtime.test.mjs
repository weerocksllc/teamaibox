import assert from "node:assert/strict";
import test from "node:test";

import { MemoryProtectedOfficeSetRepository } from "../src/memory-protected-office-set-repository.mjs";
import { ManagedNodeAgentRouter } from "../src/managed-node-agent-router.mjs";
import { NodeAgentWorkerSpecFactory } from "../src/node-agent-worker-spec-factory.mjs";
import { ProtectedNodeAgentClient } from "../src/protected-node-agent-client.mjs";
import { ProtectedOfficeSetCoordinator } from "../src/protected-office-set-coordinator.mjs";
import { ProtectedOfficeSetNodeAgentRuntime } from "../src/protected-office-set-node-agent-runtime.mjs";

const GIB = 2 ** 30;
const NOW = new Date("2026-09-04T08:00:00.000Z");
const NODE = "00000000-0000-4000-8000-000000000101";
const WORKER_A = "00000000-0000-4000-8000-000000000201";
const WORKER_B = "00000000-0000-4000-8000-000000000202";
const PROFILE_A = "00000000-0000-4000-8000-000000000301";
const PROFILE_B = "00000000-0000-4000-8000-000000000302";
const TRANSACTION = "00000000-0000-4000-8000-000000000401";
const IMAGE_A = `sha256:${"a".repeat(64)}`;
const IMAGE_B = `sha256:${"b".repeat(64)}`;
const CONFIG_A = `sha256:${"c".repeat(64)}`;
const CONFIG_B = `sha256:${"d".repeat(64)}`;

function officeProfiles() {
  return [{
    workerId: WORKER_A, modelProfileId: PROFILE_A, imageDigest: IMAGE_A,
    configurationDigest: CONFIG_A, placementClass: "protected-resident", maintenanceGeneration: 7,
    declaredResidentBytes: 8 * GIB, dependsOnWorkerIds: [], stageOrder: 1,
  }, {
    workerId: WORKER_B, modelProfileId: PROFILE_B, imageDigest: IMAGE_B,
    configurationDigest: CONFIG_B, placementClass: "protected-resident", maintenanceGeneration: 7,
    declaredResidentBytes: 12 * GIB, dependsOnWorkerIds: [WORKER_A], stageOrder: 2,
  }];
}

function imageReference(digest) {
  return `registry.local/office-worker@${digest}`;
}

function runtimeInstance(workerId) {
  const suffix = workerId.slice(-1);
  return { containerId: suffix.repeat(64), startedAt: NOW.toISOString() };
}

function fixture({ authorizer = async ({ context, operation, workers }) => ({
  authorized: true, signatureVerified: true, transactionId: context.transactionId,
  workerIds: workers.map((worker) => worker.workerId), operation,
  maintenanceGeneration: context.maintenanceGeneration,
}), protectedProfiles = officeProfiles(), boundIdentities = new Map(), targetTransform = (value) => value } = {}) {
  const calls = [];
  const states = new Map();
  const bindingFactory = async ({ profile, previousIdentity, purpose }) => {
    const expected = previousIdentity
      ?? (purpose === "inspect" ? boundIdentities.get(profile.workerId) : null)
      ?? profile;
    return {
      worker: {
        nodeId: NODE, nodeGeneration: 5, workerId: expected.workerId,
        attemptId: expected.workerId === WORKER_A
          ? "00000000-0000-4000-8000-000000000501" : "00000000-0000-4000-8000-000000000502",
        modelProfileId: expected.modelProfileId, image: imageReference(expected.imageDigest),
        placementClass: "protected-resident", maintenanceGeneration: expected.maintenanceGeneration,
        configDigest: expected.configurationDigest,
      },
      authority: {
        leaseId: expected.workerId === WORKER_A
          ? "00000000-0000-4000-8000-000000000601" : "00000000-0000-4000-8000-000000000602",
        fencingToken: 11, nodeGeneration: 5,
      },
      residentBytes: profile.declaredResidentBytes,
      correlationId: `protected-runtime:${expected.workerId}`,
    };
  };
  const maintenanceTargetFactory = async ({ profile, purpose }) => {
    // Production wiring requires an explicit purpose even for exact targets.
    assert.equal(typeof purpose, "string");
    assert.ok(purpose.length >= 3);
    return targetTransform({
    targetKey: profile.workerId === WORKER_A ? "office.embedding" : "office.assistant",
    workerId: profile.workerId, modelProfileId: profile.modelProfileId,
    containerName: profile.workerId === WORKER_A ? "office-embedding" : "office-assistant",
    placementClass: "protected-resident", maintenanceGeneration: profile.maintenanceGeneration,
    stageOrder: profile.stageOrder, dependsOnWorkerIds: [...profile.dependsOnWorkerIds],
    requiredImageId: `sha256:${profile.workerId === WORKER_A ? "1".repeat(64) : "2".repeat(64)}`,
    requiredImageDigest: imageReference(profile.imageDigest), requiredConfigDigest: profile.configurationDigest,
    requiredLabels: { "com.teamaibox.worker-id": profile.workerId }, dependentContainers: [],
    }, purpose, profile);
  };
  const router = {
    async workerHealth(input) {
      calls.push(["workerHealth", structuredClone(input)]);
      if (!states.has(input.workerId)) {
        const error = new Error("absent");
        error.code = "managed_worker_not_found";
        throw error;
      }
      return structuredClone(states.get(input.workerId));
    },
    async startWorker(input) {
      calls.push(["startWorker", structuredClone(input)]);
      const worker = input.worker;
      const state = {
        workerId: worker.workerId, modelProfileId: worker.modelProfileId,
        status: "running", health: "healthy", image: worker.image,
        placementClass: worker.placementClass, maintenanceGeneration: worker.maintenanceGeneration,
        configDigest: worker.configDigest, ...runtimeInstance(worker.workerId),
      };
      states.set(worker.workerId, state);
      return structuredClone(state);
    },
    async executeProtectedMaintenanceTransaction(input) {
      calls.push(["executeProtectedMaintenanceTransaction", structuredClone(input)]);
      return {
        transactionId: input.transactionId, maintenanceGeneration: input.maintenanceGeneration,
        journalRevision: input.journalRevision, phase: "complete", nextOperation: 0,
        planDigest: `sha256:${"f".repeat(64)}`,
      };
    },
    async executeProtectedSetTransition(input) {
      calls.push(["executeProtectedSetTransition", structuredClone(input)]);
      for (const target of input.targets) {
        const worker = target.desiredWorker;
        states.set(worker.workerId, {
          workerId: worker.workerId, modelProfileId: worker.modelProfileId,
          status: "running", health: "healthy", image: worker.image,
          placementClass: worker.placementClass, maintenanceGeneration: worker.maintenanceGeneration,
          configDigest: worker.configDigest, ...runtimeInstance(worker.workerId),
        });
      }
      return {
        transactionId: input.transactionId, setId: input.setId,
        desiredStateRevision: input.desiredStateRevision,
        maintenanceGeneration: input.maintenanceGeneration,
        journalRevision: input.journalRevision, phase: "complete", nextOperation: 0,
        planDigest: `sha256:${"e".repeat(64)}`,
      };
    },
    async inspectProtectedSetTransition(input) {
      calls.push(["inspectProtectedSetTransition", structuredClone(input)]);
      return { runtimeState: "canonical-exact", journal: { phase: "recovered" }, oomKilled: false };
    },
  };
  const runtime = new ProtectedOfficeSetNodeAgentRuntime({
    nodeAgentRouter: router, nodeId: NODE, nodeGeneration: 5, bindingFactory,
    maintenanceTargetFactory,
    protectedSetProvider: async () => ({ maintenanceGeneration: 7, profiles: structuredClone(protectedProfiles) }),
    maintenanceAuthorizer: authorizer, clock: () => NOW,
  });
  return { runtime, router, states, calls, protectedProfiles, boundIdentities };
}

for (const omitEmpty of [false, true]) test(`canonical qualification fault accepts exact targets with omitted empty arrays=${omitEmpty}`, async () => {
  let authorizationCalls = 0;
  const setup = fixture({ targetTransform(value, purpose) {
    if (omitEmpty && purpose === "previous") {
      if (value.dependsOnWorkerIds.length === 0) delete value.dependsOnWorkerIds;
      delete value.dependentContainers;
    }
    return value;
  }, authorizer: async ({ context, operation, workers }) => {
    authorizationCalls += 1;
    return { authorized: true, signatureVerified: true, transactionId: context.transactionId,
      workerIds: workers.map((worker) => worker.workerId), operation,
      maintenanceGeneration: context.maintenanceGeneration };
  } });
  const previousIdentities = {};
  for (const profile of setup.protectedProfiles) {
    previousIdentities[profile.workerId] = { ...profile, state: "running", healthy: true,
      residentBytes: profile.declaredResidentBytes };
  }
  const faultInjection = { stageOrder: 2, targetKey: "office.assistant",
    injectionPoint: "after-stage-health", failureCode: "protected_set_transition_stage_failed", oneShot: true };
  const qualificationFault = { qualificationId: "protected-office-set-v5",
    qualificationDigest: `sha256:${"a".repeat(64)}`,
    protectedTargetPolicyDigest: `sha256:${"b".repeat(64)}`, faultInjection };
  setup.router.executeProtectedSetTransition = async (input) => {
    setup.calls.push(["executeProtectedSetTransition", structuredClone(input)]);
    const error = new Error("expected fault");
    error.code = faultInjection.failureCode;
    throw error;
  };
  const maintenanceContext = { transactionId: TRANSACTION, workerIds: [WORKER_A, WORKER_B],
    allowedOperations: ["protected-set.maintenance"], maintenanceGeneration: 7,
    issuedAt: "2026-09-04T07:59:00.000Z", expiresAt: "2026-09-04T08:10:00.000Z" };
  await assert.rejects(setup.runtime.transitionProtectedSet({ transactionId: TRANSACTION,
    setId: "office.baseline", desiredStateRevision: 9, maintenanceGeneration: 7,
    profiles: setup.protectedProfiles, previousIdentities, maintenanceContext, qualificationFault }),
  (error) => error?.code === faultInjection.failureCode);
  const transition = setup.calls.find(([method]) => method === "executeProtectedSetTransition")[1];
  assert.equal(authorizationCalls, 1);
  assert.equal(transition.qualificationId, qualificationFault.qualificationId);
  assert.deepEqual(transition.faultInjection, faultInjection);
  assert.equal(transition.targets.every((target) => target.previousTarget != null), true);
  await setup.runtime.inspectProtectedSetQualificationFault({ transactionId: TRANSACTION, ...qualificationFault });
  const inspection = setup.calls.find(([method]) => method === "inspectProtectedSetTransition")[1];
  assert.equal(inspection.mode, "fault");
  assert.equal(inspection.protectedTargetPolicyDigest, qualificationFault.protectedTargetPolicyDigest);
});

for (const field of ["dependentContainers", "requiredImageId", "requiredConfigDigest", "requiredLabels", "startSpec"]) {
  test(`canonical target normalization still rejects changed ${field} before mutation`, async () => {
    const setup = fixture({ targetTransform(value, purpose) {
      if (purpose === "previous") value[field] = field === "dependentContainers"
        ? [{ containerName: "unexpected-companion" }] : { changed: true };
      return value;
    } });
    const previousIdentities = Object.fromEntries(setup.protectedProfiles.map((profile) => [profile.workerId,
      { ...profile, state: "running", healthy: true, residentBytes: profile.declaredResidentBytes }]));
    const qualificationFault = { qualificationId: "protected-office-set-v5",
      qualificationDigest: `sha256:${"a".repeat(64)}`, protectedTargetPolicyDigest: `sha256:${"b".repeat(64)}`,
      faultInjection: { stageOrder: 2, targetKey: "office.assistant", injectionPoint: "after-stage-health",
        failureCode: "protected_set_transition_stage_failed", oneShot: true } };
    const maintenanceContext = { transactionId: TRANSACTION, workerIds: [WORKER_A, WORKER_B],
      allowedOperations: ["protected-set.maintenance"], maintenanceGeneration: 7,
      issuedAt: "2026-09-04T07:59:00.000Z", expiresAt: "2026-09-04T08:10:00.000Z" };
    await assert.rejects(setup.runtime.transitionProtectedSet({ transactionId: TRANSACTION,
      setId: "office.baseline", desiredStateRevision: 9, maintenanceGeneration: 7,
      profiles: setup.protectedProfiles, previousIdentities, maintenanceContext, qualificationFault }));
    assert.equal(setup.calls.some(([method]) => method === "executeProtectedSetTransition"), false);
  });
}

test("canonical qualification rejects a non-canonical previous identity before Node Agent mutation", async () => {
  const setup = fixture({ authorizer: async ({ context, operation, workers }) => ({
    authorized: true, signatureVerified: true, transactionId: context.transactionId,
    workerIds: workers.map((worker) => worker.workerId), operation,
    maintenanceGeneration: context.maintenanceGeneration,
  }) });
  const previousIdentities = Object.fromEntries(setup.protectedProfiles.map((profile) => [profile.workerId, {
    ...profile, state: "running", healthy: true, residentBytes: profile.declaredResidentBytes,
  }]));
  previousIdentities[WORKER_A].configurationDigest = `sha256:${"f".repeat(64)}`;
  const qualificationFault = { qualificationId: "protected-office-set-v5",
    qualificationDigest: `sha256:${"a".repeat(64)}`,
    protectedTargetPolicyDigest: `sha256:${"b".repeat(64)}`,
    faultInjection: { stageOrder: 2, targetKey: "office.assistant", injectionPoint: "after-stage-health",
      failureCode: "protected_set_transition_stage_failed", oneShot: true } };
  const maintenanceContext = { transactionId: TRANSACTION, workerIds: [WORKER_A, WORKER_B],
    allowedOperations: ["protected-set.maintenance"], maintenanceGeneration: 7,
    issuedAt: "2026-09-04T07:59:00.000Z", expiresAt: "2026-09-04T08:10:00.000Z" };
  await assert.rejects(setup.runtime.transitionProtectedSet({ transactionId: TRANSACTION,
    setId: "office.baseline", desiredStateRevision: 9, maintenanceGeneration: 7,
    profiles: setup.protectedProfiles, previousIdentities, maintenanceContext, qualificationFault }),
  (error) => error?.code === "protected_set_qualification_baseline_drift");
  assert.equal(setup.calls.some(([method]) => method === "executeProtectedSetTransition"), false);
});

test("coordinator cold boot maps absent inspection, ordered stage, and exact probe to Node Agent routes", async () => {
  const setup = fixture();
  const profiles = setup.protectedProfiles;
  const coordinator = new ProtectedOfficeSetCoordinator({
    repository: new MemoryProtectedOfficeSetRepository(), runtime: setup.runtime,
    memorySnapshotProvider: { async snapshot() { return {
      observedAt: NOW.toISOString(),
      host: { totalBytes: 128 * GIB, availableBytes: 100 * GIB, observedAt: NOW.toISOString() },
    }; } },
    clock: () => NOW, idFactory: () => TRANSACTION,
  });
  const result = await coordinator.boot({ manifest: {
    setId: "office.baseline", nodeId: NODE, desiredStateRevision: 3, maintenanceGeneration: 7,
    requiredModelProfileIds: profiles.map((profile) => profile.modelProfileId), profiles,
  } });

  assert.equal(result.state, "healthy");
  assert.deepEqual(setup.calls.map(([method, input]) => `${method}:${input.workerId ?? input.worker?.workerId ?? "set"}`), [
    `workerHealth:${WORKER_A}`, `workerHealth:${WORKER_B}`,
    "executeProtectedSetTransition:set",
    `workerHealth:${WORKER_A}`, `workerHealth:${WORKER_B}`,
  ]);
  const transitions = setup.calls.filter(([method]) => method === "executeProtectedSetTransition");
  assert.equal(transitions.length, 1);
  const starts = transitions[0][1].targets.map((target) => target.desiredWorker);
  assert.deepEqual(starts.map((worker) => [worker.workerId, worker.placementClass,
    worker.maintenanceGeneration, worker.configDigest]), [
    [WORKER_A, "protected-resident", 7, CONFIG_A],
    [WORKER_B, "protected-resident", 7, CONFIG_B],
  ]);
  assert.equal(result.setState.aggregateResidentBytes, 20 * GIB);
});

test("loaded successor staging is rejected before any ordinary Node Agent start", async () => {
  const setup = fixture();
  const desired = setup.protectedProfiles[0];
  const previousIdentity = {
    ...desired, imageDigest: `sha256:${"e".repeat(64)}`, state: "running", healthy: true,
    residentBytes: desired.declaredResidentBytes,
  };
  await assert.rejects(setup.runtime.stageProtectedProfile({
    transactionId: TRANSACTION, maintenanceGeneration: 7, profile: desired, previousIdentity,
  }), { code: "protected_successor_requires_declarative_cutover" });
  assert.equal(setup.calls.length, 0);
});

test("inspection reports an exact loaded predecessor and changes it only through a complete-set transition", async () => {
  const desiredProfiles = officeProfiles();
  const predecessor = {
    ...desiredProfiles[0], imageDigest: `sha256:${"e".repeat(64)}`,
    configurationDigest: `sha256:${"9".repeat(64)}`,
  };
  let authorizationCalls = 0;
  const authorizer = async ({ context, operation, workers }) => {
    authorizationCalls += 1;
    return {
      authorized: true, signatureVerified: true, transactionId: context.transactionId,
      workerIds: workers.map((worker) => worker.workerId), operation,
      maintenanceGeneration: context.maintenanceGeneration,
    };
  };
  const boundIdentities = new Map([[WORKER_A, predecessor], [WORKER_B, desiredProfiles[1]]]);
  const setup = fixture({ authorizer, protectedProfiles: desiredProfiles, boundIdentities });
  for (const current of [predecessor, desiredProfiles[1]]) {
    setup.states.set(current.workerId, {
      workerId: current.workerId, modelProfileId: current.modelProfileId,
      status: "running", health: "healthy", image: imageReference(current.imageDigest),
      placementClass: current.placementClass, maintenanceGeneration: current.maintenanceGeneration,
      configDigest: current.configurationDigest, ...runtimeInstance(current.workerId),
    });
  }
  const observed = await setup.runtime.inspectProtectedProfile({ profile: desiredProfiles[0] });
  assert.equal(observed.imageDigest, predecessor.imageDigest);
  assert.equal(observed.configurationDigest, predecessor.configurationDigest);
  assert.deepEqual({ containerId: observed.containerId, startedAt: observed.startedAt },
    runtimeInstance(WORKER_A));

  const coordinator = new ProtectedOfficeSetCoordinator({
    repository: new MemoryProtectedOfficeSetRepository(), runtime: setup.runtime,
    maintenanceAuthorizer: authorizer,
    memorySnapshotProvider: { async snapshot() { return {
      observedAt: NOW.toISOString(),
      host: { totalBytes: 128 * GIB, availableBytes: 100 * GIB, observedAt: NOW.toISOString() },
    }; } },
    clock: () => NOW, idFactory: () => "00000000-0000-4000-8000-000000000499",
  });
  const result = await coordinator.boot({
    manifest: {
      setId: "office.baseline", nodeId: NODE, desiredStateRevision: 4, maintenanceGeneration: 7,
      requiredModelProfileIds: desiredProfiles.map((item) => item.modelProfileId), profiles: desiredProfiles,
    },
    maintenanceContext: {
      transactionId: TRANSACTION, workerIds: [WORKER_A, WORKER_B],
      allowedOperations: ["protected-set.maintenance"], maintenanceGeneration: 7,
      issuedAt: "2026-09-04T07:59:00.000Z", expiresAt: "2026-09-04T08:10:00.000Z",
    },
  });
  assert.equal(result.state, "healthy");
  assert.equal(authorizationCalls, 2);
  assert.equal(setup.calls.some(([method]) => method === "startWorker"), false);
  assert.equal(setup.calls.some(([method]) => method === "executeProtectedMaintenanceTransaction"), false);
  assert.equal(setup.calls.filter(([method]) => method === "executeProtectedSetTransition").length, 1);
  assert.deepEqual(setup.states.get(WORKER_A), {
    workerId: WORKER_A, modelProfileId: PROFILE_A, status: "running", health: "healthy",
    image: imageReference(IMAGE_A), placementClass: "protected-resident",
    maintenanceGeneration: 7, configDigest: CONFIG_A, ...runtimeInstance(WORKER_A),
  });
});

test("full-set maintenance verifies the administrator signature and sends exact reverse dependency order", async () => {
  let authorizerCalls = 0;
  const setup = fixture({ authorizer: async ({ context, operation, workers }) => {
    authorizerCalls += 1;
    return {
      authorized: true, signatureVerified: true, transactionId: context.transactionId,
      workerIds: workers.map((worker) => worker.workerId), operation,
      maintenanceGeneration: context.maintenanceGeneration,
    };
  } });
  const context = {
    transactionId: TRANSACTION, workerIds: [WORKER_A, WORKER_B],
    allowedOperations: ["protected-set.maintenance"], maintenanceGeneration: 7,
    issuedAt: "2026-09-04T07:59:00.000Z", expiresAt: "2026-09-04T08:10:00.000Z",
  };

  await assert.rejects(setup.runtime.executeProtectedSetMaintenance({
    profiles: [setup.protectedProfiles[0]], maintenanceContext: { ...context, workerIds: [WORKER_A] }, journalRevision: 1,
  }), { code: "protected_resident_maintenance_scope_mismatch" });
  assert.equal(authorizerCalls, 0);
  assert.equal(setup.calls.length, 0);

  const result = await setup.runtime.executeProtectedSetMaintenance({
    profiles: setup.protectedProfiles, maintenanceContext: context, journalRevision: 1,
  });
  assert.equal(result.phase, "complete");
  assert.equal(authorizerCalls, 1);
  const [method, request] = setup.calls.at(-1);
  assert.equal(method, "executeProtectedMaintenanceTransaction");
  assert.deepEqual(request.workerIds, [WORKER_B, WORKER_A]);
  assert.deepEqual(request.targets.map((target) => target.targetKey), ["office.assistant", "office.embedding"]);
  assert.equal(request.transactionId, TRANSACTION);
  assert.equal(request.maintenanceGeneration, 7);
});

test("complete-set maintenance crosses runtime, managed-node routing, signing, and the exact Agent wire envelope", async () => {
  let posted, signed;
  const profiles = officeProfiles();
  const client = new ProtectedNodeAgentClient({
    nodeId: NODE, nodeGeneration: 5,
    transport: { async postCommand(request) {
      posted = request;
      const envelope = JSON.parse(request.body);
      return {
        commandId: envelope.commandId, nodeId: NODE, nodeGeneration: 5,
        fencingToken: envelope.fencingToken, status: "succeeded",
        payload: {
          transactionId: TRANSACTION, maintenanceGeneration: 7, journalRevision: 1,
          phase: "complete", nextOperation: 0, planDigest: `sha256:${"f".repeat(64)}`,
        },
      };
    } },
    commandSigner: { async sign(value) {
      signed = value;
      return { keyId: "scheduler-a", nonce: "nonce-protected-set-a", signature: "signed-protected-set-a" };
    } },
    workerSpecFactory: new NodeAgentWorkerSpecFactory(), clock: () => NOW,
  });
  const router = new ManagedNodeAgentRouter({ localNodeId: NODE,
    nodeRepository: { async findNode() { return {
      nodeId: NODE, nodeKey: "spark-node-office", generation: 5, lifecycleState: "ready",
      certificateFingerprint: `sha256:${"7".repeat(64)}`,
    }; } },
    connectorFactory: async () => client,
  });
  const runtime = new ProtectedOfficeSetNodeAgentRuntime({
    nodeAgentRouter: router, nodeId: NODE, nodeGeneration: 5,
    bindingFactory: async () => { throw new Error("not reached"); },
    maintenanceTargetFactory: async ({ profile }) => ({
      targetKey: profile.workerId === WORKER_A ? "office.embedding" : "office.assistant",
      workerId: profile.workerId, modelProfileId: profile.modelProfileId,
      containerName: profile.workerId === WORKER_A ? "office-embedding" : "office-assistant",
      placementClass: "protected-resident", maintenanceGeneration: profile.maintenanceGeneration,
      stageOrder: profile.stageOrder, dependsOnWorkerIds: [...profile.dependsOnWorkerIds],
      requiredImageId: `sha256:${profile.workerId === WORKER_A ? "1".repeat(64) : "2".repeat(64)}`,
      requiredImageDigest: imageReference(profile.imageDigest), requiredConfigDigest: profile.configurationDigest,
      requiredLabels: { "com.teamaibox.worker-id": profile.workerId }, dependentContainers: [],
    }),
    protectedSetProvider: async () => ({ maintenanceGeneration: 7, profiles: structuredClone(profiles) }),
    maintenanceAuthorizer: async ({ context, operation, workers }) => ({
      authorized: true, signatureVerified: true, transactionId: context.transactionId,
      workerIds: workers.map((worker) => worker.workerId), operation,
      maintenanceGeneration: context.maintenanceGeneration,
    }),
    clock: () => NOW,
  });
  const result = await runtime.executeProtectedSetMaintenance({
    profiles,
    maintenanceContext: {
      transactionId: TRANSACTION, workerIds: [WORKER_A, WORKER_B],
      allowedOperations: ["protected-set.maintenance"], maintenanceGeneration: 7,
      issuedAt: "2026-09-04T07:59:00.000Z", expiresAt: "2026-09-04T08:10:00.000Z",
    },
    journalRevision: 1,
  });
  const envelope = JSON.parse(posted.body);
  assert.equal(result.phase, "complete");
  assert.equal(signed.body, posted.body);
  assert.equal(envelope.type, "maintenance.transaction.execute");
  assert.equal(envelope.commandId, TRANSACTION);
  assert.equal(envelope.leaseId, TRANSACTION);
  assert.equal(envelope.fencingToken, 1);
  assert.equal(envelope.issuedAt, "2026-09-04T07:59:00.000Z");
  assert.equal(envelope.deadlineAt, "2026-09-04T08:10:00.000Z");
  assert.deepEqual(envelope.payload.workerIds, [WORKER_B, WORKER_A]);
  assert.deepEqual(envelope.payload.operationOrder, ["protected.stop", "protected.restore", "protected.verify"]);
  assert.deepEqual(envelope.payload.targets.map((target) => [
    target.workerId, target.modelProfileId, target.requiredImageDigest, target.requiredConfigDigest,
  ]), [
    [WORKER_B, PROFILE_B, imageReference(IMAGE_B), CONFIG_B],
    [WORKER_A, PROFILE_A, imageReference(IMAGE_A), CONFIG_A],
  ]);
  assert.equal("password" in envelope.payload, false);
  assert.equal("endpoint" in envelope.payload, false);
});

test("signature decision drift prevents a complete-set maintenance wire command", async () => {
  const setup = fixture({ authorizer: async ({ context, operation }) => ({
    authorized: true, signatureVerified: true, transactionId: context.transactionId,
    workerIds: [WORKER_A], operation, maintenanceGeneration: context.maintenanceGeneration,
  }) });
  await assert.rejects(setup.runtime.executeProtectedSetMaintenance({
    profiles: setup.protectedProfiles,
    maintenanceContext: {
      transactionId: TRANSACTION, workerIds: [WORKER_A, WORKER_B],
      allowedOperations: ["protected-set.maintenance"], maintenanceGeneration: 7,
      issuedAt: "2026-09-04T07:59:00.000Z", expiresAt: "2026-09-04T08:10:00.000Z",
    }, journalRevision: 1,
  }), { code: "protected_resident_maintenance_denied" });
  assert.equal(setup.calls.length, 0);
});
