import { createHash, randomUUID } from "node:crypto";
import https from "node:https";
import { readFile } from "node:fs/promises";

import { createPostgresDatabaseFromEnvironment } from "/opt/teamaibox/packages/persistence/src/postgres-database.mjs";
import { EncryptedSecretStore, FileCiphertextBackend } from "/opt/teamaibox/packages/secrets/src/index.mjs";
import { PostgresExternalProviderRepository } from "/opt/teamaibox/apps/platform-api/src/providers/postgres-provider-repository.mjs";
import { ExternalAttemptCoordinator } from "/opt/teamaibox/services/scheduler/src/external-attempt-coordinator.mjs";
import { ExternalUsageAccountant } from "/opt/teamaibox/services/scheduler/src/external-usage-accountant.mjs";
import { PostgresExternalAttemptRepository } from "/opt/teamaibox/services/scheduler/src/postgres-external-attempt-repository.mjs";
import { PostgresExternalUsageRepository } from "/opt/teamaibox/services/scheduler/src/postgres-external-usage-repository.mjs";
import { PostgresRoutingPolicyRepository } from "/opt/teamaibox/services/scheduler/src/postgres-routing-policy-repository.mjs";
import { rankSchedulingCandidates } from "/opt/teamaibox/services/scheduler/src/routing-engine.mjs";

const PROFILE_ID = process.env.TEAMAIBOX_EXTERNAL_PROBE_PROFILE_ID;
const MODEL = "gemma4-31b-redhat-nvfp4-mtp4-64k-cohost-c2";
need(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(PROFILE_ID ?? ""), "explicit_TEAMAIBOX_EXTERNAL_PROBE_PROFILE_ID_required");
const GIB = 1024 ** 3;

function need(condition, message) { if (!condition) throw new Error(message); }
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function secretStore() {
  const raw = await readFile(process.env.PLATFORM_PROVIDER_SECRET_MASTER_KEY_FILE);
  let key;
  try {
    const encoded = raw.toString("utf8").trim(); key = Buffer.from(encoded, "base64url");
    need(key.byteLength === 32 && key.toString("base64url") === encoded, "provider secret master key is invalid");
    return new EncryptedSecretStore({ masterKey: key, backend: new FileCiphertextBackend(process.env.PLATFORM_PROVIDER_SECRET_CIPHERTEXT_DIR) });
  } finally { key?.fill(0); raw.fill(0); }
}

function httpsRequest({ provider, credential, customCa, method, path, body = null }) {
  return new Promise((done, reject) => {
    const target = new URL(path, provider.endpoint);
    const encoded = body === null ? null : Buffer.from(JSON.stringify(body));
    const request = https.request(target, {
      method, ca: customCa, rejectUnauthorized: true,
      headers: {
        accept: "application/json, text/event-stream", authorization: `Bearer ${credential.toString("utf8")}`,
        ...(encoded ? { "content-type": "application/json", "content-length": String(encoded.byteLength) } : {}),
      },
    }, (response) => {
      const chunks = []; let size = 0;
      response.on("data", (chunk) => {
        size += chunk.byteLength;
        if (size > 4 * 1024 * 1024) request.destroy(new Error("provider response exceeded bound"));
        else chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => done({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.setTimeout(180_000, () => request.destroy(new Error("provider request timed out")));
    request.once("error", reject);
    request.once("finish", () => encoded?.fill(0));
    request.end(encoded ?? undefined);
  });
}

function withProviderSecrets(provider, store, callback) {
  const reader = Object.freeze({ service: "provider-adapter", permissions: Object.freeze(["secrets:read"]) });
  return store.withSecret(provider.credentialSecretKey, reader, (credential) =>
    store.withSecret(provider.caSecretKey, reader, (customCa) => callback(credential, customCa)));
}

async function gatewayState(provider, store, state) {
  const response = await withProviderSecrets(provider, store, (credential, customCa) =>
    httpsRequest({ provider, credential, customCa, method: "POST", path: "/gateway/v1/state", body: state }));
  need(response.status === 200, `gateway state returned HTTP ${response.status}`);
  response.body.fill(0);
}

function streamFacts(body) {
  let providerRequestId = null, delta = null, event = null;
  for (const line of body.toString("utf8").split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    if (!line.startsWith("data:")) continue;
    let value;
    try { value = JSON.parse(line.slice("data:".length)); } catch { continue; }
    providerRequestId ??= value.response?.id ?? value.item?.id ?? null;
    if (event === "response.output_text.delta" && typeof value.delta === "string" && value.delta) delta = value.delta;
  }
  need(providerRequestId && delta && !body.includes(Buffer.from("response.completed")),
    "real provider partial stream did not contain a bounded output delta");
  const bytes = Buffer.from(delta);
  try { return { providerRequestId, output: { sequence: 1, sizeBytes: bytes.byteLength, sha256: sha256(bytes) } }; }
  finally { bytes.fill(0); }
}

function providerTransport(provider, store) {
  return Object.freeze({
    async execute({ request, onAccepted, onOutput }) {
      await gatewayState(provider, store, { healthy: true, next_scenario: request.scenario });
      const response = await withProviderSecrets(provider, store, (credential, customCa) => httpsRequest({
        provider, credential, customCa, method: "POST", path: "/v1/responses",
        body: { model: MODEL, input: "Reply with exactly: scheduler-partial", max_output_tokens: 64, stream: request.scenario === "partial-output" },
      }));
      if (response.status === 429) {
        response.body.fill(0);
        throw Object.assign(new Error("provider overloaded before acceptance"), { code: "provider_overloaded", retryable: true });
      }
      need(response.status === 200, `real provider returned HTTP ${response.status}`);
      try {
        const facts = streamFacts(response.body);
        await onAccepted({ providerRequestId: facts.providerRequestId });
        await onOutput(facts.output);
        throw Object.assign(new Error("real provider stream ended after a verified partial output"), {
          code: "provider_stream_incomplete", retryable: true, accepted: true,
          providerRequestId: facts.providerRequestId, outputObserved: facts.output,
        });
      } finally { response.body.fill(0); }
    },
  });
}

async function acceptedProviderRequest(provider, store) {
  await gatewayState(provider, store, { healthy: true, next_scenario: "normal" });
  const response = await withProviderSecrets(provider, store, (credential, customCa) => httpsRequest({
    provider, credential, customCa, method: "POST", path: "/v1/responses",
    body: { model: MODEL, input: "Reply with exactly: cancellation-accepted", max_output_tokens: 24 },
  }));
  need(response.status === 200, "real provider acceptance request failed");
  try {
    const value = JSON.parse(response.body.toString("utf8"));
    need(typeof value.id === "string" && value.id.length > 3, "real provider acceptance identifier is unavailable");
    return value.id;
  } finally { response.body.fill(0); }
}

function profile(capabilityId) {
  return {
    profileId: PROFILE_ID, profileKey: "llm.qwen36-35b-a3b.nvfp4.spark-32k.v1", capabilityId,
    precision: "nvfp4", compatibility: { architectures: ["linux/arm64/v8"] },
    resourceEnvelope: { cpuMillis: 18_000, unifiedMemoryBytes: 64 * GIB, acceleratorUnits: 1, codecSessions: 0, storageBytes: 50 * GIB, networkBitsPerSecond: 100_000_000 },
    dataPolicy: { allowedDataClasses: ["public", "internal", "confidential"], externalProcessing: "approved_only" },
    certification: { state: "certified", evidenceRefs: ["evidence://validation/models/post-soak-spark-qualification"] },
    extensions: { schedulerRequirements: { acceleratorKinds: ["nvidia-blackwell"], storageClass: "encrypted_nvme", network: { class: "management" } } },
  };
}

function candidates(provider, capabilityId, { localState = "ready", providerFresh = true } = {}) {
  const selected = profile(capabilityId);
  return [{
    targetId: "spark-local", targetKind: "local", lifecycleState: localState, architecture: "arm64",
    operations: ["responses"], profile: selected,
    availableResources: { cpuMillis: 32_000, unifiedMemoryBytes: 96 * GIB, acceleratorUnits: 1, codecSessions: 2, storageBytes: 100 * GIB, networkBitsPerSecond: 1_000_000_000 },
    accelerator: { kind: "nvidia-blackwell", computeCapability: "12.1", supportedPrecisions: ["bf16", "fp8", "nvfp4"] },
    storage: { classes: ["encrypted_nvme"] }, network: { classes: ["management"], latencyMilliseconds: 1 },
    loadCost: { workerState: "warm", modelArtifactCached: true },
  }, {
    targetId: provider.providerId, targetKind: "external_provider", lifecycleState: provider.lifecycleState,
    operations: ["responses"], profile: selected, resourceAccountingMode: "provider_contract",
    providerCapacity: { availableConcurrentRequests: provider.limits.concurrency, maximumConcurrentRequests: provider.limits.concurrency },
    allowedDataClasses: provider.allowedDataClasses, contractState: provider.contract.state,
    healthFresh: providerFresh, network: { classes: ["management"], latencyMilliseconds: provider.health.latencyMilliseconds ?? 2 },
    routingWeight: provider.modelMappings[0].routingWeight,
  }];
}

async function routeChecks(database, provider, capabilityId, policyPrefix) {
  const repository = new PostgresRoutingPolicyRepository({ database });
  const modes = ["internal_only", "internal_first", "external_first", "weighted", "pinned"];
  const policies = {};
  for (const mode of modes) {
    policies[mode] = await repository.findByKey(`${policyPrefix}.${mode.replaceAll("_", "-")}`);
    need(policies[mode]?.enabled === true, `persisted ${mode} policy is unavailable`);
  }
  const job = { jobId: randomUUID(), ownerIdentityId: randomUUID(), capabilityId, operation: "responses", dataClass: "internal", priority: 50, submittedAt: new Date().toISOString(), inputArtifacts: [] };
  const rank = (mode, options = {}) => rankSchedulingCandidates({
    job: { ...job, ...(options.job ?? {}) }, candidates: candidates(provider, capabilityId, options.candidates),
    routingPolicy: policies[mode].routing,
    ...(mode === "weighted" ? { scoringWeights: { loadCost: 0, locality: 0, capacityHeadroom: 0, queueFairness: 0, network: 0, routingWeight: 1 } } : {}),
  });
  const internalOnly = rank("internal_only"), internalFirst = rank("internal_first");
  const overflow = rank("internal_first", { candidates: { localState: "offline" } });
  const externalFirst = rank("external_first"), externalFallback = rank("external_first", { candidates: { providerFresh: false } });
  const weighted = rank("weighted"), pinned = rank("pinned");
  const localOnly = rank("external_first", { job: { extensions: { routing: { localOnly: true } } } });
  const observed = {
    internalOnly: internalOnly.selected?.targetId ?? null,
    internalFirst: internalFirst.selected?.targetId ?? null,
    overflow: overflow.selected?.targetId ?? null,
    externalFirst: externalFirst.selected?.targetId ?? null,
    externalFallback: externalFallback.selected?.targetId ?? null,
    weighted: weighted.selected?.targetId ?? null,
    pinned: pinned.selected?.targetId ?? null,
    localOnly: localOnly.selected?.targetId ?? null,
    localOnlyReasons: localOnly.reasonCounts,
  };
  need(internalOnly.selected?.targetId === "spark-local" && internalFirst.selected?.targetId === "spark-local"
    && overflow.selected?.targetId === provider.providerId && externalFirst.selected?.targetId === provider.providerId
    && externalFallback.selected?.targetId === "spark-local" && weighted.selected?.targetId === provider.providerId
    && pinned.selected?.targetId === provider.providerId
    && localOnly.selected?.targetId === "spark-local" && localOnly.reasonCounts.external_route_not_allowed === 1,
  `real-provider route decisions drifted: ${JSON.stringify(observed)}`);
  return {
    modes, internalOnly: "local", internalFirst: "local", internalFirstOverflow: "external",
    externalFirst: "external", externalFirstFallback: "local", weighted: "external", pinned: "external",
    localOnly: "local", localOnlyExternalRejections: localOnly.reasonCounts.external_route_not_allowed,
  };
}

async function createJob(database, ownerIdentityId, capabilityId, suffix) {
  const jobId = randomUUID(), request = Buffer.from(`real-provider-routing:${suffix}`), requestDigest = sha256(request);
  await database.query(`INSERT INTO compute.jobs (id,owner_identity_id,capability_id,status,priority,request_metadata,operation,requested_model_profile_id,route,request_digest,request_size_bytes,data_class,correlation_key) VALUES ($1,$2,$3,'queued',50,$4::jsonb,'responses',$5,'unassigned',$6,$7,'internal',$8)`, [
    jobId, ownerIdentityId, capabilityId, JSON.stringify({ qualification: true, suffix }), PROFILE_ID,
    Buffer.from(requestDigest.slice(7), "hex"), request.byteLength, `real-provider-routing:${suffix}:${jobId}`,
  ]);
  request.fill(0); return { jobId, requestDigest };
}

const compact = (attempt) => ({
  attemptId: attempt.attemptId, jobId: attempt.jobId, providerId: attempt.providerId,
  attemptNumber: attempt.attemptNumber, lifecycleState: attempt.lifecycleState,
  acceptanceState: attempt.acceptanceState, retryAction: attempt.retryAction,
  retryClassification: attempt.retryClassification, cancellationState: attempt.cancellationState,
  reconciled: attempt.reconciled, eventKinds: attempt.events.map((event) => event.eventKind),
  observedOutputBytes: attempt.observedOutputBytes, outputChainDigest: attempt.outputChainDigest,
});

async function qualify(input) {
  const database = await createPostgresDatabaseFromEnvironment();
  const store = await secretStore();
  const attempts = new PostgresExternalAttemptRepository({ database });
  const jobs = [];
  try {
    const provider = await new PostgresExternalProviderRepository({ database }).findById(input.providerId);
    need(provider?.lifecycleState === "healthy" && provider.contract.state === "passed"
      && provider.modelMappings.length === 1 && provider.modelMappings[0].modelProfileId === PROFILE_ID
      && provider.modelMappings[0].providerModelName === MODEL, "real provider is not eligible");
    const row = (await database.query("SELECT capability_id FROM compute.model_profiles WHERE id=$1", [PROFILE_ID])).rows[0];
    need(row?.capability_id, "real model profile is unavailable");
    const routing = await routeChecks(database, provider, row.capability_id, input.policyPrefix);

    const dispatchJob = await createJob(database, input.ownerIdentityId, row.capability_id, `${input.runMarker}:dispatch`);
    jobs.push(dispatchJob.jobId);
    const coordinator = new ExternalAttemptCoordinator({ repository: attempts, transport: providerTransport(provider, store) });
    const dispatched = await coordinator.dispatchWithFailover({
      jobId: dispatchJob.jobId, ownerIdentityId: input.ownerIdentityId, requestDigest: dispatchJob.requestDigest, maximumAttempts: 2,
      targets: ["overload", "partial-output"].map((scenario) => ({
        providerId: provider.providerId, modelProfileId: PROFILE_ID, providerModel: MODEL,
        request: { scenario }, replayContract: provider.executionContract,
      })),
    });
    const history = await attempts.history(dispatchJob.jobId);
    need(dispatched.completed === false && dispatched.decision?.action === "manual_reconcile" && history.length === 2
      && history[0].acceptanceState === "not_accepted" && history[0].retryAction === "failover"
      && history[1].acceptanceState === "output_observed" && history[1].retryAction === "manual_reconcile"
      && history[1].observedOutputBytes > 0,
    `real-provider durable partial failover drifted: ${JSON.stringify({
      completed: dispatched.completed, decision: dispatched.decision,
      attempts: history.map(compact),
    })}`);
    const usage = await new ExternalUsageAccountant({ repository: new PostgresExternalUsageRepository({ database }) }).record({
      attemptId: history[1].attemptId, jobId: dispatchJob.jobId, providerId: provider.providerId,
      accounting: provider.costAccounting,
      usage: { inputTokens: 0, outputTokens: 0, imageRequests: 0, audioMilliseconds: 0, source: "platform_observed" },
    });

    const cancellationJob = await createJob(database, input.ownerIdentityId, row.capability_id, `${input.runMarker}:cancel`);
    jobs.push(cancellationJob.jobId);
    const cancellationAttemptId = randomUUID();
    await attempts.begin({
      attemptId: cancellationAttemptId, jobId: cancellationJob.jobId, ownerIdentityId: input.ownerIdentityId,
      providerId: provider.providerId, modelProfileId: PROFILE_ID, providerModel: MODEL,
      requestDigest: cancellationJob.requestDigest, idempotencyKey: null,
      replayContract: provider.executionContract, startedAt: new Date(),
    });
    const realRequestId = await acceptedProviderRequest(provider, store);
    await attempts.markAccepted(cancellationAttemptId, { providerRequestId: realRequestId, acceptedAt: new Date() });
    const cancelled = await coordinator.cancel({ attemptId: cancellationAttemptId });
    need(cancelled.outcome === "reconcile_required" && cancelled.attempt.cancellationState === "unsupported",
      "unsupported real-provider cancellation did not require reconciliation");
    await attempts.fail(cancellationAttemptId, {
      errorCode: "provider_cancel_reconciled_failed",
      decision: { action: "terminal", retryClassification: "terminal", blindReplayAllowed: false },
      finishedAt: new Date(), reconciled: true,
    });
    const finalCancellation = await attempts.get(cancellationAttemptId);
    need(finalCancellation.reconciled === true && finalCancellation.lifecycleState === "failed",
      "real-provider cancellation reconciliation did not terminalize")
    const audit = (await database.query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status IN ('succeeded','failed','cancelled','incomplete'))::int AS terminal
      FROM compute.jobs WHERE id = ANY($1::uuid[])`, [jobs])).rows[0];
    const active = (await database.query(`
      SELECT count(*)::int AS value FROM compute.external_attempt_dispatches
      WHERE job_id = ANY($1::uuid[])
        AND lifecycle_state IN ('dispatching','accepted','streaming','reconcile_required')`, [jobs])).rows[0];
    need(Number(audit?.total) === jobs.length && Number(audit?.terminal) === jobs.length
      && Number(active?.value) === 0, "qualification audit jobs did not reach durable terminal states");
    return {
      provider: { providerId: provider.providerId, providerKey: provider.providerKey, model: MODEL, profileId: PROFILE_ID },
      routing,
      failover: { jobId: dispatchJob.jobId, completed: dispatched.completed, decision: dispatched.decision, attempts: history.map(compact) },
      accounting: {
        attemptId: usage.attemptId, accountingMode: usage.accountingMode, currency: usage.currency,
        totalMicrounits: usage.totalMicrounits, usage: usage.usage, hardwareMetrics: usage.hardwareMetrics,
      },
      cancellation: { realProviderRequestIdPresent: true, outcome: cancelled.outcome, finalAttempt: compact(finalCancellation) },
      durableAudit: {
        retention: "append_only", jobsRetained: jobs.length,
        terminalJobs: Number(audit.terminal), activeAttempts: Number(active.value),
      },
    };
  } finally {
    try { const provider = await new PostgresExternalProviderRepository({ database }).findById(input.providerId); if (provider) await gatewayState(provider, store, { healthy: true, next_scenario: "normal" }); } catch {}
    store.close(); await database.close();
  }
}

async function healthRoute(input) {
  const database = await createPostgresDatabaseFromEnvironment();
  try {
    const provider = await new PostgresExternalProviderRepository({ database }).findById(input.providerId);
    need(provider, "real provider is unavailable for health routing");
    const row = (await database.query("SELECT capability_id FROM compute.model_profiles WHERE id=$1", [PROFILE_ID])).rows[0];
    const policy = await new PostgresRoutingPolicyRepository({ database }).findByKey(`${input.policyPrefix}.internal-first`);
    need(row?.capability_id && policy?.enabled === true, "real-provider health routing prerequisites are unavailable");
    const result = rankSchedulingCandidates({
      job: { jobId: randomUUID(), ownerIdentityId: randomUUID(), capabilityId: row.capability_id, operation: "responses", dataClass: "internal", priority: 50, submittedAt: new Date().toISOString(), inputArtifacts: [] },
      candidates: candidates(provider, row.capability_id, { localState: input.expectedTarget === "external" ? "offline" : "ready", providerFresh: provider.lifecycleState === "healthy" }),
      routingPolicy: policy.routing,
    });
    const selected = result.selected?.targetKind === "external_provider" ? "external" : result.selected?.targetKind === "local" ? "local" : null;
    need(selected === input.expectedTarget, "real-provider health route selected the wrong target");
    return { selectedTarget: selected, providerLifecycleState: provider.lifecycleState, providerHealthState: provider.health.state, reasonCounts: result.reasonCounts };
  } finally { await database.close(); }
}

const raw = process.argv[1];
try {
  need(typeof raw === "string" && raw.length < 100_000, "probe input is invalid");
  const input = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  need(new Set(["qualify", "health-route"]).has(input.phase), "probe phase is invalid");
  const result = input.phase === "qualify" ? await qualify(input) : await healthRoute(input);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(`Error: ${String(error?.message ?? error).slice(0, 2000)}\n`);
  process.exitCode = 1;
}
