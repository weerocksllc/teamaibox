import assert from "node:assert/strict";
import test from "node:test";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { MemoryProtectedOfficeSetRepository } from "../src/memory-protected-office-set-repository.mjs";
import { ProtectedOfficeSetCoordinator } from "../src/protected-office-set-coordinator.mjs";
import { UnifiedMemoryGuard } from "../src/unified-memory-guard.mjs";

const GIB = 2 ** 30;
const NOW = new Date("2026-09-04T07:30:00.000Z");
const IMAGE_A = `sha256:${"a".repeat(64)}`;
const IMAGE_B = `sha256:${"b".repeat(64)}`;
const CONFIG_A = `sha256:${"c".repeat(64)}`;
const CONFIG_B = `sha256:${"d".repeat(64)}`;

function profile(workerId, modelProfileId, imageDigest, configurationDigest, declaredResidentBytes,
  dependsOnWorkerIds = [], stageOrder = 0) {
  return { workerId, modelProfileId, imageDigest, configurationDigest,
    declaredResidentBytes, dependsOnWorkerIds, stageOrder,
    placementClass: "protected-resident", maintenanceGeneration: 7 };
}

function manifest(overrides = {}) {
  const profiles = overrides.profiles ?? [
    profile("office.embedding", "model.embedding", IMAGE_A, CONFIG_A, 8 * GIB, [], 1),
    profile("office.assistant", "model.assistant", IMAGE_B, CONFIG_B, 20 * GIB, ["office.embedding"], 2),
  ];
  return {
    setId: "office.baseline", nodeId: "node.appliance-core", desiredStateRevision: 3,
    maintenanceGeneration: 7, requiredModelProfileIds: profiles.map((value) => value.modelProfileId),
    profiles, ...overrides,
  };
}

function identity(value, { state = "running", healthy = true, residentBytes = value.declaredResidentBytes } = {}) {
  return { workerId: value.workerId, modelProfileId: value.modelProfileId,
    imageDigest: value.imageDigest, configurationDigest: value.configurationDigest,
    placementClass: "protected-resident", maintenanceGeneration: value.maintenanceGeneration,
    state, healthy, residentBytes };
}

function fixture({ initial = {}, failProbeWorkerId = null, failRestoreWorkerId = null,
  repository = new MemoryProtectedOfficeSetRepository(), maintenanceAuthorizer = null,
  memorySnapshot = null, memoryDecision = null, coreMemoryBudget = null } = {}) {
  const calls = [];
  const current = structuredClone(initial);
  const runtime = {
    async inspectProtectedProfile({ profile: value }) {
      calls.push(`inspect:${value.workerId}`);
      return current[value.workerId] ?? { ...identity(value), state: "absent", healthy: false, residentBytes: 0 };
    },
    async stageProtectedProfile({ profile: value }) {
      calls.push(`stage:${value.workerId}`);
      current[value.workerId] = identity(value);
    },
    async transitionProtectedSet({ profiles }) {
      calls.push("transition:set");
      for (const value of profiles) {
        calls.push(`stage:${value.workerId}`);
        current[value.workerId] = identity(value);
      }
      return {
        transactionId: "protected-set-tx-0003",
        setId: "office.baseline",
        desiredStateRevision: 3,
        maintenanceGeneration: 7,
        journalRevision: 3,
        phase: "complete",
        nextOperation: 0,
        planDigest: `sha256:${"a".repeat(64)}`,
      };
    },
    async probeProtectedProfile({ profile: value }) {
      calls.push(`probe:${value.workerId}`);
      if (value.workerId === failProbeWorkerId) throw Object.assign(new Error("warm probe failed"), { code: "probe_failed" });
      return current[value.workerId];
    },
    async restoreProtectedProfile({ profile: value, previousIdentity }) {
      calls.push(`restore:${value.workerId}`);
      if (value.workerId === failRestoreWorkerId) throw Object.assign(new Error("restore failed"), { code: "restore_failed" });
      current[value.workerId] = previousIdentity;
    },
  };
  const memoryEvaluations = [];
  const corePhases = [];
  const subject = new ProtectedOfficeSetCoordinator({
    repository, runtime,
    memorySnapshotProvider: { async snapshot() { return memorySnapshot ?? {
      nodeId: "node.appliance-core", observedAt: NOW.toISOString(),
      host: { totalBytes: 128 * GIB, availableBytes: 80 * GIB, observedAt: NOW.toISOString() },
    }; } },
    memoryGuard: { evaluate(snapshot) { memoryEvaluations.push(snapshot); return memoryDecision ?? {
      admission: { allowed: true }, unifiedMemory: { remainingAfterRequestBytes: 20 * GIB }, reasons: [],
    }; } },
    maintenanceAuthorizer,
    coreServiceProbe: async ({ phase }) => { corePhases.push(phase); return { healthy: true }; },
    clock: () => NOW,
    idFactory: () => "protected-set-tx-0003",
    coreMemoryBudget,
  });
  return { subject, repository, runtime, calls, current, memoryEvaluations, corePhases };
}

test("qualification fault forces a real transaction, rolls it back, and preserves the exact error", async () => {
  const value = manifest({ desiredStateRevision: 8 });
  const initial = Object.fromEntries(value.profiles.map((item) => [item.workerId, identity(item)]));
  let authorizationCalls = 0;
  const setup = fixture({ initial, maintenanceAuthorizer: async ({ context, operation, workers }) => {
    authorizationCalls += 1;
    return { authorized: true, signatureVerified: true, transactionId: context.transactionId,
      workerIds: workers.map((worker) => worker.workerId), operation,
      maintenanceGeneration: context.maintenanceGeneration };
  } });
  const qualificationFault = { qualificationId: "protected-office-set-v5",
    qualificationDigest: `sha256:${"e".repeat(64)}`,
    protectedTargetPolicyDigest: `sha256:${"f".repeat(64)}`,
    faultInjection: { stageOrder: 2, targetKey: "office.assistant", injectionPoint: "after-stage-health",
      failureCode: "protected_set_transition_stage_failed", oneShot: true } };
  setup.runtime.transitionProtectedSet = async (input) => {
    setup.calls.push("transition:qualification");
    assert.deepEqual(input.qualificationFault, qualificationFault);
    throw new PlatformError("protected_set_transition_stage_failed", "expected qualification fault", { status: 409 });
  };
  const maintenanceContext = { transactionId: "protected-set-tx-qualification", workerIds: value.profiles.map((item) => item.workerId),
    allowedOperations: ["protected-set.maintenance"], maintenanceGeneration: 7,
    issuedAt: new Date(NOW.getTime() - 1_000).toISOString(), expiresAt: new Date(NOW.getTime() + 60_000).toISOString() };
  await assert.rejects(setup.subject.boot({ manifest: value, maintenanceContext, qualificationFault }),
    (error) => error?.code === "protected_set_transition_stage_failed");
  const transaction = await setup.repository.getTransaction(maintenanceContext.transactionId);
  assert.equal(authorizationCalls, 1);
  assert.equal(transaction.state, "rolled-back");
  assert.equal(transaction.failureCode, "protected_set_transition_stage_failed");
  assert.deepEqual(setup.calls.filter((item) => item.startsWith("restore:")),
    ["restore:office.assistant", "restore:office.embedding"]);
});

test("qualification fault rejects a drifted live set before authorization or transaction", async () => {
  const value = manifest({ desiredStateRevision: 8 });
  const initial = Object.fromEntries(value.profiles.map((item) => [item.workerId, identity(item)]));
  initial[value.profiles[0].workerId].configurationDigest = `sha256:${"f".repeat(64)}`;
  let authorizationCalls = 0;
  const setup = fixture({ initial, maintenanceAuthorizer: async () => {
    authorizationCalls += 1;
    return { authorized: true };
  } });
  const qualificationFault = { qualificationId: "protected-office-set-v5",
    qualificationDigest: `sha256:${"e".repeat(64)}`,
    protectedTargetPolicyDigest: `sha256:${"f".repeat(64)}`,
    faultInjection: { stageOrder: 2, targetKey: "office.assistant", injectionPoint: "after-stage-health",
      failureCode: "protected_set_transition_stage_failed", oneShot: true } };
  const maintenanceContext = { transactionId: "protected-set-tx-qualification", workerIds: value.profiles.map((item) => item.workerId),
    allowedOperations: ["protected-set.maintenance"], maintenanceGeneration: 7,
    issuedAt: new Date(NOW.getTime() - 1_000).toISOString(), expiresAt: new Date(NOW.getTime() + 60_000).toISOString() };
  await assert.rejects(setup.subject.boot({ manifest: value, maintenanceContext, qualificationFault }),
    (error) => error?.code === "protected_set_qualification_baseline_drift");
  assert.equal(authorizationCalls, 0);
  assert.equal(await setup.repository.getTransaction(maintenanceContext.transactionId), null);
});

test("protected office set admits once, stages in dependency order, and does not apply the 96 GiB standalone gate", async () => {
  const repository = new MemoryProtectedOfficeSetRepository();
  const updates = [];
  const updateTransaction = repository.updateTransaction.bind(repository);
  repository.updateTransaction = async (...args) => {
    updates.push(structuredClone(args[2]));
    return updateTransaction(...args);
  };
  const setup = fixture({ repository });
  const result = await setup.subject.boot({ manifest: manifest() });

  assert.equal(result.state, "healthy");
  assert.deepEqual(setup.calls.filter((value) => value.startsWith("stage:") || value.startsWith("probe:")), [
    "stage:office.embedding", "stage:office.assistant",
    "probe:office.embedding", "probe:office.assistant",
  ]);
  assert.equal(setup.memoryEvaluations.length, 1);
  assert.equal(setup.memoryEvaluations[0].host.availableBytes, 80 * GIB);
  assert.equal("controlPlaneFloorBytes" in setup.memoryEvaluations[0],false);
  assert.deepEqual(setup.corePhases, ["pre-admission", "after:office.embedding", "after:office.assistant"]);
  assert.equal(result.setState.aggregateResidentBytes, 28 * GIB);
  assert.equal(result.setState.observedStateRevision, 3);
  assert.equal(result.setState.recoveryState, "healthy");
  assert.equal(result.transition.transactionId, "protected-set-tx-0003");
  assert.equal(result.transition.phase, "complete");
  assert.equal(result.transition.nextOperation, 0);
  assert.deepEqual(updates[0].steps.map((step) => step.state), ["staging", "staging"]);
});







const measuredCoreBudget = { measuredPeakBytes: 19080568832, reserveBytes: 23085449216,
  growthPermille: 1200, evidenceDigest: "3a1be84300314d17687de6de43e74c20edd721558d93e428d089c1b3edf87c73" };
const coexistenceSnapshot = (availableGiB, extra = {}) => ({ nodeId: "node.appliance-core", observedAt: NOW.toISOString(),
  host: { totalBytes: 121 * GIB, availableBytes: availableGiB * GIB, observedAt: NOW.toISOString() },
  workers: [{ workerId: "phone", cgroup: { currentBytes: 2 * GIB } },
    { workerId: "windows", cgroup: { currentBytes: 6 * GIB } }],
  activeReservations: [{ reservationId: "phone", workerId: "phone", unifiedMemoryBytes: 6 * GIB },
    { reservationId: "windows", workerId: "windows", unifiedMemoryBytes: 10 * GIB }], ...extra,
});
const fullOfficeManifest = () => manifest({ profiles: [
  profile("office.embedding", "model.embedding", IMAGE_A, CONFIG_A, 32 * GIB, [], 1),
  profile("office.assistant", "model.assistant", IMAGE_B, CONFIG_B, 32 * GIB, ["office.embedding"], 2),
] });









test("protected office set rejects an incomplete set before memory admission or runtime mutation", async () => {
  const setup = fixture();
  const value = manifest();
  value.requiredModelProfileIds = ["model.embedding"];

  await assert.rejects(setup.subject.boot({ manifest: value }), { code: "protected_set_incomplete" });
  assert.deepEqual(setup.calls, []);
  assert.equal(setup.memoryEvaluations.length, 0);
});

test("protected office set rolls every member back in reverse order after a mid-sequence warm failure", async () => {
  const setup = fixture({ failProbeWorkerId: "office.assistant" });

  await assert.rejects(setup.subject.boot({ manifest: manifest() }), { code: "protected_set_stage_failed" });
  assert.deepEqual(setup.calls.filter((value) => value.startsWith("restore:")), [
    "restore:office.assistant", "restore:office.embedding",
  ]);
  const transaction = await setup.repository.getTransaction("protected-set-tx-0003");
  assert.equal(transaction.state, "rolled-back");
  const state = await setup.repository.getSetState("office.baseline");
  assert.equal(state.recoveryState, "degraded");
  assert.equal(state.recoveryReasonCode, "probe_failed");
});

test("incomplete rollback is journaled as manual recovery and never reported healthy", async () => {
  const setup = fixture({ failProbeWorkerId: "office.assistant", failRestoreWorkerId: "office.embedding" });

  await assert.rejects(setup.subject.boot({ manifest: manifest() }), { code: "protected_set_rollback_incomplete" });
  assert.equal((await setup.repository.getTransaction("protected-set-tx-0003")).state, "recovery-required");
  assert.equal((await setup.repository.getSetState("office.baseline")).recoveryState, "manual-recovery");
});

test("replacing a loaded protected identity fails closed without exact generation-bound maintenance", async () => {
  const value = manifest();
  const stale = identity(value.profiles[0]);
  stale.imageDigest = `sha256:${"e".repeat(64)}`;
  const setup = fixture({ initial: { "office.embedding": stale } });

  await assert.rejects(setup.subject.boot({ manifest: value }), {
    code: "protected_resident_maintenance_required",
  });
  assert.equal(setup.calls.some((call) => call.startsWith("stage:")), false);
  assert.deepEqual(await setup.repository.listIncompleteTransactions(), []);
});

test("a changed loaded subset cannot authorize maintenance of only that subset", async () => {
  const value = manifest();
  const stale = identity(value.profiles[0]);
  stale.imageDigest = `sha256:${"e".repeat(64)}`;
  let authorizerCalled = false;
  const setup = fixture({
    initial: { "office.embedding": stale },
    maintenanceAuthorizer: async () => { authorizerCalled = true; return { authorized: true }; },
  });
  const context = {
    transactionId: "maintenance-tx-subset", workerIds: ["office.embedding"],
    allowedOperations: ["protected-set.maintenance"], maintenanceGeneration: 7,
    issuedAt: new Date(NOW.getTime() - 1_000).toISOString(), expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  };

  await assert.rejects(setup.subject.boot({ manifest: value, maintenanceContext: context }), {
    code: "protected_resident_maintenance_scope_mismatch",
  });
  assert.equal(authorizerCalled, false);
  assert.equal(setup.calls.some((call) => call.startsWith("stage:")), false);
  assert.deepEqual(await setup.repository.listIncompleteTransactions(), []);
});

test("replacing a loaded protected identity accepts an exact signed maintenance set", async () => {
  const value = manifest();
  const stale = identity(value.profiles[0]);
  stale.imageDigest = `sha256:${"e".repeat(64)}`;
  const setup = fixture({
    initial: { "office.embedding": stale },
    maintenanceAuthorizer: async ({ context, operation, workers }) => ({
      authorized: true, signatureVerified: true, transactionId: context.transactionId,
      workerIds: workers.map((worker) => worker.workerId), operation,
      maintenanceGeneration: context.maintenanceGeneration,
    }),
  });
  const context = {
    transactionId: "maintenance-tx-0001", workerIds: ["office.embedding", "office.assistant"],
    allowedOperations: ["protected-set.maintenance"], maintenanceGeneration: 7,
    issuedAt: new Date(NOW.getTime() - 1_000).toISOString(), expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  };

  const result = await setup.subject.boot({ manifest: value, maintenanceContext: context });
  assert.equal(result.state, "healthy");
  assert.equal(result.transaction.transactionId, context.transactionId);
  assert.deepEqual(result.transaction.maintenanceAuthorization, {
    transactionId: context.transactionId,
    workerIds: ["office.assistant", "office.embedding"],
    allowedOperations: ["protected-set.maintenance"],
    maintenanceGeneration: 7,
    issuedAt: context.issuedAt,
    expiresAt: context.expiresAt,
  });
});

test("recovery inspects the complete set and restores persisted identities after a scheduler restart", async () => {
  const value = manifest();
  const repository = new MemoryProtectedOfficeSetRepository({ transactions: [{
    transactionId: "protected-set-tx-0004", revision: 4, setId: value.setId, nodeId: value.nodeId,
    desiredStateRevision: value.desiredStateRevision, maintenanceGeneration: 7, state: "probing",
    manifest: value,
    previousIdentities: {
      "office.embedding": { ...identity(value.profiles[0]), state: "unloaded", healthy: false, residentBytes: 0 },
      "office.assistant": { ...identity(value.profiles[1]), state: "unloaded", healthy: false, residentBytes: 0 },
    },
    steps: [], recoverySteps: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  }] });
  const setup = fixture({ repository });
  const result = await setup.subject.recover({ transactionId: "protected-set-tx-0004" });

  assert.equal(result.state, "rolled-back");
  assert.deepEqual(setup.calls, [
    "inspect:office.embedding", "inspect:office.assistant",
    "restore:office.assistant", "restore:office.embedding",
  ]);
});



test("real unified-memory guard admits aggregate boot below 96 GiB while retaining core and transient reserves", async () => {
  const value = manifest({ profiles: [profile("office.embedding", "model.embedding", IMAGE_A, CONFIG_A, 28 * GIB)] });
  const current = {};
  const subject = new ProtectedOfficeSetCoordinator({
    repository: new MemoryProtectedOfficeSetRepository(),
    runtime: {
      async inspectProtectedProfile({ profile: item }) {
        return current[item.workerId] ?? { ...identity(item), state: "absent", healthy: false, residentBytes: 0 };
      },
      async stageProtectedProfile({ profile: item }) { current[item.workerId] = identity(item); },
      async transitionProtectedSet({ profiles }) {
        for (const item of profiles) current[item.workerId] = identity(item);
        return { phase: "complete" };
      },
      async probeProtectedProfile({ profile: item }) { return current[item.workerId]; },
      async restoreProtectedProfile({ profile: item, previousIdentity }) { current[item.workerId] = previousIdentity; },
    },
    memorySnapshotProvider: { async snapshot() { return {
      nodeId: value.nodeId, observedAt: NOW.toISOString(),
      host: { totalBytes: 128 * GIB, availableBytes: 80 * GIB, observedAt: NOW.toISOString(), pressure: {} },
      driver: { dedicatedMemory: { status: "unsupported" } }, workers: [], activeReservations: [],
    }; } },
    memoryGuard: new UnifiedMemoryGuard(),
    clock: () => NOW, idFactory: () => "protected-set-tx-0099",
  });

  assert.equal((await subject.boot({ manifest: value })).state, "healthy");
});

test("aggregate admission fails closed on stale memory evidence before the first stage", async () => {
  const value = manifest({ profiles: [profile("office.embedding", "model.embedding", IMAGE_A, CONFIG_A, 8 * GIB)] });
  let staged = false;
  const subject = new ProtectedOfficeSetCoordinator({
    repository: new MemoryProtectedOfficeSetRepository(),
    runtime: {
      async inspectProtectedProfile({ profile: item }) { return { ...identity(item), state: "absent", healthy: false, residentBytes: 0 }; },
      async stageProtectedProfile() { staged = true; },
      async transitionProtectedSet() { staged = true; },
      async probeProtectedProfile() { throw new Error("not reached"); },
      async restoreProtectedProfile() {},
    },
    memorySnapshotProvider: { async snapshot() { return {
      observedAt: new Date(NOW.getTime() - 20_000).toISOString(),
      host: { totalBytes: 128 * GIB, availableBytes: 100 * GIB,
        observedAt: new Date(NOW.getTime() - 20_000).toISOString() },
    }; } },
    clock: () => NOW, idFactory: () => "protected-set-tx-0100",
  });

  await assert.rejects(subject.boot({ manifest: value }), { code: "protected_set_memory_evidence_stale" });
  assert.equal(staged, false);
});

test("aggregate admission binds every profile to its current protected placement revision", async () => {
  const value = manifest({ profiles: [profile("office.embedding", "model.embedding", IMAGE_A, CONFIG_A, 8 * GIB)] });
  let inspected = false;
  const subject = new ProtectedOfficeSetCoordinator({
    repository: new MemoryProtectedOfficeSetRepository(),
    placementRepository: { async getModelProfilePlacement() { return {
      profile: { placementClass: "protected-resident", maintenanceGeneration: 7 },
      currentRevision: { configurationDigest: CONFIG_B, maintenanceGeneration: 7 },
    }; } },
    runtime: {
      async inspectProtectedProfile() { inspected = true; },
      async stageProtectedProfile() {}, async transitionProtectedSet() {}, async probeProtectedProfile() {}, async restoreProtectedProfile() {},
    },
    memorySnapshotProvider: { async snapshot() { throw new Error("not reached"); } },
    clock: () => NOW, idFactory: () => "protected-set-tx-0101",
  });

  await assert.rejects(subject.boot({ manifest: value }), { code: "protected_set_placement_stale" });
  assert.equal(inspected, false);
});

test("healthy office startup has no aggregate model/core/transient reservation gate",async()=>{
 const setup=fixture({memorySnapshot:coexistenceSnapshot(1)});
 const result=await setup.subject.boot({manifest:fullOfficeManifest()});
 assert.equal(result.state,"healthy");
 assert.equal("requiredAvailableBytes" in (await setup.repository.getTransaction("protected-set-tx-0003")).admission,false);
});
