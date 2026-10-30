import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createProtectedOfficeSetProductionActionExecutorFactory,
  createProtectedOfficeSetProductionInspectionSourceFactory,
  createProtectedOfficeSetProductionResultAssembler,
  createProtectedOfficeSetProductionRuntimeFromEnvironment,
  protectedOfficeSetProductionScenarioContract,
  readProtectedOfficeAssistantAgentFact,
} from "../server/protected-office-set-production-scenarios.mjs";
import {
  encodeProtectedMaintenanceSignaturePayload,
} from "../../../services/scheduler/src/production-protected-maintenance-signature-verifier.mjs";
import { projectAuditMetadata } from "../src/audit/tamper-evident-audit-service.mjs";

const GiB = 2 ** 30;
const NOW = "2026-09-05T06:00:00.000Z";
const RUN = "protected-office-set-deployment-20260905-a9";
const ACTION_ID = "00000000-0000-5000-8000-000000000090";
const IDEMPOTENCY = `sha256:${"9".repeat(64)}`;
const NODE = "00000000-0000-5000-8000-000000000001";
const GROUP = "00000000-0000-5000-8000-000000000002";
const AUDITOR = "00000000-0000-5000-8000-000000000003";
const PROBE_JOB = "00000000-0000-5000-8000-000000000004";
const TRANSACTION = "00000000-0000-5000-8000-000000000005";

function uuid(number) {
  return `00000000-0000-5000-8000-${String(number).padStart(12, "0")}`;
}

function sha(character) { return `sha256:${character.repeat(64)}`; }

function runtimeIdentity(name, number) {
  return Object.freeze({
    containerName: name,
    containerId: `container-${number}`,
    imageId: sha(number),
    imageReference: `registry.local/teamaibox/${name}@${sha(number)}`,
    configDigest: sha(String.fromCharCode(number.charCodeAt(0) + 1)),
  });
}

function plan() {
  const slots = [
    "embedding-qwen3", "asr-whisper", "ocr-hunyuan",
    "translation-lmt4", "assistant-qwen38", "drawing-flux2",
  ];
  return {
    target: {
      nodeId: NODE, nodeGroupId: GROUP, nodeGeneration: 4,
      platformIdentity: runtimeIdentity("platform-api", "a"),
      nodeAgentIdentity: runtimeIdentity("node-agent", "c"),
    },
    profileSetManifest: { sha256: sha("f") },
    controller: { adapterDigest: sha("1"), driverModuleDigest: sha("2") },
    set: {
      setId: "office.baseline", desiredStateRevision: 20, maintenanceGeneration: 7,
      profiles: slots.map((slot, index) => ({
        slot,
        workerId: uuid(100 + index),
        modelProfileId: uuid(200 + index),
        imageReference: `registry.local/teamaibox/${slot}@${sha(String(index + 1))}`,
        configurationDigest: sha(String.fromCharCode(97 + index)),
        containerName: `protected-${slot}`,
        declaredResidentBytes: GiB,
        stageOrder: index + 1,
        dependsOnSlots: index === 0 ? [] : [slots[0]],
      })),
    },
    qualification: {
      maximumMaintenanceSeconds: 900,
      faultInjection: {
        slot: "drawing-flux2", failAfterStageOrder: 5,
        expectedFailureCode: "protected_set_transition_stage_failed",
      },
    },
  };
}

function transactionRow(value) {
  return {
    id: TRANSACTION,
    set_id: value.set.setId,
    node_id: value.target.nodeId,
    revision: 7,
    desired_state_revision: 20,
    maintenance_generation: 7,
    transaction_state: "succeeded",
    manifest: { profiles: [] },
    previous_identities: {},
    admission: {
      snapshot: {
        host: { observedAt: NOW },
        workers: value.set.profiles.map((profile) => ({
          workerId: profile.workerId,
          cgroup: { events: { high: 0, max: 0, oom: 0, oomKill: 0, oomGroupKill: 0 } },
        })),
      },
    },
    steps: [], recovery_steps: [], observed_identities: {}, failure_code: null,
    created_at: NOW, updated_at: NOW, completed_at: NOW,
  };
}

function setRow(value) {
  return {
    set_id: value.set.setId, node_id: value.target.nodeId, revision: 8,
    desired_state_revision: 20, observed_state_revision: 20,
    maintenance_generation: 7, recovery_state: "healthy", recovery_reason_code: null,
    healthy_identities: value.set.profiles.map((profile) => ({ workerId: profile.workerId })),
    aggregate_resident_bytes: 6 * GiB, last_transaction_id: TRANSACTION, updated_at: NOW,
  };
}

function metricRow(value) {
  return {
    node_id: value.target.nodeId, node_generation: value.target.nodeGeneration,
    sequence: 42, observed_at: NOW, received_at: NOW,
    stale_after_milliseconds: 30_000, snapshot_digest: sha("8"),
    snapshot: {
      domains: {
        unifiedMemory: {
          totalBytes: { status: "measured", value: 128 * GiB },
          availableBytes: { status: "measured", value: 64 * GiB },
        },
      },
      coreServices: [{
        serviceKey: "platform-api",
        state: "healthy",
        availabilityPercent: { status: "measured", value: 100 },
        errorRatePercent: {
          status: "unavailable", value: null,
          reasonCode: "service_error_rate_not_collected_at_node",
        },
      }, {
        serviceKey: "database-migrate",
        state: "unavailable",
        availabilityPercent: { status: "measured", value: 0 },
        errorRatePercent: {
          status: "unavailable", value: null,
          reasonCode: "service_error_rate_not_collected_at_node",
        },
      }],
      workers: value.set.profiles.map((profile) => ({
        workerId: profile.workerId,
        cgroup: {
          currentBytes: GiB / 2, peakBytes: GiB / 2,
          events: { high: 0, max: 0, oom: 0, oomKill: 0, oomGroupKill: 0 },
        },
        process: { residentBytes: GiB / 2 },
        engine: {
          status: "measured", allocatedBytes: GiB / 2,
          modelBytes: GiB / 3, cacheBytes: 0, certifiedEnvelopeBytes: GiB,
        },
        runtime: { oomKilled: false },
      })),
    },
  };
}

function jsonResponse(value, status = 200) {
  const bytes = Buffer.from(JSON.stringify(value));
  return Object.freeze({ status, async arrayBuffer() { return bytes; } });
}

function readDatabase(value, { bootstrap = false } = {}) {
  const statements = [];
  const tx = transactionRow(value);
  return {
    statements,
    async transaction(callback) { return callback(this); },
    async query(text, parameters = []) {
      statements.push({ text, parameters });
      if (/SELECT EXISTS/.test(text)) return { rows: [{ allowed: true }] };
      if (/SELECT admission,created_at FROM compute\.protected_office_set_transactions/.test(text)) {
        return { rows: bootstrap ? [] : [{ admission: tx.admission, created_at: tx.created_at }] };
      }
      if (/active_count/.test(text) && /protected_office_set_transactions/.test(text)) {
        return { rows: [{ active_count: 0, recovery_count: 0 }] };
      }
      if (/protected_office_set\.node_agent_checkpoint/.test(text)) {
        return { rows: bootstrap ? [] : [{
          event_id: uuid(301), event_hash: sha("3"),
          canonical_payload: { metadata: {
            agentOperationId: uuid(302), transactionId: TRANSACTION,
            setId: value.set.setId, nodeGeneration: value.target.nodeGeneration,
            journalRevision: 51, journalState: "complete", remainingOperationCount: 0,
            planDigest: sha("4"), responseDigest: sha("5"),
          } },
        }] };
      }
      if (/resource_kind='protected_office_deployment'/.test(text)) {
        return { rows: [{ event_id: uuid(303), event_hash: sha("6") }] };
      }
      if (/FROM compute\.protected_office_set_transactions/.test(text)) return { rows: bootstrap ? [] : [tx] };
      if (/FROM compute\.protected_office_sets/.test(text)) return { rows: bootstrap ? [] : [setRow(value)] };
      if (/FROM compute\.node_metric_snapshots/.test(text)) return { rows: [metricRow(value)] };
      if (/FROM compute\.realtime_sessions/.test(text)) {
        return { rows: [{ active_count: 0, media_count: 0, repository_revision: 12, active_ids: [] }] };
      }
      if (/FROM platform\.cast_sessions/.test(text)) {
        return { rows: [{ active_count: 0, repository_revision: 13 }] };
      }
      if (/SELECT id,status FROM compute\.jobs/.test(text)) {
        assert.deepEqual(parameters, [PROBE_JOB]);
        return { rows: [{ id: PROBE_JOB, status: "succeeded" }] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
}

function inspectionOptions(value, database) {
  return {
    database,
    nodeAgentRouter: {
      async inspectAppliance(input) {
        assert.equal(input.nodeId, NODE);
        return {
          nodeId: NODE, nodeGeneration: value.target.nodeGeneration,
          imageDigest: value.target.nodeAgentIdentity.imageId,
          configurationDigest: value.target.nodeAgentIdentity.configDigest,
          healthy: true, runtimeIdentities: [],
        };
      },
    },
    auditService: { async verifyChain() { return { valid: true }; } },
    auditVerifierIdentityId: AUDITOR,
    publicOrigin: "https://10.64.0.20",
    fetcher: async (url) => url.endsWith(`/api/v1/jobs/${PROBE_JOB}`)
      ? jsonResponse({ job_id: PROBE_JOB }) : jsonResponse({ status: "ok" }),
    credentialProvider: async () => `taib_sk_${"A".repeat(43)}`,
    probeJobId: PROBE_JOB,
    requiredCoreServiceKeys: ["platform-api"],
    clock: () => new Date(NOW),
  };
}

function inspectionComponents(value) {
  return {
    setRepository: { async getSetState() { return setRow(value); } },
    nodeAgentRuntime: {
      async inspectProtectedProfile({ profile }) {
        const index = value.set.profiles.findIndex((item) => item.workerId === profile.workerId);
        return {
          workerId: profile.workerId, modelProfileId: profile.modelProfileId,
          imageDigest: profile.imageDigest, configurationDigest: profile.configurationDigest,
          placementClass: "protected-resident", maintenanceGeneration: 7,
          containerId: String(index + 1).repeat(64), startedAt: NOW,
          state: "running", healthy: true, residentBytes: GiB / 2,
        };
      },
    },
  };
}

test("seven independent production readers stay read-only and assemble cross-checked PostgreSQL, mTLS and HTTPS facts", async () => {
  const value = plan();
  const database = readDatabase(value);
  const sourceFactory = createProtectedOfficeSetProductionInspectionSourceFactory(
    inspectionOptions(value, database));
  const sources = sourceFactory(inspectionComponents(value));
  assert.deepEqual(Object.keys(sources), protectedOfficeSetProductionScenarioContract.inspectionSources);
  const observed = {};
  for (const name of protectedOfficeSetProductionScenarioContract.inspectionSources) {
    observed[name] = await sources[name]({ runId: RUN, plan: value, action: "final-inspect" });
    assert.equal(observed[name].readOnly, true);
    assert.equal(observed[name].mutationCount, 0);
  }
  assert.ok(database.statements.length >= 10);
  assert.equal(database.statements.every(({ text }) => /^\s*SELECT\b/i.test(text)), true);
  const result = await createProtectedOfficeSetProductionResultAssembler({ clock: () => new Date(NOW) })({
    runId: RUN, plan: value, sources: observed, action: "final-inspect",
  });
  assert.equal(result.proof.schedulerTransaction.transactionId, TRANSACTION);
  assert.equal(result.profiles.length, 6);
  assert.equal(result.profiles[0].containerId, "1".repeat(64));
  assert.equal(result.profiles[0].startedAt, NOW);
  assert.deepEqual(protectedOfficeSetProductionScenarioContract.residentRuntimeIdentity,
    ["containerId", "startedAt"]);
  assert.equal(result.aggregateMemory.observedModelAccountingBytes, 3 * GiB);
  assert.deepEqual(result.inspectionSources, protectedOfficeSetProductionScenarioContract.inspectionSources);
  assert.deepEqual(result.finalState, {
    healthy: true, activeTransactionCount: 0,
    recoveryRequiredCount: 0, exactDesiredState: true,
  });
  const coreMemoryBudget = { measuredPeakBytes: 19080568832, reserveBytes: 23085449216,
    growthPermille: 1200, evidenceDigest: "1".repeat(64) };
  const calibrated = createProtectedOfficeSetProductionResultAssembler({ clock: () => new Date(NOW), coreMemoryBudget });
  await assert.rejects(calibrated({ runId: RUN, plan: value, sources: observed, action: "final-inspect" }),
    error => error.code === "protected_deployment_admission_budget_drift");
  const exact = structuredClone(observed);
  exact["postgres-protected-set-transaction"].transaction.admission.coreMemoryBudget = coreMemoryBudget;
  const measured = await calibrated({ runId: RUN, plan: value, sources: exact, action: "final-inspect" });
  assert.equal(measured.aggregateMemory.coreServiceReserveBytes, coreMemoryBudget.reserveBytes);
  assert.equal(measured.proof.schedulerTransaction.admissionSnapshot.coreServiceReserveBytes, coreMemoryBudget.reserveBytes);
});

for (const action of ["final-inspect", "bounded-maintenance", "mid-sequence-failure"]) {
test(`${action} keeps historical admission bound while current memory uses fresh telemetry`, async () => {
  const value = plan();
  const database = readDatabase(value);
  const original = database.query.bind(database);
  const currentTime = new Date(Date.parse(NOW) + 120_000);
  const latest = { ...metricRow(value), sequence: 43, snapshot_digest: sha("9"),
    observed_at: new Date(currentTime.getTime() - 2000).toISOString() };
  database.query = async (text, parameters) => /FROM compute\.node_metric_snapshots/.test(text)
    && !/observed_at=\$3/.test(text) ? { rows: [latest] } : original(text, parameters);
  const sources = createProtectedOfficeSetProductionInspectionSourceFactory({
    ...inspectionOptions(value, database), clock: () => currentTime,
  })(inspectionComponents(value));
  const observed = {};
  for (const name of protectedOfficeSetProductionScenarioContract.inspectionSources) {
    observed[name] = await sources[name]({ runId: RUN, plan: value, action });
  }
  const result = await createProtectedOfficeSetProductionResultAssembler({ clock: () => currentTime })({
    runId: RUN, plan: value, sources: observed, action,
  });
  assert.equal(result.proof.metricSnapshot.sequence, 43);
  assert.equal(result.proof.metricSnapshot.freshnessSeconds, 2);
  assert.equal(result.proof.schedulerTransaction.admissionSnapshot.metricSnapshotSequence, 42);
  assert.equal(result.proof.schedulerTransaction.admissionMetricSnapshot.admittedAt, NOW);
  assert.equal(result.proof.schedulerTransaction.admissionMetricSnapshot.freshnessSeconds, 0);
  assert.equal(result.aggregateMemory.metricSnapshot.sequence, 43);
  assert.equal(result.readOnly, action === "final-inspect" ? true : undefined);
  const tampered = structuredClone(observed);
  tampered["postgres-cluster-metric-raw-snapshot"].admissionMetric.admittedAt = currentTime.toISOString();
  await assert.rejects(createProtectedOfficeSetProductionResultAssembler({ clock: () => currentTime })({
    runId: RUN, plan: value, sources: tampered, action,
  }), { code: "protected_deployment_admission_metric_drift" });
});
}

test("final inspection rejects stale current data, stale original admission and sequence regression", async () => {
  const value = plan();
  for (const variant of ["current-stale", "admission-stale", "regressed", "missing-admission"]) {
    const database = readDatabase(value);
    const original = database.query.bind(database);
    database.query = async (text, parameters) => {
      if (!/FROM compute\.node_metric_snapshots/.test(text)) return original(text, parameters);
      const historical = /observed_at=\$3/.test(text);
      if (historical && variant === "missing-admission") return { rows: [] };
      const metric = metricRow(value);
      if (historical && variant === "admission-stale") {
        metric.observed_at = new Date(Date.parse(NOW) - 30_001).toISOString();
      }
      if (!historical && variant === "current-stale") {
        metric.observed_at = new Date(Date.parse(NOW) + 89_999).toISOString();
        metric.sequence += 1;
      }
      if (!historical && variant === "regressed") metric.sequence -= 1;
      return { rows: [metric] };
    };
    const sources = createProtectedOfficeSetProductionInspectionSourceFactory({ ...inspectionOptions(value, database),
      clock: () => new Date(Date.parse(NOW) + (variant === "current-stale" ? 120_000 : 0)) })(
      inspectionComponents(value));
    await assert.rejects(sources["postgres-cluster-metric-raw-snapshot"]({
      runId: RUN, plan: value, action: "final-inspect",
    }), { code: { "current-stale": "protected_deployment_metric_stale",
      "admission-stale": "protected_deployment_admission_metric_stale",
      regressed: "protected_deployment_metric_regressed",
      "missing-admission": "protected_deployment_metric_missing" }[variant] });
  }
});

test("preflight proves bootstrap readiness before the first protected-set transaction without mutating workers", async () => {
  const value = plan();
  const database = readDatabase(value, { bootstrap: true });
  const options = controllerOptions({
    database,
    parentEvidenceVerifier: {
      async verify() {
        return {
          parentsValidated: true,
          adapterDigest: value.controller.adapterDigest,
          driverDigest: value.controller.driverModuleDigest,
        };
      },
    },
  });
  const components = inspectionComponents(value);
  components.coordinator = new Proxy({}, {
    get() { throw new Error("preflight must not access the protected-set mutator"); },
  });
  const result = await createProtectedOfficeSetProductionActionExecutorFactory(options)(components)
    .preflight({ request: actionRequest("preflight") });
  assert.deepEqual(result.proof.bootstrapReadiness, {
    schemaVersion: 1, phase: "pre-cold-boot", state: "uninitialized",
    setId: value.set.setId, transactionAbsent: true, setStateAbsent: true,
    nodeAgentCheckpointAbsent: true, activeTransactionCount: 0,
    recoveryRequiredCount: 0, exactCanonicalProfilesVerified: true,
    latestMetricSnapshot: true, mutationCount: 0,
  });
  assert.equal(result.proof.schedulerTransaction, null);
  assert.equal(result.proof.setState, null);
  assert.equal(result.proof.nodeAgentTransaction, null);
  assert.equal(result.profiles.length, 6);
  assert.equal(result.mutationCount, 0);
  assert.equal(database.statements.every(({ text }) => /^\s*SELECT\b/i.test(text)), true);
});

test("preflight records fractional metric age as conservative canonical integer seconds", async () => {
  const value = plan();
  const database = readDatabase(value, { bootstrap: true });
  const options = controllerOptions({
    database,
    clock: () => new Date("2026-09-05T06:00:01.234Z"),
    parentEvidenceVerifier: {
      async verify() {
        return {
          parentsValidated: true,
          adapterDigest: value.controller.adapterDigest,
          driverDigest: value.controller.driverModuleDigest,
        };
      },
    },
  });
  const components = inspectionComponents(value);
  components.coordinator = new Proxy({}, {
    get() { throw new Error("preflight must not access the protected-set mutator"); },
  });
  const result = await createProtectedOfficeSetProductionActionExecutorFactory(options)(components)
    .preflight({ request: actionRequest("preflight") });
  assert.equal(result.aggregateMemory.metricSnapshot.freshnessSeconds, 2);
  assert.equal(Number.isSafeInteger(result.aggregateMemory.metricSnapshot.freshnessSeconds), true);
});

test("preflight converts structural source and assembly failures into stable non-secret codes", async () => {
  const value = plan();
  const sourceDatabase = readDatabase(value, { bootstrap: true });
  const sourceOptions = controllerOptions({
    database: sourceDatabase,
    fetcher: async (url) => {
      if (url.endsWith(`/api/v1/jobs/${PROBE_JOB}`)) throw new TypeError("fetch implementation detail");
      return jsonResponse({ status: "ok" });
    },
    parentEvidenceVerifier: {
      async verify() {
        return { parentsValidated: true, adapterDigest: value.controller.adapterDigest,
          driverDigest: value.controller.driverModuleDigest };
      },
    },
  });
  await assert.rejects(
    createProtectedOfficeSetProductionActionExecutorFactory(sourceOptions)(inspectionComponents(value))
      .preflight({ request: actionRequest("preflight") }),
    { code: "protected_deployment_authenticated_public_https_contract_failed" },
  );

  const assemblyDatabase = readDatabase(value, { bootstrap: true });
  const assemblyOptions = controllerOptions({
    database: assemblyDatabase,
    resultAssembler: async () => { throw new TypeError("assembly implementation detail"); },
    parentEvidenceVerifier: {
      async verify() {
        return { parentsValidated: true, adapterDigest: value.controller.adapterDigest,
          driverDigest: value.controller.driverModuleDigest };
      },
    },
  });
  await assert.rejects(
    createProtectedOfficeSetProductionActionExecutorFactory(assemblyOptions)(inspectionComponents(value))
      .preflight({ request: actionRequest("preflight") }),
    { code: "protected_deployment_result_assembly_contract_failed" },
  );
});

function controllerOptions(overrides = {}) {
  const value = plan();
  const database = readDatabase(value);
  return {
    ...inspectionOptions(value, database),
    auditRecorder: async () => ({ eventId: uuid(400), eventHash: sha("7") }),
    parentEvidenceVerifier: { async verify() { return {}; } },
    publicHttpsScenarioRunner: { async runConcurrentOffice() { return {}; } },
    maintenanceContextProvider: { async create() { return {}; } },
    maintenanceSigner: { async sign() { return {}; } },
    platformLifecycleController: {
      async inspect() { return { phase: "ready" }; },
      async beginPlatformRestart() {},
      async recoverPlatformRestart() { return { phase: "waiting" }; },
    },
    faultController: { async executeMidSequenceFailure() { return {}; } },
    ...overrides,
  };
}

function actionRequest(action) {
  return { runId: RUN, action, actionId: ACTION_ID, idempotencyKey: IDEMPOTENCY, plan: plan() };
}

test("Agent fact collection uses built-in PostgreSQL SHA-256 and returns no message content", async () => {
  const value = plan();
  const profile = value.set.profiles.find((item) => item.slot === "assistant-qwen38");
  profile.profileKey = "local/qwen3.8-27b-nvfp4";
  const runId = uuid(609);
  const database = { async query(sql, parameters) {
    assert.match(sql, /pg_catalog\.sha256\(convert_to\(message\.content,'UTF8'\)\)/);
    assert.doesNotMatch(sql, /\bdigest\(/);
    assert.deepEqual(parameters, [runId]);
    return { rows: [{ run_id: runId, status: "completed", requested_mode: "agent",
      effective_mode: "agent", message_status: "completed",
      routing: { targetKind: "internal", profileKey: profile.profileKey },
      started_at: NOW, completed_at: NOW, message_completed_at: NOW,
      request_digest: Buffer.alloc(32, 1), result_digest: "2".repeat(64) }] };
  } };
  const fact = await readProtectedOfficeAssistantAgentFact(database, runId, value);
  assert.equal(fact.executionId, runId);
  assert.equal(fact.resultDigest, sha("2"));
  assert.equal(Object.hasOwn(fact, "content"), false);
});

test("bounded maintenance requires a separate exact Ed25519 signer and never reads a private key", async () => {
  const value = plan();
  let signed = null;
  let executed = null;
  const options = controllerOptions({
    maintenanceContextProvider: {
      async create() {
        return {
          transactionId: uuid(410), journalRevision: 44,
          workerIds: value.set.profiles.map((profile) => profile.workerId).sort(),
          allowedOperations: ["protected-set.maintenance"],
          maintenanceGeneration: value.set.maintenanceGeneration,
          issuedAt: NOW, expiresAt: "2026-09-05T06:10:00.000Z",
        };
      },
    },
    maintenanceSigner: {
      async sign(context) {
        signed = context;
        const payload = encodeProtectedMaintenanceSignaturePayload({
          context, operation: "protected-set.maintenance",
        });
        return {
          algorithm: "Ed25519", keyId: "maintenance.prod.v1",
          payloadDigest: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
          value: "A".repeat(86),
        };
      },
    },
  });
  const components = inspectionComponents(value);
  components.nodeAgentRuntime.executeProtectedSetMaintenance = async (input) => {
    executed = input;
    throw new Error("stop after signed production boundary");
  };
  components.setRepository.listIncompleteTransactions = async () => [];
  components.coordinator = { async recover() {}, async boot() {} };
  const executor = createProtectedOfficeSetProductionActionExecutorFactory(options)(components);
  await assert.rejects(executor["bounded-maintenance"]({ request: actionRequest("bounded-maintenance") }),
    /stop after signed production boundary/);
  assert.equal(Object.hasOwn(signed, "signature"), false);
  assert.equal(Object.hasOwn(signed, "privateKey"), false);
  assert.deepEqual(signed.workerIds, [...signed.workerIds].sort());
  assert.equal(executed.maintenanceContext.signature.keyId, "maintenance.prod.v1");
  assert.equal(executed.journalRevision, 44);
  assert.throws(() => createProtectedOfficeSetProductionActionExecutorFactory({
    ...options, maintenanceSigner: null,
  }), /dependencies are incomplete/);
});

test("baseline reconciliation checkpoints the coordinator response without replaying the Agent mutation", async () => {
  const value = plan();
  const nextRevision = value.set.desiredStateRevision + 1;
  const transactionId = uuid(601);
  const database = readDatabase(value);
  const query = database.query.bind(database);
  database.query = async (text, parameters = []) => {
    if (/SELECT \* FROM compute\.protected_office_set_transactions/.test(text)
        && /transaction_state='succeeded'/.test(text)) {
      return { rows: [{
        ...transactionRow(value),
        id: transactionId,
        desired_state_revision: String(nextRevision),
      }] };
    }
    if (/SELECT \* FROM compute\.protected_office_sets WHERE/.test(text)) {
      return { rows: [{
        ...setRow(value),
        desired_state_revision: String(nextRevision),
        observed_state_revision: String(nextRevision),
        last_transaction_id: transactionId,
      }] };
    }
    return query(text, parameters);
  };
  let checkpoint = null;
  let replayCalls = 0;
  const options = controllerOptions({
    database,
    auditRecorder: async (input) => {
      if (input.action === "protected_office_set.node_agent_checkpoint") {
        checkpoint = input;
        const projected = projectAuditMetadata(input);
        assert.equal(projected.agentOperationId, transactionId);
        assert.equal(projected.journalRevision, 51);
        assert.equal(projected.journalState, "complete");
        assert.equal(projected.remainingOperationCount, 0);
        assert.equal(projected.planDigest, sha("4"));
        assert.match(projected.responseDigest, /^sha256:[a-f0-9]{64}$/);
        assert.equal(Object.hasOwn(projected, "commandId"), false);
        assert.equal(Object.hasOwn(projected, "phase"), false);
      }
      return { eventId: uuid(602), eventHash: sha("7") };
    },
    maintenanceContextProvider: {
      async create() {
        return {
          transactionId,
          journalRevision: 51,
          workerIds: value.set.profiles.map((profile) => profile.workerId).sort(),
          allowedOperations: ["protected-set.maintenance"],
          maintenanceGeneration: value.set.maintenanceGeneration,
          issuedAt: NOW,
          expiresAt: "2026-09-05T06:10:00.000Z",
        };
      },
    },
    maintenanceSigner: {
      async sign(context) {
        const payload = encodeProtectedMaintenanceSignaturePayload({
          context, operation: "protected-set.maintenance",
        });
        return {
          algorithm: "Ed25519",
          keyId: "maintenance.prod.v1",
          payloadDigest: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
          value: "A".repeat(86),
        };
      },
    },
    resultAssembler: async ({ extras }) => extras,
  });
  const components = inspectionComponents(value);
  components.coordinator = {
    async boot({ manifest }) {
      assert.equal(manifest.desiredStateRevision, nextRevision);
      return {
        state: "healthy",
        reused: false,
        transition: {
          transactionId,
          setId: value.set.setId,
          desiredStateRevision: nextRevision,
          maintenanceGeneration: value.set.maintenanceGeneration,
          journalRevision: 51,
          phase: "complete",
          nextOperation: 0,
          planDigest: sha("4"),
        },
      };
    },
  };
  components.nodeAgentRuntime.transitionProtectedSet = async () => {
    replayCalls += 1;
    throw new Error("Agent mutation must not be replayed");
  };

  const result = await createProtectedOfficeSetProductionActionExecutorFactory(options)(components)
    ["cold-boot"]({ request: actionRequest("cold-boot") });

  assert.equal(replayCalls, 0);
  assert.equal(checkpoint.transactionId, transactionId);
  assert.equal(checkpoint.journalRevision, 51);
  assert.equal(result.transition.nodeAgentTransactionId, transactionId);
});

test("restart verification cannot return a one-request self-claim and replay reads one durable lifecycle journal", async () => {
  const value = plan();
  let admitted = null;
  let completion = null;
  const options = controllerOptions({
    platformLifecycleController: {
      async inspect() { return { phase: "ready" }; },
      async beginPlatformRestart(input) { admitted = input; },
      async recoverPlatformRestart() { return completion; },
    },
  });
  const components = inspectionComponents(value);
  components.setRepository.listIncompleteTransactions = async () => [];
  components.coordinator = { async recover() {} };
  const executor = createProtectedOfficeSetProductionActionExecutorFactory(options)(components);
  const request = actionRequest("restart-verify");
  await assert.rejects(executor["restart-verify"]({ request }), {
    code: "protected_deployment_restart_did_not_interrupt",
  });
  assert.equal(admitted.command.protocol, "teamaibox.protected-office-set-restart.v1");
  assert.equal(admitted.command.lifecycleCommandType, "appliance.runtime.restart");
  assert.deepEqual(admitted.command.restartTargets, ["platform-api", "node-agent"]);
  const boundary = {
    schemaVersion: 1, protocol: admitted.command.protocol, phase: "restart-requested",
    runId: RUN, action: "restart-verify", actionId: ACTION_ID,
    idempotencyKey: IDEMPOTENCY, requestPersisted: true, replayRequired: true,
    restartTargets: ["platform-api", "node-agent"],
    mutationAuthority: "node-agent-mtls-hmac", dockerMutationAuthority: "node-agent-only",
    lifecycleCommandType: "appliance.runtime.restart",
    lifecycleCommandId: admitted.lifecycleCommandId,
    operationOrder: ["platform.restart", "platform.health", "node-agent.restart", "recovery.verify"],
    lifecycleJournalFsyncedBeforeMutation: true,
    lifecycleJournalRevision: 70, requestDigest: admitted.requestDigest, requestedAt: NOW,
  };
  const observation = (identity, startedAt) => ({
    ...identity, status: "running", health: "healthy", startedAt,
  });
  completion = {
    phase: "complete", restartBoundary: boundary,
    lifecycleCommandId: admitted.lifecycleCommandId,
    platformOperationId: admitted.platformOperationId,
    nodeAgentOperationId: admitted.nodeAgentOperationId,
    platformBefore: observation(value.target.platformIdentity, "2026-09-05T05:59:00.000Z"),
    platformAfter: observation(value.target.platformIdentity, "2026-09-05T06:01:00.000Z"),
    nodeAgentBefore: observation(value.target.nodeAgentIdentity, "2026-09-05T05:59:00.000Z"),
    nodeAgentAfter: observation(value.target.nodeAgentIdentity, "2026-09-05T06:01:01.000Z"),
    journalRevisionBefore: 20, journalRevisionAfter: 21,
    lifecycleJournalRevisionBefore: 70, lifecycleJournalRevisionAfter: 71,
    journalRecovered: true, lifecycleJournalRecovered: true,
    desiredStateRecovered: true, exactIdentityRetained: true,
    activeCastingSessionsBefore: 0, activeCastingSessionsAfter: 0,
    activeMediaReservationsBefore: 0, activeMediaReservationsAfter: 0,
  };
  await executor.recoverInterruptedAction({ request });
  assert.equal(protectedOfficeSetProductionScenarioContract.restart.requiresExternalSameActionRetry, true);
  assert.equal(protectedOfficeSetProductionScenarioContract.restart.beginPlatformRestartMustNotResolve, true);
});

test("environment factory accepts the startPlatformApi service object and fails closed without production controls", async () => {
  const value = plan();
  const database = readDatabase(value);
  const nodeAgentRouter = Object.fromEntries([
    "startWorker", "workerHealth", "executeProtectedMaintenanceTransaction",
    "executeProtectedSetTransition", "inspectAppliance",
  ].map((method) => [method, async () => { throw new Error(`${method} not used during construction`); }]));
  const lifecycle = {
    async inspect() {}, async beginPlatformRestart() {}, async recoverPlatformRestart() {},
  };
  const environment = {
    PLATFORM_APPLIANCE_NODE_ID: NODE,
    PLATFORM_PROTECTED_OFFICE_SET_NODE_ID: NODE,
    PLATFORM_PROTECTED_OFFICE_SET_NODE_GENERATION: "4",
    PLATFORM_PROTECTED_OFFICE_SET_AUDIT_VERIFIER_ID: AUDITOR,
    PLATFORM_PROTECTED_OFFICE_SET_PROBE_JOB_ID: PROBE_JOB,
    PLATFORM_PROTECTED_OFFICE_SET_PROBE_CREDENTIAL_FILE:
      "/run/teamaibox/protected-office-set/probe-api-credential",
    PLATFORM_PROTECTED_OFFICE_SET_MAINTENANCE_KEYRING_FILE:
      "/run/teamaibox/maintenance-keys/protected-office.ed25519.json",
  };
  const services = {
    database, nodeAgentRouter, publicOrigin: "https://10.64.0.20",
    audit: async () => ({ eventId: uuid(500), eventHash: sha("5") }),
    auditService: {
      async record() { return { eventId: uuid(500), eventHash: sha("5") }; },
      async verifyChain() { return { valid: true }; },
    },
    protectedOfficeSetCredentialProvider: async () => `taib_sk_${"B".repeat(43)}`,
    protectedOfficeSetBindings: {
      bindingFactory: async () => ({}), maintenanceTargetFactory: async () => ({}),
      protectedSetProvider: async () => ({ profiles: [], maintenanceGeneration: 7 }),
      realtimePlacementResolver: { async resolve() { return []; } },
      coreServiceProbe: async () => ({ healthy: true }),
    },
    protectedOfficeSetParentEvidenceVerifier: { async verify() { return {}; } },
    protectedOfficeSetPublicHttpsScenarioRunner: { async runConcurrentOffice() { return {}; } },
    protectedOfficeSetMaintenanceContextProvider: { async create() { return {}; } },
    protectedOfficeSetMaintenanceSigner: { async sign() { return {}; } },
    protectedOfficeSetPlatformLifecycleController: lifecycle,
    protectedOfficeSetFaultController: { async executeMidSequenceFailure() { return {}; } },
    requiredCoreServiceKeys: ["platform-api"],
  };
  const runtime = await createProtectedOfficeSetProductionRuntimeFromEnvironment(environment, services);
  assert.equal(runtime.components.setRepository.constructor.name, "PostgresProtectedOfficeSetRepository");
  assert.equal(typeof runtime.driver["concurrent-office"], "function");
  await runtime.close();
  await assert.rejects(createProtectedOfficeSetProductionRuntimeFromEnvironment(environment, {
    ...services, protectedOfficeSetPlatformLifecycleController: null,
  }), /dependencies are incomplete/);
  assert.equal(protectedOfficeSetProductionScenarioContract.maintenanceSigning.privateSigningKeyEnvironment, null);
});
