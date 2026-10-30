import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createProtectedOfficeSetProductionBoundaryFromEnvironment,
  pinnedPublicHttpsFetcher,
  protectedOfficeSetProductionBoundaryContract,
} from "../server/protected-office-set-production-boundary.mjs";

const NODE = uuid(1);
const GROUP = uuid(2);
const ACTION = uuid(3);
const CONFIG = protectedOfficeSetProductionBoundaryContract.configPath;
const CREDENTIAL = protectedOfficeSetProductionBoundaryContract.probeCredentialPath;
const PLAN = "/virtual/protected-office-plan.json";
const CA = "/virtual/public-ca.pem";
const NOW = new Date("2026-09-05T12:00:00.000Z");
const capabilities = [
  "assistant.answer", "assistant.agent", "translation", "drawing.generate", "ocr", "embeddings", "asr.realtime",
];
const slots = [
  "embedding-qwen3", "asr-whisper", "ocr-hunyuan", "translation-lmt4", "assistant-qwen38", "drawing-flux2",
];
const computeRequestSlots = Object.freeze({
  "assistant.answer": "assistant-qwen38",
  translation: "translation-lmt4",
  "drawing.generate": "drawing-flux2",
  ocr: "ocr-hunyuan",
  embeddings: "embedding-qwen3",
  "ordinary-conflict": "assistant-qwen38",
});

function uuid(value) { return `00000000-0000-5000-8000-${String(value).padStart(12, "0")}`; }
function sha(character) { return `sha256:${character.repeat(64)}`; }

function plan() {
  const runtimeIdentity = (name, character) => ({
    containerName: name, containerId: character.repeat(64), imageId: sha(character),
    imageReference: `registry.local/${name}@${sha(character)}`, configDigest: sha(character), state: "running",
  });
  return {
    deploymentId: "teamaibox.protected-office-set-deployment.v5",
    target: {
      nodeId: NODE, nodeGroupId: GROUP, nodeGeneration: 4,
      platformIdentity: runtimeIdentity("teamaibox-platform", "a"),
      nodeAgentIdentity: runtimeIdentity("teamaibox-node-agent", "b"),
    },
    set: {
      setId: "office.baseline", desiredStateRevision: 12, maintenanceGeneration: 7,
      profiles: slots.map((slot, index) => ({
        slot, workerId: uuid(100 + index), modelProfileId: uuid(200 + index),
        targetKey: `office.${slot}`, stageOrder: index + 1,
        dependsOnSlots: index === 5 ? ["embedding-qwen3"] : [], declaredResidentBytes: 1024 + index,
        imageReference: `registry.local/${slot}@${sha(String(index + 1))}`,
        configurationDigest: sha(String.fromCharCode(97 + index)),
      })),
    },
    qualification: { faultInjection: {
      slot: "drawing-flux2", failAfterStageOrder: 5,
      expectedFailureCode: "protected_set_transition_stage_failed",
      requiresNodeAgentJournal: true, requiresAutomaticExactRollback: true, oomAllowed: false,
    } },
  };
}

function config() {
  const requests = Object.fromEntries([...capabilities, "ordinary-conflict"].map((key, index) => [key, {
    method: "POST",
    path: key === "assistant.answer" ? "/v1/chat/completions"
      : key === "assistant.agent" ? `/api/v1/assistant/conversations/${uuid(800)}/messages`
        : key === "translation" ? "/api/v1/ai/translations"
          : key === "drawing.generate" ? "/v1/images/generations"
            : key === "ocr" ? "/api/v1/ai/ocr"
              : key === "embeddings" ? "/v1/embeddings"
                : key === "asr.realtime" ? "/api/v1/realtime/sessions"
                  : "/v1/chat/completions",
    body: { probe: key },
    identityKind: key === "assistant.agent" ? "assistant-run"
      : key === "asr.realtime" ? "realtime-session" : "compute-job",
    identityPointer: key === "assistant.agent" ? "/run/id"
      : key === "asr.realtime" ? "/session_id" : "/job_id",
    index,
  }]));
  for (const value of Object.values(requests)) delete value.index;
  requests.ocr.body = { input: { object_id: uuid(810) } };
  requests["asr.realtime"].body = { probe: "asr.realtime", expires_in_seconds: 30 };
  return {
    schemaVersion: 1,
    coreProbe: { maximumAgeMilliseconds: 15_000, requiredServiceKeys: ["database"] },
    publicHttps: {
      requestTimeoutMilliseconds: 5_000,
      completionTimeoutMilliseconds: 30_000,
      pollIntervalMilliseconds: 100,
      requests,
    },
    realtime: {
      placements: [{
        capability: "asr.realtime", model: null, route: "wss://speech.example.invalid/v1/realtime",
        resources: { unifiedMemoryBytes: 4 * 2 ** 30, codecSessions: 1 }, codecDirections: ["decode"],
        latencyBudgetMilliseconds: 250, observedLatencyMilliseconds: 15, warm: true,
      }],
    },
  };
}

function virtualFileSystem({ credentialMode = 0o100600, configValue = config(), ca = null } = {}) {
  const values = new Map([
    [CONFIG, Buffer.from(JSON.stringify(configValue))],
    [CREDENTIAL, Buffer.from(`taib_sk_${"A".repeat(48)}\n`)],
    [PLAN, Buffer.from(JSON.stringify(plan()))],
  ]);
  if (ca != null) values.set(CA, Buffer.from(ca));
  return {
    async realpath(path) { if (!values.has(path)) throw new Error(`missing ${path}`); return path; },
    async lstat(path) {
      const bytes = values.get(path);
      if (!bytes) throw new Error(`missing ${path}`);
      return {
        size: bytes.byteLength,
        mode: path === CREDENTIAL ? credentialMode : 0o100644,
        isFile: () => true,
        isSymbolicLink: () => false,
      };
    },
    async readFile(path) { return Buffer.from(values.get(path)); },
  };
}

test("pinned public HTTPS forwards the exact CA bytes to the TLS request", async () => {
  const certificate = Buffer.from("-----BEGIN CERTIFICATE-----\n" + "A".repeat(256) + "\n-----END CERTIFICATE-----\n");
  let captured = null;
  const fetcher = await pinnedPublicHttpsFetcher({
    connectOrigin: "https://web:8443",
    publicOrigin: "https://10.64.0.20",
    caFile: CA,
    fileSystem: virtualFileSystem({ ca: certificate }),
    request(options, callback) {
      captured = options;
      const outgoing = new EventEmitter();
      outgoing.setTimeout = () => outgoing;
      outgoing.write = () => true;
      outgoing.destroy = (error) => { if (error) outgoing.emit("error", error); };
      outgoing.end = () => {
        const incoming = new EventEmitter();
        incoming.statusCode = 200;
        incoming.headers = {};
        callback(incoming);
        queueMicrotask(() => {
          incoming.emit("data", Buffer.from("{}"));
          incoming.emit("end");
        });
      };
      return outgoing;
    },
  });
  const response = await fetcher("https://10.64.0.20/health/live", { method: "GET" });
  assert.equal(response.status, 200);
  assert.ok(Buffer.isBuffer(captured.ca));
  assert.deepEqual(captured.ca, certificate);
  assert.equal(captured.hostname, "web");
  assert.equal(captured.port, "8443");
  assert.equal(captured.headers.host, "10.64.0.20");
});

function placementProfileRow(profile) {
  return {
    id: profile.modelProfileId,
    placement_class: "protected-resident",
    placement_node_group_id: GROUP,
    desired_state_revision: 2,
    observed_state_revision: 2,
    maintenance_generation: 7,
    recovery_state: "healthy",
    recovery_reason_code: null,
    current_id: uuid(500),
    current_model_profile_id: profile.modelProfileId,
    current_node_group_id: GROUP,
    current_placement_revision: 2,
    current_placement_class: "protected-resident",
    current_desired_state_revision: 2,
    current_observed_state_revision: 2,
    current_maintenance_generation: 7,
    current_placement_state: "active",
    current_recovery_state: "healthy",
    current_recovery_reason_code: null,
    current_configuration_digest: Buffer.from(profile.configurationDigest.slice(7), "hex"),
    current_resource_envelope: {},
    current_warm_probe: {},
    current_evidence_refs: [],
    current_previous_revision_id: null,
    current_actor_identity_id: uuid(600),
    current_occurred_at: NOW,
  };
}

function nodePlacementRow() {
  return {
    id: NODE,
    appliance_role: "appliance-core",
    node_group_id: GROUP,
    desired_state: {},
    desired_state_revision: 2,
    observed_state_revision: 2,
    maintenance_generation: 7,
    recovery_state: "healthy",
    recovery_reason_code: null,
    membership_node_group_id: GROUP,
    membership_node_id: NODE,
    membership_state: "active",
    membership_desired_state_revision: 2,
    membership_observed_state_revision: 2,
    membership_maintenance_generation: 7,
    membership_recovery_state: "healthy",
    membership_recovery_reason_code: null,
    membership_joined_at: NOW,
    membership_updated_at: NOW,
  };
}

function metricRow() {
  return {
    node_id: NODE,
    node_generation: 4,
    sequence: 10,
    observed_at: NOW,
    received_at: NOW,
    stale_after_milliseconds: 30_000,
    snapshot_digest: Buffer.alloc(32, 1),
    snapshot: {
      domains: { unifiedMemory: {
        totalBytes: { status: "measured", value: 128 * 2 ** 30 },
        availableBytes: { status: "measured", value: 64 * 2 ** 30 },
      } },
      coreServices: [{
        serviceKey: "database",
        state: "healthy",
        availabilityPercent: { status: "measured", value: 100 },
        errorRatePercent: {
          status: "unavailable", value: null,
          reasonCode: "service_error_rate_not_collected_at_node",
        },
      }],
    },
  };
}

function database({ actionState = "recovering", actionRevision = 2, recoveryCount = 1 } = {}) {
  const calls = [];
  const adapter = {
    calls,
    async query(sql, parameters = []) {
      calls.push([sql, parameters]);
      if (sql.includes("SELECT id,generation,lifecycle_state")) {
        return { rows: [{ id: NODE, generation: "4", lifecycle_state: "ready" }] };
      }
      if (sql.includes("INSERT INTO compute.node_lease_fences")) return { rows: [{ fencing_token: "17" }] };
      if (sql.includes("SELECT generation FROM compute.nodes")) return { rows: [{ generation: "4" }] };
      if (sql.includes("compute.node_metric_snapshots")) return { rows: [metricRow()] };
      if (sql.includes("action='bounded-maintenance'")) return { rows: [{
        result: { proof: { setState: { desiredStateRevision: 12, observedStateRevision: 12,
          recoveryState: "healthy", lastTransactionId: uuid(779) } } },
      }] };
      if (sql.includes("compute.protected_office_deployment_actions")) return { rows: [{
        run_id: "protected-office-set-deployment-20260905-a1", action: "restart-verify", action_id: ACTION,
        idempotency_key: Buffer.from("1".repeat(64), "hex"), revision: String(actionRevision),
        action_state: actionState, recovery_count: String(recoveryCount), created_at: NOW, updated_at: NOW,
      }] };
      if (sql.includes("FROM platform.cast_sessions")) return { rows: [{ active_count: 0 }] };
      if (sql.includes("FROM compute.realtime_sessions")) return { rows: [{ media_count: 0 }] };
      if (sql.includes("FROM compute.protected_office_sets")) return { rows: [{
        node_id: NODE, desired_state_revision: "12", observed_state_revision: "12", last_transaction_id: uuid(779),
        maintenance_generation: "7", recovery_state: "healthy",
        healthy_identities: plan().set.profiles.map((profile) => ({
          workerId: profile.workerId, modelProfileId: profile.modelProfileId,
          imageDigest: profile.imageReference.split("@")[1], configurationDigest: profile.configurationDigest,
          maintenanceGeneration: 7, healthy: true,
        })),
      }] };
      if (sql.includes("FROM compute.protected_office_set_transactions WHERE id=$1")) {
        return { rows: adapter.qualificationTransaction == null ? [] : [adapter.qualificationTransaction] };
      }
      if (sql.includes("FROM compute.model_profiles profile")) {
        return { rows: [placementProfileRow(plan().set.profiles.find((item) => item.modelProfileId === parameters[0]))] };
      }
      if (sql.includes("FROM compute.nodes WHERE id=$1 AND appliance_role=")) { assert.deepEqual(parameters, [NODE]); return { rows: [nodePlacementRow()] }; }
      if (sql.includes("FROM objects.object_entries entry")) return { rows: [{
        namespace_key: `user:${uuid(812)}`,
        current_version: "1",
        owner_identity_id: uuid(812),
        identity_kind: "local_user",
        status: "active",
      }] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async transaction(callback) { return callback(adapter); },
  };
  return adapter;
}

function response(body, ok = true) {
  return { ok, async arrayBuffer() { return Buffer.from(JSON.stringify(body)); } };
}

function services(overrides = {}) {
  const { restartPhase = "complete", actionState = "recovering", actionRevision = 2,
    recoveryCount = 1, answerOverlapStatus = "running", ...serviceOverrides } = overrides;
  const calls = [];
  const jobIds = new Map();
  let nextJob = 700;
  let assistantRunId = null;
  let overlapObserved = false;
  const nodeAgentRouter = {
    async inspectAppliance() { return { nodeGeneration: 4 }; },
    async executeProtectedSetTransition(request) { calls.push(["transition", request]); return { phase: "complete" }; },
    async inspectProtectedSetTransition(request) { calls.push(["transition.inspect", request]); return { phase: "recovered" }; },
    async executeApplianceRuntimeRestart(request) {
      calls.push(["restart", request]);
      const identity = (expected, startedAt) => ({
        containerId: expected.containerId, imageId: expected.imageId, imageReference: expected.imageReference,
        configurationDigest: expected.configDigest, startedAt, status: "running", health: "healthy",
      });
      return {
        restartId: request.restartId, policyDigest: request.policyDigest, idempotencyKey: request.idempotencyKey,
        phase: restartPhase,
        pre: {
          platform: identity(plan().target.platformIdentity, "2026-09-05T10:00:00.000Z"),
          nodeAgent: identity(plan().target.nodeAgentIdentity, "2026-09-05T10:00:00.000Z"),
        },
        post: {
          platform: identity(plan().target.platformIdentity, "2026-09-05T11:00:00.000Z"),
          ...(restartPhase === "complete"
            ? { nodeAgent: identity(plan().target.nodeAgentIdentity, "2026-09-05T11:01:00.000Z") } : {}),
        },
        journalRevisions: {
          prepared: 1, platformRestarting: 2, platformVerified: 3, agentRestartArmed: 4,
          ...(restartPhase === "complete" ? { complete: 5 } : {}),
        }, updatedAt: NOW.toISOString(),
      };
    },
  };
  const fetcher = async (url, options) => {
    const pathname = new URL(url).pathname;
    if (options.method === "POST" && pathname === "/api/v1/assistant/conversations") {
      assert.deepEqual(JSON.parse(options.body), { title: "Protected office qualification" });
      calls.push(["fresh-conversation"]);
      return response({ id: uuid(801) });
    }
    if (options.method === "POST" && pathname.endsWith("/cancel")) {
      assert.equal(options.headers.origin, "https://appliance.example");
      assert.equal(options.headers["content-type"], "application/json");
      assert.equal(options.headers["content-length"], "2");
      assert.deepEqual(JSON.parse(options.body), {});
      const jobId = pathname.split("/").at(-2);
      assert.equal(jobId, jobIds.get("ordinary-conflict"));
      return response({ job_id: jobId, status: "cancelled", x_teamaibox: { attempt_id: null } });
    }
    if (options.method === "POST") {
      assert.equal(options.headers.origin, "https://appliance.example");
      const requestBody = JSON.parse(options.body);
      const key = pathname === "/api/v1/ai/ocr" ? "ocr" : requestBody.probe;
      if (key !== "assistant.answer") assert.equal(overlapObserved, true);
      if (key === "assistant.agent") assert.equal(pathname, `/api/v1/assistant/conversations/${uuid(801)}/messages`);
      if (key === "ocr") assert.deepEqual(requestBody.input, { reference_id: uuid(811) });
      const slot = computeRequestSlots[key];
      if (slot) {
        const expected = plan().set.profiles.find((profile) => profile.slot === slot);
        assert.equal(requestBody.x_teamaibox.model_profile_id, expected.modelProfileId);
      } else {
        assert.equal(requestBody.x_teamaibox?.model_profile_id, undefined);
      }
      if (key === "drawing.generate") assert.equal(requestBody.model, "drawing.automatic");
      const jobId = uuid(nextJob++);
      jobIds.set(key, jobId);
      if (key === "assistant.agent") {
        assistantRunId = jobId;
        return response({ run: { id: jobId } });
      }
      if (key === "asr.realtime") {
        return response({ session_id: jobId, expires_at: new Date(Date.now() + 10).toISOString() });
      }
      return response({ job_id: jobId });
    }
    if (pathname.endsWith(`/conversations/${uuid(801)}`)) {
      return response({ messages: [{ runId: assistantRunId, role: "assistant", status: "completed" }] });
    }
    const jobId = pathname.split("/").at(-1);
    if (jobId === jobIds.get("assistant.answer") && !overlapObserved) {
      overlapObserved = answerOverlapStatus === "running";
      return response({ job_id: jobId, status: answerOverlapStatus,
        x_teamaibox: { attempt_id: uuid(802) } });
    }
    if (jobId === jobIds.get("ordinary-conflict")) {
      return response({ job_id: jobId, status: "queued", waiting_reason: "protected_worker_busy",
        x_teamaibox: { attempt_id: null } });
    }
    return response({ job_id: jobId, status: "succeeded" });
  };
  return {
    calls,
    database: database({ actionState, actionRevision, recoveryCount }),
    nodeAgentRouter,
    managedNodeService: { async get() {} },
    jobService: { async submit() {}, async get() {} },
    objectService: {
      createObjectHandoffGateway() {
        return Object.freeze({
          async issue(input) {
            assert.deepEqual(input, {
              actorIdentityId: uuid(812),
              objectId: uuid(810),
              objectVersion: 1,
              audience: "compute:ocr",
              operations: ["head", "read", "range"],
              expiresInSeconds: 600,
            });
            return { referenceId: uuid(811), expiresAt: new Date(NOW.getTime() + 600_000).toISOString() };
          },
        });
      },
    },
    audit: async () => {},
    fetcher,
    fileSystem: virtualFileSystem(),
    bundle: { planFile: PLAN },
    clock: () => new Date(NOW),
    idFactory: () => uuid(999),
    execFile(_command, _arguments, options, callback) {
      calls.push(["validator", options]);
      callback(null, "", "");
    },
    ...serviceOverrides,
  };
}

const environment = Object.freeze({
  PLATFORM_PROTECTED_OFFICE_SET_NODE_ID: NODE,
  PLATFORM_PROTECTED_OFFICE_SET_NODE_GENERATION: "4",
  PLATFORM_PROTECTED_OFFICE_SET_PROBE_CREDENTIAL_FILE: CREDENTIAL,
  PLATFORM_PROTECTED_OFFICE_SET_PRODUCTION_BOUNDARY_CONFIG_FILE: CONFIG,
  PLATFORM_PROTECTED_OFFICE_SET_RESTART_POLICY_DIGEST: sha("f"),
  PLATFORM_PROTECTED_OFFICE_SET_QUALIFICATION_ID: "protected-office-set-v5",
  PLATFORM_PROTECTED_OFFICE_SET_QUALIFICATION_POLICY_DIGEST: sha("e"),
  PLATFORM_PROTECTED_OFFICE_SET_TARGET_POLICY_DIGEST: sha("d"),
});

function qualificationRequest(dependencies) {
  const value = plan();
  const profiles = value.set.profiles.map((profile) => ({
    workerId: profile.workerId, modelProfileId: profile.modelProfileId,
    imageDigest: profile.imageReference.split("@")[1], configurationDigest: profile.configurationDigest,
    placementClass: "protected-resident", maintenanceGeneration: value.set.maintenanceGeneration,
    declaredResidentBytes: profile.declaredResidentBytes,
    dependsOnWorkerIds: profile.dependsOnSlots.map((slot) => value.set.profiles.find((item) => item.slot === slot).workerId),
    stageOrder: profile.stageOrder,
  }));
  const maintenanceContext = {
    transactionId: uuid(777), journalRevision: 17,
    workerIds: value.set.profiles.map((item) => item.workerId).sort(),
    allowedOperations: ["protected-set.maintenance"], maintenanceGeneration: 7,
    issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    signature: { algorithm: "Ed25519", keyId: "test", payloadDigest: sha("9"), value: "test" },
  };
  return {
    runId: "protected-office-set-deployment-20260905-a1", actionId: ACTION, idempotencyKey: sha("1"),
    plan: value, manifest: { setId: value.set.setId, nodeId: NODE, desiredStateRevision: 16,
      maintenanceGeneration: 7, profiles, requiredModelProfileIds: profiles.map((item) => item.modelProfileId) },
    maintenanceContext,
    coordinator: { async boot(input) {
      dependencies.database.qualificationTransaction = {
        id: maintenanceContext.transactionId, set_id: value.set.setId, node_id: NODE,
        desired_state_revision: "16", maintenance_generation: "7", transaction_state: "rolled-back",
        failure_code: "protected_set_transition_stage_failed",
      };
      assert.equal(input.qualificationFault.faultInjection.stageOrder, 6);
      const error = new Error("expected qualification fault");
      error.code = "protected_set_transition_stage_failed";
      throw error;
    } },
    nodeAgentRuntime: { async inspectProtectedSetQualificationFault(input) {
      assert.equal(input.qualificationId, "protected-office-set-v5");
      return { runtimeState: "canonical-exact", oomKilled: false, journal: {
        phase: "recovered", journalRevision: 23, failureCode: "protected_set_transition_stage_failed",
        faultInjectionConsumed: true,
      } };
    } },
  };
}

function restartRequest({ identities = false } = {}) {
  const runId = "protected-office-set-deployment-20260905-a1";
  const lifecycleCommandId = uuid(30);
  const platformOperationId = uuid(31);
  const nodeAgentOperationId = uuid(32);
  const idempotencyKey = sha("1");
  return {
    runId, actionId: ACTION, idempotencyKey, lifecycleCommandId, platformOperationId, nodeAgentOperationId,
    requestDigest: sha("2"),
    command: {
      schemaVersion: 1, protocol: "teamaibox.protected-office-set-restart.v1", runId,
      action: "restart-verify", actionId: ACTION, idempotencyKey,
      restartTargets: ["platform-api", "node-agent"], mutationAuthority: "node-agent-mtls-hmac",
      dockerMutationAuthority: "node-agent-only", lifecycleCommandType: "appliance.runtime.restart",
      lifecycleCommandId,
      operationOrder: ["platform.restart", "platform.health", "node-agent.restart", "recovery.verify"],
    },
    ...(identities ? {
      expectedPlatformIdentity: plan().target.platformIdentity,
      expectedNodeAgentIdentity: plan().target.nodeAgentIdentity,
    } : {}),
  };
}

test("constructs the strict production adapters and exercises every currently expressible real boundary", async () => {
  const dependencies = services();
  const boundary = await createProtectedOfficeSetProductionBoundaryFromEnvironment(environment, dependencies);
  assert.deepEqual(Object.keys(boundary).sort(), [...protectedOfficeSetProductionBoundaryContract.adapters].sort());

  const authority = await boundary.leaseAuthorityProvider.getAuthority({
    nodeId: NODE, nodeGeneration: 4, attemptId: uuid(300),
  });
  assert.deepEqual(authority, { leaseId: uuid(300), fencingToken: 17, nodeGeneration: 4 });

  const placement = await boundary.realtimePlacementResolver.resolve({ capability: "asr.realtime", model: null });
  assert.equal(placement.length, 1);
  assert.equal(placement[0].modelProfileId, uuid(201));
  assert.equal(placement[0].nodeId, NODE);

  const core = await boundary.coreServiceProbe.probe({
    nodeId: NODE, setId: "office.baseline", phase: "pre-admission",
    requiredCoreServiceReserveBytes: 32 * 2 ** 30,
    requiredTransientMarginBytes: 16 * 2 ** 30,
  });
  assert.equal(core.healthy, true);
  assert.equal(core.source, "authenticated-core-service-probe");
  assert.deepEqual(core.requiredServiceKeys, ["database"]);

  const validator = await boundary.validatorRunner.runStrictValidator({
    validatorPath: "/virtual/validator.py", evidencePath: "/virtual/evidence.json",
    repositoryRoot: "/virtual", timeoutMilliseconds: 1_000,
  });
  assert.equal(validator.status, "passed");
  assert.equal(dependencies.calls.find(([name]) => name === "validator")[1].shell, false);

  const protocol = await boundary.publicHttpsScenarioClient.runConcurrentOffice({
    publicOrigin: "https://appliance.example/", idempotencyKey: sha("1"),
  });
  assert.equal(protocol.transport, "authenticated-public-https");
  assert.deepEqual(Object.keys(protocol.jobIds).sort(), capabilities
    .filter((key) => !new Set(["assistant.agent", "asr.realtime"]).has(key)).sort());
  assert.match(protocol.assistantRunId, /^[0-9a-f-]{36}$/);
  assert.match(protocol.realtimeSessionId, /^[0-9a-f-]{36}$/);
  assert.match(protocol.ordinaryConflictingJobId, /^[0-9a-f-]{36}$/);
  assert.equal(protocol.ordinaryConflictObservedQueued, true);
  assert.equal(protocol.ordinaryConflictCleanupStatus, "cancelled");
  assert.equal(dependencies.calls.filter(([name]) => name === "fresh-conversation").length, 1);

  const context = await boundary.maintenanceContextAllocator.create({
    operation: "protected-set.maintenance", workerIds: plan().set.profiles.map((item) => item.workerId),
    maintenanceGeneration: 7,
  });
  assert.equal(context.transactionId, uuid(999));
  assert.equal(context.journalRevision, 17);
  assert.equal("signature" in context, false);

  const recovered = await boundary.platformLifecycleClient.recoverPlatformRestart(restartRequest({ identities: true }));
  assert.equal(recovered.phase, "complete");
  assert.equal(recovered.restartBoundary.lifecycleJournalFsyncedBeforeMutation, true);
  assert.equal(recovered.lifecycleJournalRevisionAfter, 5);
  assert.equal(recovered.journalRevisionAfter, 2);
  assert.equal(recovered.activeCastingSessionsBefore, 0);
  assert.equal(recovered.activeMediaReservationsAfter, 0);
  assert.deepEqual(dependencies.calls.filter(([name]) => name === "restart").map(([name]) => name), ["restart"]);
  const fault = await boundary.faultController.executeMidSequenceFailure(qualificationRequest(dependencies));
  assert.deepEqual(fault, { observedFailureCode: "protected_set_transition_stage_failed",
    failedTransactionId: uuid(777), failedJournalRevision: 23, oomKilled: false });
});

test("a completed answer is not misrepresented as concurrent contention", async () => {
  const boundary = await createProtectedOfficeSetProductionBoundaryFromEnvironment(environment,
    services({ answerOverlapStatus: "succeeded" }));
  await assert.rejects(boundary.publicHttpsScenarioClient.runConcurrentOffice({
    publicOrigin: "https://appliance.example/", idempotencyKey: sha("1"),
  }), (error) => error.code === "protected_office_overlap_fixture_too_short");
});

test("fails before reading configuration when the real router lacks restart or transition methods", async () => {
  const currentRouterSurface = { async inspectAppliance() {} };
  await assert.rejects(createProtectedOfficeSetProductionBoundaryFromEnvironment(environment, services({
    nodeAgentRouter: currentRouterSurface,
  })), /lacks protected office lifecycle\/fault production methods/);
});

test("core probe ignores unrelated history but fails closed when a declared service is absent", async () => {
  const declared = config();
  declared.coreProbe.requiredServiceKeys = ["database", "web"];
  const boundary = await createProtectedOfficeSetProductionBoundaryFromEnvironment(environment, services({
    fileSystem: virtualFileSystem({ configValue: declared }),
  }));
  await assert.rejects(boundary.coreServiceProbe.probe({
    nodeId: NODE, setId: "office.baseline", phase: "pre-admission",
    requiredCoreServiceReserveBytes: 32 * 2 ** 30,
    requiredTransientMarginBytes: 16 * 2 ** 30,
  }), /core-service probe failed closed/);
});

test("warm-set core probe does not double-count core memory already consumed, but retains the exact envelope", async () => {
  for (const [totalGiB, availableGiB, accepted] of [
    [128, 45, true], [112, 16, true], [128, 15, false], [111, 64, false],
    [128, 129, false],
  ]) {
    const storage = database();
    const query = storage.query.bind(storage);
    storage.query = async (sql, parameters) => {
      if (sql.includes("compute.node_metric_snapshots")) {
        const row = metricRow();
        row.snapshot.domains.unifiedMemory.totalBytes.value = totalGiB * 2 ** 30;
        row.snapshot.domains.unifiedMemory.availableBytes.value = availableGiB * 2 ** 30;
        return { rows: [row] };
      }
      return query(sql, parameters);
    };
    const boundary = await createProtectedOfficeSetProductionBoundaryFromEnvironment(environment, services({ database: storage }));
    const request = { nodeId: NODE, setId: "office.baseline", phase: "pre-admission",
      requiredCoreServiceReserveBytes: 32 * 2 ** 30, requiredTransientMarginBytes: 16 * 2 ** 30 };
    if (accepted) assert.equal((await boundary.coreServiceProbe.probe(request)).healthy, true);
    else await assert.rejects(boundary.coreServiceProbe.probe(request), /core-service probe failed closed/);
    await assert.rejects(boundary.coreServiceProbe.probe({ ...request,
      requiredCoreServiceReserveBytes: 31 * 2 ** 30 }), /core-service probe failed closed/);
  }
});

test("authenticated core probe uses the measured reserve, not a guessed or legacy floor", async () => {
  const coreMemoryBudget = { measuredPeakBytes: 19080568832, reserveBytes: 23085449216,
    growthPermille: 1200, evidenceDigest: "1".repeat(64) };
  const storage = database(), query = storage.query.bind(storage);
  storage.query = async (sql, parameters) => {
    if (sql.includes("compute.node_metric_snapshots")) {
      const row = metricRow(); row.snapshot.domains.unifiedMemory.totalBytes.value = 102 * 2 ** 30;
      row.snapshot.domains.unifiedMemory.availableBytes.value = 16 * 2 ** 30;
      return { rows: [row] };
    }
    return query(sql, parameters);
  };
  const boundary = await createProtectedOfficeSetProductionBoundaryFromEnvironment(environment,
    services({ database: storage, coreMemoryBudget }));
  const request = { nodeId: NODE, setId: "office.baseline", phase: "pre-admission",
    requiredCoreServiceReserveBytes: coreMemoryBudget.reserveBytes, requiredTransientMarginBytes: 16 * 2 ** 30 };
  assert.equal((await boundary.coreServiceProbe.probe(request)).healthy, true);
  for (const bytes of [32 * 2 ** 30, coreMemoryBudget.reserveBytes - 1]) {
    await assert.rejects(boundary.coreServiceProbe.probe({ ...request, requiredCoreServiceReserveBytes: bytes }), /failed closed/);
  }
});

test("lifecycle inspection is read-only before admission and begin stays pending after the fsynced restart-required response", async () => {
  const dependencies = services({ actionState: "running", actionRevision: 1, recoveryCount: 0,
    restartPhase: "agent_restart_armed" });
  const boundary = await createProtectedOfficeSetProductionBoundaryFromEnvironment(environment, dependencies);
  assert.deepEqual(await boundary.platformLifecycleClient.inspect(restartRequest()), { phase: "ready" });
  assert.equal(dependencies.calls.some(([name]) => name === "restart"), false);
  const pending = boundary.platformLifecycleClient.beginPlatformRestart(restartRequest({ identities: true }));
  const outcome = await Promise.race([
    pending.then(() => "resolved", () => "rejected"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 10)),
  ]);
  assert.equal(outcome, "pending");
  assert.equal(dependencies.calls.filter(([name]) => name === "restart").length, 1);
});

test("qualification baseline rejection preserves the cause without inspecting a nonexistent journal", async () => {
  const dependencies = services();
  const boundary = await createProtectedOfficeSetProductionBoundaryFromEnvironment(environment, dependencies);
  const request = qualificationRequest(dependencies);
  const failure = Object.assign(new Error("baseline differs"), { code: "protected_set_qualification_baseline_drift" });
  request.coordinator.boot = async () => { throw failure; };
  request.nodeAgentRuntime.inspectProtectedSetQualificationFault = async () => { assert.fail("must not inspect before dispatch"); };
  await assert.rejects(boundary.faultController.executeMidSequenceFailure(request), (error) => error === failure);
});

test("qualification replay reads the durable Agent journal and rejects any fault declaration drift", async () => {
  const dependencies = services();
  dependencies.database.qualificationTransaction = {
    id: uuid(777), set_id: "office.baseline", node_id: NODE,
    desired_state_revision: "16", maintenance_generation: "7", transaction_state: "rolled-back",
    failure_code: "protected_set_transition_stage_failed",
  };
  const boundary = await createProtectedOfficeSetProductionBoundaryFromEnvironment(environment, dependencies);
  const request = qualificationRequest(dependencies);
  let booted = false;
  request.coordinator = { async boot() { booted = true; throw new Error("must not replay mutation"); } };
  const result = await boundary.faultController.executeMidSequenceFailure(request);
  assert.equal(result.failedTransactionId, uuid(777));
  assert.equal(booted, false);

  const drifted = qualificationRequest(dependencies);
  drifted.plan.qualification.faultInjection.failAfterStageOrder = 4;
  await assert.rejects(boundary.faultController.executeMidSequenceFailure(drifted), /binding is invalid/);
});

test("rejects non-exact paths, non-private credentials, and unknown configuration fields", async () => {
  await assert.rejects(createProtectedOfficeSetProductionBoundaryFromEnvironment({
    ...environment, PLATFORM_PROTECTED_OFFICE_SET_PROBE_CREDENTIAL_FILE: "/run/secrets/other",
  }, services()), /file environment is not exact/);
  await assert.rejects(createProtectedOfficeSetProductionBoundaryFromEnvironment(environment, services({
    fileSystem: virtualFileSystem({ credentialMode: 0o100640 }),
  })), /private regular file/);
  await assert.rejects(createProtectedOfficeSetProductionBoundaryFromEnvironment(environment, services({
    fileSystem: virtualFileSystem({ configValue: { ...config(), unexpected: true } }),
  })), /invalid shape/);
  const invalidPointer = config();
  invalidPointer.publicHttps.requests["assistant.answer"].identityPointer = "/job~2id";
  await assert.rejects(createProtectedOfficeSetProductionBoundaryFromEnvironment(environment, services({
    fileSystem: virtualFileSystem({ configValue: invalidPointer }),
  })), /execution identity is invalid/);
  const unsortedServices = config();
  unsortedServices.coreProbe.requiredServiceKeys = ["web", "database"];
  await assert.rejects(createProtectedOfficeSetProductionBoundaryFromEnvironment(environment, services({
    fileSystem: virtualFileSystem({ configValue: unsortedServices }),
  })), /sorted unique service-key list/);
});

test("restart binds same-run pre-restart revision rather than the original plan revision", async () => {
  for (const [prior, live, accepted] of [[19, 19, true], [19, 20, false], [11, 11, false], [null, 19, false]]) {
    const storage = database();
    const query = storage.query.bind(storage);
    storage.query = async (sql, params) => {
      if (sql.includes("action='bounded-maintenance'")) {
        assert.equal(params[0], restartRequest().runId);
        return { rows: prior === null ? [] : [{ result: { proof: { setState: {
          desiredStateRevision: prior, observedStateRevision: prior,
          recoveryState: "healthy", lastTransactionId: uuid(779),
        } } } }] };
      }
      const result = await query(sql, params);
      if (sql.includes("FROM compute.protected_office_sets")) {
        result.rows[0].desired_state_revision = String(live);
        result.rows[0].observed_state_revision = String(live);
      }
      return result;
    };
    const boundary = await createProtectedOfficeSetProductionBoundaryFromEnvironment(environment,
      services({ database: storage }));
    if (accepted) assert.equal((await boundary.platformLifecycleClient.inspect(restartRequest())).phase, "complete");
    else await assert.rejects(boundary.platformLifecycleClient.inspect(restartRequest()), /recovery facts are incomplete/);
  }
});

test("fault authorization uses canonical worker membership, independent of stage order", async () => {
  const dependencies = services();
  const boundary = await createProtectedOfficeSetProductionBoundaryFromEnvironment(environment, dependencies);
  const request = qualificationRequest(dependencies);
  request.plan.set.profiles.forEach((profile, index) => { profile.workerId = uuid(105 - index); });
  request.manifest.profiles.forEach((profile, index) => { profile.workerId = uuid(105 - index); });
  request.maintenanceContext.workerIds = request.plan.set.profiles.map((profile) => profile.workerId).sort();
  assert.equal((await boundary.faultController.executeMidSequenceFailure(request)).observedFailureCode,
    "protected_set_transition_stage_failed");
  const invalid = structuredClone(request.maintenanceContext);
  invalid.workerIds[1] = invalid.workerIds[0];
  await assert.rejects(boundary.faultController.executeMidSequenceFailure({
    ...request, maintenanceContext: invalid,
  }), /binding is invalid/);
});
