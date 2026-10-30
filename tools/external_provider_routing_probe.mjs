import { createHash, randomUUID } from "node:crypto";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";

import { PostgresExternalProviderRepository } from "/opt/teamaibox/apps/platform-api/src/providers/postgres-provider-repository.mjs";
import { createPostgresDatabaseFromEnvironment } from "/opt/teamaibox/packages/persistence/src/postgres-database.mjs";
import { EncryptedSecretStore, FileCiphertextBackend } from "/opt/teamaibox/packages/secrets/src/index.mjs";
import { RemoteProtectedObjectService } from "/opt/teamaibox/services/object-service/src/internal-rpc-client.mjs";
import { ExternalAttemptCoordinator } from "/opt/teamaibox/services/scheduler/src/external-attempt-coordinator.mjs";
import { ExternalObjectTransferService } from "/opt/teamaibox/services/scheduler/src/external-object-transfer-service.mjs";
import { ExternalUsageAccountant } from "/opt/teamaibox/services/scheduler/src/external-usage-accountant.mjs";
import { PostgresExternalAttemptRepository } from "/opt/teamaibox/services/scheduler/src/postgres-external-attempt-repository.mjs";
import { PostgresExternalObjectGrantRepository } from "/opt/teamaibox/services/scheduler/src/postgres-external-object-grant-repository.mjs";
import { PostgresExternalUsageRepository } from "/opt/teamaibox/services/scheduler/src/postgres-external-usage-repository.mjs";
import { PostgresRoutingPolicyRepository } from "/opt/teamaibox/services/scheduler/src/postgres-routing-policy-repository.mjs";
import { rankSchedulingCandidates } from "/opt/teamaibox/services/scheduler/src/routing-engine.mjs";

const PROFILE_ID = "1bec1694-44be-573a-a4f5-99f18e27d898";
const PROVIDER_MODEL = "contract/giant-llm";
const GIB = 1024 ** 3;
const TERMINAL = new Set(["succeeded", "failed", "incomplete", "cancelled"]);

function require(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function compactAttempt(value) {
  return {
    attemptId: value.attemptId,
    jobId: value.jobId,
    attemptNumber: value.attemptNumber,
    providerId: value.providerId,
    lifecycleState: value.lifecycleState,
    acceptanceState: value.acceptanceState,
    retryAction: value.retryAction,
    retryClassification: value.retryClassification,
    cancellationState: value.cancellationState,
    reconciled: value.reconciled,
    eventKinds: (value.events ?? []).map((event) => event.eventKind),
  };
}

async function createSecretStore() {
  const raw = await readFile(process.env.PLATFORM_PROVIDER_SECRET_MASTER_KEY_FILE);
  let masterKey;
  try {
    const encoded = raw.toString("utf8").trim();
    masterKey = Buffer.from(encoded, "base64url");
    require(masterKey.byteLength === 32 && masterKey.toString("base64url") === encoded,
      "provider secret master key is invalid");
    return new EncryptedSecretStore({
      masterKey,
      backend: new FileCiphertextBackend(process.env.PLATFORM_PROVIDER_SECRET_CIPHERTEXT_DIR),
    });
  } finally {
    masterKey?.fill(0);
    raw.fill(0);
  }
}

function requestHttps({ url, credential, customCa, body, scenario }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = https.request(parsed, {
      method: "POST",
      ca: customCa,
      rejectUnauthorized: true,
      ...(isIP(parsed.hostname) ? {} : { servername: parsed.hostname }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${credential.toString("utf8")}`,
        "content-type": "application/json",
        "content-length": String(body.byteLength),
        "idempotency-key": scenario.idempotencyKey,
        "x-teamaibox-contract-scenario": scenario.name,
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.byteLength;
        if (size > 2 * 1024 * 1024) {
          request.destroy(Object.assign(new Error("provider response exceeded bound"), { code: "provider_response_too_large" }));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.setTimeout(10_000, () => request.destroy(Object.assign(new Error("provider request timed out"), {
      code: "provider_timeout", retryable: true,
    })));
    request.on("error", reject);
    request.end(body);
  });
}

function providerTransport({ provider, secretStore }) {
  const reader = Object.freeze({ service: "provider-adapter", permissions: Object.freeze(["secrets:read"]) });
  async function withSecrets(callback) {
    const withCa = (credential) => provider.caSecretKey
      ? secretStore.withSecret(provider.caSecretKey, reader, (customCa) => callback(credential, customCa))
      : callback(credential, null);
    return provider.credentialSecretKey
      ? secretStore.withSecret(provider.credentialSecretKey, reader, (credential) => withCa(credential))
      : withCa(null);
  }
  return Object.freeze({
    async execute({ request, idempotencyKey, onAccepted, onOutput }) {
      const outbound = Buffer.from(JSON.stringify({
        model: PROVIDER_MODEL,
        input: "deployed external routing qualification",
        stream: request.scenario === "partial-output",
      }));
      let response;
      try {
        response = await withSecrets((credential, customCa) => requestHttps({
          url: `${provider.endpoint}/responses`, credential, customCa, body: outbound,
          scenario: { name: request.scenario, idempotencyKey },
        }));
      } finally {
        outbound.fill(0);
      }
      if (response.status === 429) {
        throw Object.assign(new Error("provider overloaded before acceptance"), {
          code: "provider_overloaded", retryable: true,
        });
      }
      if (response.status === 503 || response.status === 504) {
        throw Object.assign(new Error("provider unavailable before acceptance"), {
          code: response.status === 504 ? "provider_timeout" : "provider_unavailable",
          retryable: true,
        });
      }
      require(response.status === 200, `provider returned unexpected HTTP ${response.status}`);
      const document = response.body.toString("utf8");
      if (request.scenario === "partial-output") {
        const requestId = /\"id\":\"([^\"]+)\"/.exec(document)?.[1];
        const delta = /\"delta\":\"([^\"]+)\"/.exec(document)?.[1];
        require(requestId && delta && !document.includes("response.completed"),
          "partial provider stream did not preserve the expected boundary");
        await onAccepted({ providerRequestId: requestId });
        const bytes = Buffer.from(delta);
        const output = { sequence: 1, sizeBytes: bytes.byteLength, sha256: sha256(bytes) };
        await onOutput(output);
        throw Object.assign(new Error("provider stream ended after partial output"), {
          code: "provider_stream_incomplete", retryable: true, accepted: true,
          providerRequestId: requestId, outputObserved: output,
        });
      }
      throw Object.assign(new Error("unexpected provider scenario"), {
        code: "provider_scenario_invalid", definitive: true,
      });
    },
  });
}

function certifiedProfile(capabilityId) {
  return {
    profileId: PROFILE_ID,
    profileKey: "compute.text-transform.deterministic.arm64.v4",
    capabilityId,
    precision: "nvfp4",
    compatibility: { architectures: ["linux/arm64/v8"] },
    resourceEnvelope: {
      cpuMillis: 1000,
      unifiedMemoryBytes: GIB,
      acceleratorUnits: 0,
      codecSessions: 0,
      storageBytes: GIB,
      networkBitsPerSecond: 10_000_000,
    },
    dataPolicy: {
      allowedDataClasses: ["public", "internal", "confidential"],
      externalProcessing: "approved_only",
    },
    certification: { state: "certified", evidenceRefs: ["evidence://managed-node-compute/arm64-v4"] },
    extensions: { schedulerRequirements: { storageClass: "encrypted_nvme", network: { class: "management" } } },
  };
}

function candidates({ provider, capabilityId, localState = "ready", providerFresh = true }) {
  const profile = certifiedProfile(capabilityId);
  const local = {
    targetId: "spark-local",
    targetKind: "local",
    lifecycleState: localState,
    architecture: "arm64",
    operations: ["responses"],
    profile,
    availableResources: {
      cpuMillis: 8000,
      unifiedMemoryBytes: 64 * GIB,
      acceleratorUnits: 1,
      codecSessions: 2,
      storageBytes: 100 * GIB,
      networkBitsPerSecond: 1_000_000_000,
    },
    storage: { classes: ["encrypted_nvme"] },
    network: { classes: ["management"], latencyMilliseconds: 1 },
    loadCost: { workerState: "warm", modelArtifactCached: true },
  };
  const external = {
    targetId: provider.providerId,
    targetKind: "external_provider",
    lifecycleState: provider.lifecycleState,
    operations: ["responses"],
    profile,
    resourceAccountingMode: "provider_contract",
    providerCapacity: { availableConcurrentRequests: provider.limits.concurrency, maximumConcurrentRequests: provider.limits.concurrency },
    allowedDataClasses: provider.allowedDataClasses,
    contractState: provider.contract.state,
    healthFresh: providerFresh,
    network: { classes: ["management"], latencyMilliseconds: provider.health.latencyMilliseconds ?? 2 },
    routingWeight: provider.modelMappings[0].routingWeight,
  };
  return [local, external];
}

async function createJob(database, { ownerIdentityId, capabilityId, suffix }) {
  const jobId = randomUUID();
  const request = Buffer.from(JSON.stringify({ model: PROVIDER_MODEL, input: "deployed external routing qualification" }));
  const requestDigest = sha256(request);
  await database.query(`
    INSERT INTO compute.jobs (
      id,owner_identity_id,capability_id,status,priority,request_metadata,operation,
      requested_model_profile_id,route,request_digest,request_size_bytes,data_class,correlation_key
    ) VALUES ($1,$2,$3,'queued',50,$4::jsonb,'responses',$5,'unassigned',$6,$7,'internal',$8)`, [
    jobId, ownerIdentityId, capabilityId, JSON.stringify({ qualification: true, suffix }), PROFILE_ID,
    Buffer.from(requestDigest.slice(7), "hex"), request.byteLength, `external-routing-qualification:${suffix}`,
  ]);
  request.fill(0);
  return { jobId, requestDigest };
}

async function policyRouting({ database, provider, capabilityId, policyPrefix }) {
  const repository = new PostgresRoutingPolicyRepository({ database });
  const modes = ["internal_only", "internal_first", "external_first", "weighted", "pinned"];
  const policies = {};
  for (const mode of modes) {
    const value = await repository.findByKey(`${policyPrefix}.${mode.replaceAll("_", "-")}`);
    require(value?.enabled === true && value.routing.mode === mode, `deployed ${mode} policy is unavailable`);
    policies[mode] = value;
  }
  const job = {
    jobId: randomUUID(), ownerIdentityId: randomUUID(), capabilityId,
    operation: "responses", dataClass: "internal", priority: 50,
    submittedAt: new Date().toISOString(), inputArtifacts: [],
  };
  const route = (mode, overrides = {}) => rankSchedulingCandidates({
    job: { ...job, ...(overrides.job ?? {}) },
    candidates: candidates({ provider, capabilityId, ...(overrides.candidates ?? {}) }),
    routingPolicy: policies[mode].routing,
  });
  const internalOnly = route("internal_only");
  const internalFirst = route("internal_first");
  const overflow = route("internal_first", { candidates: { localState: "offline" } });
  const externalFirst = route("external_first");
  const externalFallback = route("external_first", { candidates: { providerFresh: false } });
  const weighted = rankSchedulingCandidates({
    job,
    candidates: candidates({ provider, capabilityId }),
    routingPolicy: policies.weighted.routing,
    scoringWeights: {
      loadCost: 0,
      locality: 0,
      capacityHeadroom: 0,
      queueFairness: 0,
      network: 0,
      routingWeight: 1,
    },
  });
  const pinned = route("pinned");
  const pinnedUnavailable = route("pinned", { candidates: { providerFresh: false } });
  const localOnly = route("external_first", { job: { extensions: { routing: { localOnly: true } } } });
  const externalOnlyLocalData = rankSchedulingCandidates({
    job: { ...job, extensions: { routing: { localOnly: true } } },
    candidates: candidates({ provider, capabilityId }).slice(1),
    routingPolicy: policies.external_first.routing,
  });
  require(internalOnly.selected?.targetId === "spark-local", "internal-only did not select local compute");
  require(internalFirst.selected?.targetId === "spark-local", "internal-first did not select local compute");
  require(overflow.selected?.targetId === provider.providerId, "internal-first did not overflow externally");
  require(externalFirst.selected?.targetId === provider.providerId, "external-first did not select external compute");
  require(externalFallback.selected?.targetId === "spark-local", "external-first did not fall back locally");
  require(weighted.selected?.targetId === provider.providerId, "weighted policy did not apply persisted target weights");
  require(pinned.selected?.targetId === provider.providerId, "pinned policy did not select its provider");
  require(pinnedUnavailable.selected === null && pinnedUnavailable.waitingReason === "pinned_target_unavailable",
    "pinned provider failure did not fail closed");
  require(localOnly.selected?.targetId === "spark-local"
    && localOnly.rejected.some((item) => item.targetId === provider.providerId
      && item.reasons.some((reason) => reason.code === "external_route_not_allowed")),
  "local-only data did not exclude external compute");
  require(externalOnlyLocalData.selected === null
    && externalOnlyLocalData.reasonCounts.external_route_not_allowed === 1,
  "local-only external-only plan did not reject the provider");
  return {
    policies: Object.fromEntries(modes.map((mode) => [mode, {
      policyId: policies[mode].policyId,
      policyKey: policies[mode].policyKey,
      revision: policies[mode].revision,
    }])),
    decisions: {
      internalOnly: internalOnly.policyExplanation,
      internalFirst: internalFirst.policyExplanation,
      internalFirstOverflow: overflow.policyExplanation,
      externalFirst: externalFirst.policyExplanation,
      externalFirstFallback: externalFallback.policyExplanation,
      weighted: weighted.policyExplanation,
      pinned: pinned.policyExplanation,
      pinnedUnavailable: { waitingReason: pinnedUnavailable.waitingReason, reasonCounts: pinnedUnavailable.reasonCounts },
      localOnly: { selectedTargetId: localOnly.selected?.targetId, reasonCounts: localOnly.reasonCounts },
      externalOnlyLocalData: { waitingReason: externalOnlyLocalData.waitingReason, reasonCounts: externalOnlyLocalData.reasonCounts },
    },
  };
}

async function prepare({ providerId, ownerIdentityId, policyPrefix, runMarker }) {
  const database = await createPostgresDatabaseFromEnvironment();
  const secretStore = await createSecretStore();
  const objectService = await RemoteProtectedObjectService.fromEnvironment();
  const attemptRepository = new PostgresExternalAttemptRepository({ database });
  const providerRepository = new PostgresExternalProviderRepository({ database });
  let objectId = null;
  let cancellationAttemptId = null;
  let cancellationJobId = null;
  try {
    const provider = await providerRepository.findById(providerId);
    require(provider?.lifecycleState === "healthy" && provider.contract.state === "passed",
      "deployed provider is not eligible");
    require(provider.modelMappings.length === 1 && provider.modelMappings[0].modelProfileId === PROFILE_ID,
      "deployed provider model mapping drifted");
    const profile = (await database.query("SELECT capability_id FROM compute.model_profiles WHERE id=$1", [PROFILE_ID])).rows[0];
    require(profile?.capability_id, "qualified model profile is absent");
    const routing = await policyRouting({ database, provider, capabilityId: profile.capability_id, policyPrefix });

    const coordinator = new ExternalAttemptCoordinator({
      repository: attemptRepository,
      transport: providerTransport({ provider, secretStore }),
    });
    const dispatchJob = await createJob(database, {
      ownerIdentityId, capabilityId: profile.capability_id, suffix: `${runMarker}:dispatch`,
    });
    const failover = await coordinator.dispatchWithFailover({
      jobId: dispatchJob.jobId,
      ownerIdentityId,
      requestDigest: dispatchJob.requestDigest,
      maximumAttempts: 2,
      targets: [
        { providerId, modelProfileId: PROFILE_ID, providerModel: PROVIDER_MODEL,
          request: { scenario: "overload" }, replayContract: provider.executionContract },
        { providerId, modelProfileId: PROFILE_ID, providerModel: PROVIDER_MODEL,
          request: { scenario: "partial-output" }, replayContract: provider.executionContract },
      ],
    });
    const history = await attemptRepository.history(dispatchJob.jobId);
    require(failover.completed === false && failover.decision?.action === "manual_reconcile"
      && history.length === 2
      && history[0].acceptanceState === "not_accepted" && history[0].retryAction === "failover"
      && history[1].acceptanceState === "output_observed" && history[1].lifecycleState === "incomplete"
      && history[1].retryAction === "manual_reconcile",
    "durable failover/partial-output attempt boundary drifted");

    const usage = await new ExternalUsageAccountant({
      repository: new PostgresExternalUsageRepository({ database }),
    }).record({
      attemptId: history[1].attemptId,
      jobId: dispatchJob.jobId,
      providerId,
      accounting: provider.costAccounting,
      usage: { inputTokens: 1000, outputTokens: 500, imageRequests: 0, audioMilliseconds: 0, source: "provider_reported" },
    });

    const cancellationJob = await createJob(database, {
      ownerIdentityId, capabilityId: profile.capability_id, suffix: `${runMarker}:cancel`,
    });
    cancellationJobId = cancellationJob.jobId;
    cancellationAttemptId = randomUUID();
    await attemptRepository.begin({
      attemptId: cancellationAttemptId,
      jobId: cancellationJobId,
      ownerIdentityId,
      providerId,
      modelProfileId: PROFILE_ID,
      providerModel: PROVIDER_MODEL,
      requestDigest: cancellationJob.requestDigest,
      idempotencyKey: `taib:${cancellationJobId}:${providerId}`,
      replayContract: {
        idempotencyMode: "provider_key", replayAfterAcceptance: "same_provider",
        reconcileMode: "none", cancellationMode: "none", sideEffectClass: "idempotent",
      },
      startedAt: new Date(),
    });
    await attemptRepository.markAccepted(cancellationAttemptId, {
      providerRequestId: `accepted-${runMarker}`,
      acceptedAt: new Date(),
    });

    const context = {
      identityId: ownerIdentityId,
      identityKind: "local_user",
      namespaceAccess: [{
        namespaceKey: `user:${ownerIdentityId}`,
        operations: ["write", "read", "list", "delete", "reference:create"],
      }],
    };
    const content = Buffer.from(`external-provider-object-${runMarker}`);
    const stored = await objectService.upload({
      context,
      namespaceKey: `user:${ownerIdentityId}`,
      objectKey: `validation/external-provider/${runMarker}/${randomUUID()}.txt`,
      contentType: "text/plain",
      content,
    });
    objectId = stored.objectId;
    const transfer = new ExternalObjectTransferService({
      repository: new PostgresExternalObjectGrantRepository({ database }),
      objectGateway: objectService.createObjectHandoffGateway(),
      publicOrigin: process.env.PLATFORM_API_PUBLIC_ORIGIN,
    });
    const [grant] = await transfer.issueInputs({
      ownerIdentityId,
      jobId: cancellationJobId,
      attemptId: cancellationAttemptId,
      providerId,
      leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      inputArtifacts: [{
        role: "request.input",
        object: {
          objectId: stored.objectId,
          objectVersion: stored.version,
          sha256: `sha256:${stored.integrity.digest}`,
          size: stored.size,
          mediaType: stored.contentType,
        },
      }],
    });
    return {
      providerId,
      ownerIdentityId,
      routing,
      failover: {
        jobId: dispatchJob.jobId,
        completed: failover.completed,
        decision: failover.decision,
        attempts: history.map(compactAttempt),
      },
      accounting: {
        attemptId: usage.attemptId,
        accountingMode: usage.accountingMode,
        currency: usage.currency,
        totalMicrounits: usage.totalMicrounits,
        usage: usage.usage,
        hardwareMetrics: usage.hardwareMetrics,
      },
      objectProxy: {
        path: new URL(grant.url).pathname,
        objectId,
        objectVersion: stored.version,
        size: stored.size,
        sha256: `sha256:${stored.integrity.digest}`,
        contentType: stored.contentType,
      },
      cancellation: { jobId: cancellationJobId, attemptId: cancellationAttemptId },
    };
  } catch (error) {
    if (cancellationAttemptId) {
      try {
        const current = await attemptRepository.get(cancellationAttemptId);
        if (current && !TERMINAL.has(current.lifecycleState)) {
          await attemptRepository.fail(cancellationAttemptId, {
            errorCode: "qualification_cleanup",
            decision: { action: "terminal", retryClassification: "terminal", blindReplayAllowed: false },
            finishedAt: new Date(), reconciled: true,
          });
        }
      } catch {}
      try {
        const transfer = new ExternalObjectTransferService({
          repository: new PostgresExternalObjectGrantRepository({ database }),
          objectGateway: objectService.createObjectHandoffGateway(),
          publicOrigin: process.env.PLATFORM_API_PUBLIC_ORIGIN,
        });
        await transfer.revokeAttempt({ ownerIdentityId, attemptId: cancellationAttemptId, reason: "qualification_cleanup" });
      } catch {}
    }
    if (objectId) {
      try {
        await objectService.delete({
          context: { identityId: ownerIdentityId, identityKind: "local_user", namespaceAccess: [{ namespaceKey: `user:${ownerIdentityId}`, operations: ["delete"] }] },
          namespaceKey: `user:${ownerIdentityId}`, objectId,
        });
      } catch {}
    }
    throw error;
  } finally {
    secretStore.close();
    await database.close();
  }
}

async function finalize({ providerId, ownerIdentityId, attemptId, objectId, jobIds }) {
  const database = await createPostgresDatabaseFromEnvironment();
  const objectService = await RemoteProtectedObjectService.fromEnvironment();
  const repository = new PostgresExternalAttemptRepository({ database });
  try {
    let current = await repository.get(attemptId);
    require(current, "cancellation attempt is unavailable");
    let cancellationOutcome = "already_terminal";
    let afterCancellation;
    if (!TERMINAL.has(current.lifecycleState)) {
      const coordinator = new ExternalAttemptCoordinator({
        repository,
        transport: { async execute() { throw new Error("not used"); } },
      });
      const cancelled = await coordinator.cancel({ attemptId });
      cancellationOutcome = cancelled.outcome;
      current = cancelled.attempt;
      afterCancellation = compactAttempt(await repository.get(attemptId));
    } else if ((current.events ?? []).some((event) => event.eventKind === "reconcile_required")
      && current.cancellationState === "unsupported") {
      cancellationOutcome = "reconcile_required";
      afterCancellation = {
        ...compactAttempt(current),
        lifecycleState: "reconcile_required",
        reconciled: false,
      };
    }
    require(cancellationOutcome === "reconcile_required"
      && afterCancellation.lifecycleState === "reconcile_required"
      && afterCancellation.cancellationState === "unsupported",
    "unsupported provider cancellation did not require reconciliation");
    const terminalized = await repository.fail(attemptId, {
      errorCode: "provider_cancel_reconciled_failed",
      decision: { action: "terminal", retryClassification: "terminal", blindReplayAllowed: false },
      finishedAt: new Date(),
      reconciled: true,
    });
    const transfer = new ExternalObjectTransferService({
      repository: new PostgresExternalObjectGrantRepository({ database }),
      objectGateway: objectService.createObjectHandoffGateway(),
      publicOrigin: process.env.PLATFORM_API_PUBLIC_ORIGIN,
    });
    const revoked = await transfer.revokeAttempt({
      ownerIdentityId,
      attemptId,
      reason: "compute_attempt_finished",
    });
    let objectDeleted = false;
    try {
      const deleted = await objectService.delete({
        context: {
          identityId: ownerIdentityId,
          identityKind: "local_user",
          namespaceAccess: [{ namespaceKey: `user:${ownerIdentityId}`, operations: ["delete"] }],
        },
        namespaceKey: `user:${ownerIdentityId}`,
        objectId,
      });
      objectDeleted = deleted.deleted === true;
    } catch (error) {
      if (error?.status !== 404) throw error;
      objectDeleted = true;
    }
    const activeAttempts = Number((await database.query(`
      SELECT count(*)::integer AS count FROM compute.external_attempt_dispatches
      WHERE job_id=ANY($1::uuid[]) AND lifecycle_state IN ('dispatching','accepted','streaming','reconcile_required')`, [jobIds])).rows[0].count);
    const activeGrants = Number((await database.query(`
      SELECT count(*)::integer AS count FROM compute.external_object_grants
      WHERE attempt_id=$1 AND state IN ('active','consuming')`, [attemptId])).rows[0].count);
    require(terminalized.lifecycleState === "failed" && terminalized.reconciled === true
      && activeAttempts === 0 && activeGrants === 0 && objectDeleted,
    "qualification cleanup left active durable state");
    return {
      cancellationOutcome,
      afterCancellation,
      finalAttempt: compactAttempt(await repository.get(attemptId)),
      grantsRevoked: revoked.revoked,
      objectDeleted,
      activeAttempts,
      activeGrants,
    };
  } finally {
    await database.close();
  }
}

async function healthRoute({ providerId, policyPrefix, expectedTarget }) {
  const database = await createPostgresDatabaseFromEnvironment();
  try {
    const provider = await new PostgresExternalProviderRepository({ database }).findById(providerId);
    require(provider, "deployed provider is unavailable");
    const profile = (await database.query("SELECT capability_id FROM compute.model_profiles WHERE id=$1", [PROFILE_ID])).rows[0];
    require(profile?.capability_id, "qualified model profile is absent");
    const policy = await new PostgresRoutingPolicyRepository({ database })
      .findByKey(`${policyPrefix}.external-first`);
    require(policy?.enabled === true && policy.routing.mode === "external_first",
      "deployed external-first policy is unavailable");
    const result = rankSchedulingCandidates({
      job: {
        jobId: randomUUID(), ownerIdentityId: randomUUID(), capabilityId: profile.capability_id,
        operation: "responses", dataClass: "internal", priority: 50,
        submittedAt: new Date().toISOString(), inputArtifacts: [],
      },
      candidates: candidates({ provider, capabilityId: profile.capability_id }),
      routingPolicy: policy.routing,
    });
    const expectedTargetId = expectedTarget === "external" ? providerId : "spark-local";
    require(result.selected?.targetId === expectedTargetId,
      `deployed provider health route did not select ${expectedTarget}`);
    return {
      providerId,
      providerLifecycleState: provider.lifecycleState,
      contractState: provider.contract.state,
      selectedTarget: expectedTarget,
      selectedTargetId: result.selected.targetId,
      policyExplanation: result.policyExplanation,
      reasonCounts: result.reasonCounts,
    };
  } finally {
    await database.close();
  }
}

const [phase, rawInput] = process.argv.slice(1);
require(new Set(["prepare", "finalize", "health-route"]).has(phase), "probe phase is invalid");
const input = JSON.parse(Buffer.from(rawInput, "base64url").toString("utf8"));
const result = phase === "prepare" ? await prepare(input)
  : phase === "finalize" ? await finalize(input)
    : await healthRoute(input);
process.stdout.write(JSON.stringify(result));
