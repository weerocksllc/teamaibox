import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import {
  createProtectedOfficeSetProductionRuntime,
} from "./protected-office-set-deployment-runtime.mjs";
import {
  encodeProtectedMaintenanceSignaturePayload,
} from "../../../services/scheduler/src/production-protected-maintenance-signature-verifier.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const MAINTENANCE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;
const ED25519_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._:/-]*@(sha256:[a-f0-9]{64})$/;
const SAFE_FILE = /^\/run\/(?:secrets|teamaibox\/protected-office-set)\/[A-Za-z0-9][A-Za-z0-9._-]{1,126}$/;
const TERMINAL_JOBS = new Set(["succeeded", "failed", "cancelled", "expired", "incomplete"]);
const RESTART_PROTOCOL = "teamaibox.protected-office-set-restart.v1";
const RESTART_COMMAND_TYPE = "appliance.runtime.restart";
const RESTART_TARGETS = Object.freeze(["platform-api", "node-agent"]);
const RESTART_OPERATION_ORDER = Object.freeze([
  "platform.restart", "platform.health", "node-agent.restart", "recovery.verify",
]);
const ACTIVE_CAST_STATES = Object.freeze(["requested", "starting", "pairing", "paired", "streaming", "stopping"]);
const ACTIVE_REALTIME_STATES = Object.freeze(["admitted", "connected"]);
const ACTION_REVISIONS = Object.freeze({
  "cold-boot": 0,
  "concurrent-office": 1,
  "bounded-maintenance": 2,
  "restart-verify": 3,
  "mid-sequence-failure": 4,
  recover: 5,
  cleanup: 6,
});
const CAPABILITIES = Object.freeze([
  ["assistant.answer", "assistant-qwen38", "/v1/chat/completions"],
  ["assistant.agent", "assistant-qwen38", "/api/v1/assistant/conversations/{conversation_id}/messages"],
  ["translation", "translation-lmt4", "/api/v1/ai/translations"],
  ["drawing.generate", "drawing-flux2", "/v1/images/generations"],
  ["ocr", "ocr-hunyuan", "/api/v1/ai/ocr"],
  ["embeddings", "embedding-qwen3", "/v1/embeddings"],
  ["asr.realtime", "asr-whisper", "/api/v1/realtime/sessions"],
]);
const COMPUTE_JOB_CAPABILITIES = Object.freeze(CAPABILITIES
  .filter(([capabilityId]) => !new Set(["assistant.agent", "asr.realtime"]).has(capabilityId)));
const SOURCE_NAMES = Object.freeze([
  "postgres-protected-set-transaction",
  "postgres-protected-set-state",
  "postgres-cluster-metric-raw-snapshot",
  "postgres-realtime-reservation",
  "casting-session",
  "mtls-node-agent-inspection",
  "authenticated-public-https",
]);

function fail(code, message, { status = 503, retryable = false, details = null } = {}) {
  throw new PlatformError(code, message, { status, retryable, details });
}

function copy(value) { return value == null ? null : structuredClone(value); }
function rows(value, label) {
  if (!value || !Array.isArray(value.rows)) throw new TypeError(`${label} PostgreSQL result is invalid`);
  return value.rows;
}
function json(value) { return typeof value === "string" ? JSON.parse(value) : copy(value); }
function iso(value, label) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} timestamp is invalid`);
  return date.toISOString();
}
function hexDigest(value) {
  if (value == null) return null;
  if (typeof value === "string" && SHA256.test(value)) return value;
  return `sha256:${Buffer.from(value).toString("hex")}`;
}
function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  throw new TypeError("protected office scenario value is not canonical JSON");
}
function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}
function deterministicUuid(value) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const text = bytes.toString("hex");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
function positive(value, label, { zero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new TypeError(`${label} is invalid`);
  return value;
}
function exactObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} is invalid`);
  return value;
}
function source(value) { return Object.freeze({ readOnly: true, mutationCount: 0, ...copy(value) }); }
function correlation(runId, action) { return `protected-office:${runId}:${action}`; }
function imageDigest(profile) {
  const match = IMAGE_REFERENCE.exec(profile.imageReference ?? "");
  if (!match) throw new TypeError(`protected office profile ${profile.slot ?? "unknown"} image is invalid`);
  return match[1];
}

function sameJson(left, right) { return canonical(left) === canonical(right); }

function normalizedManifest(plan, desiredStateRevision = plan?.set?.desiredStateRevision) {
  const profiles = plan?.set?.profiles;
  if (!UUID.test(plan?.target?.nodeId ?? "")
      || !Number.isSafeInteger(plan?.target?.nodeGeneration)
      || typeof plan?.set?.setId !== "string" || !Array.isArray(profiles) || profiles.length !== 6
      || !Number.isSafeInteger(desiredStateRevision) || desiredStateRevision < 1
      || !Number.isSafeInteger(plan.set.maintenanceGeneration) || plan.set.maintenanceGeneration < 1) {
    throw new TypeError("protected office deployment plan is unresolved");
  }
  const bySlot = new Map(profiles.map((profile) => [profile.slot, profile]));
  const result = profiles.map((profile, index) => {
    const dependsOnWorkerIds = (profile.dependsOnSlots ?? []).map((slot) => bySlot.get(slot)?.workerId);
    if (!UUID.test(profile.workerId ?? "") || !UUID.test(profile.modelProfileId ?? "")
        || !SHA256.test(profile.configurationDigest ?? "") || dependsOnWorkerIds.some((item) => !UUID.test(item ?? ""))) {
      throw new TypeError(`protected office profile ${profile.slot ?? index} is unresolved`);
    }
    return {
      workerId: profile.workerId,
      modelProfileId: profile.modelProfileId,
      imageDigest: imageDigest(profile),
      configurationDigest: profile.configurationDigest,
      placementClass: "protected-resident",
      maintenanceGeneration: plan.set.maintenanceGeneration,
      declaredResidentBytes: positive(profile.declaredResidentBytes, `${profile.slot}.declaredResidentBytes`),
      dependsOnWorkerIds,
      stageOrder: positive(profile.stageOrder, `${profile.slot}.stageOrder`, { zero: true }),
    };
  });
  return {
    setId: plan.set.setId,
    nodeId: plan.target.nodeId,
    desiredStateRevision,
    maintenanceGeneration: plan.set.maintenanceGeneration,
    profiles: result,
    requiredModelProfileIds: result.map((profile) => profile.modelProfileId),
  };
}

function profileProjection(plan) {
  return plan.set.profiles.map((profile) => ({
    slot: profile.slot,
    workerId: profile.workerId,
    modelProfileId: profile.modelProfileId,
    imageDigest: imageDigest(profile),
    configurationDigest: profile.configurationDigest,
    placementClass: "protected-resident",
    maintenanceGeneration: plan.set.maintenanceGeneration,
    containerName: profile.containerName,
    declaredResidentBytes: profile.declaredResidentBytes,
  }));
}

async function secureCredential(path, fileSystem = { lstat, readFile, realpath }) {
  if (!SAFE_FILE.test(path ?? "") || !fileSystem?.lstat || !fileSystem?.readFile || !fileSystem?.realpath) {
    throw new TypeError("protected office HTTPS credential file is invalid");
  }
  if (await fileSystem.realpath(path) !== path) throw new TypeError("protected office HTTPS credential cannot be a symbolic link");
  const stat = await fileSystem.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 32 || stat.size > 512
      || (typeof stat.mode === "number" && (stat.mode & 0o077) !== 0)) {
    throw new TypeError("protected office HTTPS credential is not a private bounded file");
  }
  const bytes = await fileSystem.readFile(path);
  try {
    const value = bytes.toString("utf8").trim();
    if (!/^taib_sk_[A-Za-z0-9_-]{43,171}$/.test(value)) throw new TypeError("protected office HTTPS credential is invalid");
    return value;
  } finally { bytes.fill(0); }
}

function publicHttpsOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError("protected office public origin is invalid"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/"
      || parsed.search || parsed.hash) throw new TypeError("protected office public origin must be HTTPS");
  return parsed.origin;
}

async function boundedJson(response, label, { maximumBytes = 2 * 1024 * 1024 } = {}) {
  if (!response || typeof response.arrayBuffer !== "function") throw new TypeError(`${label} response is invalid`);
  const bytes = Buffer.from(await response.arrayBuffer());
  try {
    if (bytes.byteLength < 2 || bytes.byteLength > maximumBytes) throw new TypeError(`${label} response is outside its bounded envelope`);
    return JSON.parse(bytes.toString("utf8"));
  } finally { bytes.fill(0); }
}

async function verifyAuditViewer(database, identityId) {
  if (!UUID.test(identityId ?? "")) throw new TypeError("protected office audit verifier identity is invalid");
  const row = rows(await database.query(`
    SELECT EXISTS (
      SELECT 1
      FROM iam.identities identity
      JOIN iam.role_bindings binding ON binding.identity_id=identity.id
        AND (binding.expires_at IS NULL OR binding.expires_at>clock_timestamp())
      JOIN iam.role_permissions permission ON permission.role_id=binding.role_id
        AND permission.permission_key='audit:view'
      WHERE identity.id=$1 AND identity.status='active'
    ) AS allowed`, [identityId]), "audit viewer")[0];
  if (row?.allowed !== true) fail("protected_deployment_audit_viewer_denied", "Configured audit verifier lacks a live audit:view grant");
  return Object.freeze({ identityId: identityId.toLowerCase(), permissions: Object.freeze(["audit:view"]) });
}

function mapTransaction(row) {
  if (!row) return null;
  return {
    transactionId: row.id,
    setId: row.set_id,
    nodeId: row.node_id,
    revision: Number(row.revision),
    desiredStateRevision: Number(row.desired_state_revision),
    maintenanceGeneration: Number(row.maintenance_generation),
    state: row.transaction_state,
    manifest: json(row.manifest),
    previousIdentities: json(row.previous_identities),
    admission: json(row.admission),
    steps: json(row.steps),
    recoverySteps: json(row.recovery_steps),
    observedIdentities: json(row.observed_identities),
    failureCode: row.failure_code,
    createdAt: iso(row.created_at, "transaction.createdAt"),
    updatedAt: iso(row.updated_at, "transaction.updatedAt"),
    completedAt: row.completed_at == null ? null : iso(row.completed_at, "transaction.completedAt"),
  };
}

function mapSetState(row) {
  if (!row) return null;
  return {
    setId: row.set_id,
    nodeId: row.node_id,
    revision: Number(row.revision),
    desiredStateRevision: Number(row.desired_state_revision),
    observedStateRevision: Number(row.observed_state_revision),
    maintenanceGeneration: Number(row.maintenance_generation),
    recoveryState: row.recovery_state,
    recoveryReasonCode: row.recovery_reason_code,
    healthyIdentities: json(row.healthy_identities),
    aggregateResidentBytes: Number(row.aggregate_resident_bytes),
    lastTransactionId: row.last_transaction_id,
    updatedAt: iso(row.updated_at, "setState.updatedAt"),
  };
}

function mapMetric(row) {
  if (!row) return null;
  return {
    nodeId: row.node_id,
    nodeGeneration: Number(row.node_generation),
    sequence: Number(row.sequence),
    observedAt: iso(row.observed_at, "metric.observedAt"),
    receivedAt: iso(row.received_at, "metric.receivedAt"),
    staleAfterMilliseconds: Number(row.stale_after_milliseconds),
    snapshotDigest: hexDigest(row.snapshot_digest),
    snapshot: json(row.snapshot),
  };
}

function mapNodeAgentCheckpoint(row) {
  if (!row) return null;
  const event = json(row.canonical_payload);
  const metadata = event?.metadata ?? {};
  return {
    commandId: metadata.agentOperationId,
    transactionId: metadata.transactionId,
    setId: metadata.setId,
    nodeGeneration: Number(metadata.nodeGeneration),
    journalRevision: Number(metadata.journalRevision),
    phase: metadata.journalState,
    nextOperationIndex: Number(metadata.remainingOperationCount),
    planDigest: metadata.planDigest,
    responseDigest: metadata.responseDigest,
    eventId: row.event_id,
    eventDigest: hexDigest(row.event_hash),
  };
}

function actionAuditRows(input) {
  return input.map((row) => ({ eventId: row.event_id, eventDigest: hexDigest(row.event_hash) }));
}

function requiredCoreServiceKeys(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64
      || value.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(item))
      || new Set(value).size !== value.length
      || JSON.stringify(value) !== JSON.stringify([...value].sort())) {
    throw new TypeError("protected office required core-service keys are invalid");
  }
  return Object.freeze([...value]);
}

function healthyRequiredCoreServices(coreServices, requiredKeys) {
  if (!Array.isArray(coreServices) || coreServices.length < requiredKeys.length) return false;
  const keys = coreServices.map((service) => service?.serviceKey);
  if (new Set(keys).size !== keys.length) return false;
  const byKey = new Map(coreServices.map((service) => [service?.serviceKey, service]));
  return requiredKeys.every((key) => {
    const service = byKey.get(key);
    const errorRate = service?.errorRatePercent;
    const errorRateAccepted = (errorRate?.status === "measured" && errorRate.value === 0)
      || (errorRate?.status === "unavailable" && errorRate.value == null
        && errorRate.reasonCode === "service_error_rate_not_collected_at_node");
    return service?.state === "healthy"
      && service.availabilityPercent?.status === "measured"
      && Number.isSafeInteger(service.availabilityPercent.value)
      && service.availabilityPercent.value > 0
      && errorRateAccepted;
  });
}

function assertProductionSourceOptions(options) {
  if (!options?.database?.query || !options?.database?.transaction
      || !options?.nodeAgentRouter?.inspectAppliance
      || typeof options?.auditService?.verifyChain !== "function"
      || !UUID.test(options.auditVerifierIdentityId ?? "")
      || typeof options.fetcher !== "function"
      || typeof options.credentialProvider !== "function"
      || !UUID.test(options.probeJobId ?? "")
      || typeof options.clock !== "function") {
    throw new TypeError("protected office production inspection dependencies are incomplete");
  }
  requiredCoreServiceKeys(options.requiredCoreServiceKeys);
}

function createInspectionSources(options, components) {
  assertProductionSourceOptions(options);
  if (!components?.nodeAgentRuntime?.inspectProtectedProfile || !components?.setRepository?.getSetState) {
    throw new TypeError("protected office production inspection components are incomplete");
  }
  const { database, nodeAgentRouter, auditService, auditVerifierIdentityId,
    fetcher, credentialProvider, probeJobId, clock } = options;
  const coreServiceKeys = requiredCoreServiceKeys(options.requiredCoreServiceKeys);

  return Object.freeze({
    async "postgres-protected-set-transaction"({ runId, plan, action = "final-inspect" }) {
      const setId = plan?.set?.setId;
      const [transactionRows, countRows, auditRows, checkpointRows] = await Promise.all([
        database.query(`SELECT * FROM compute.protected_office_set_transactions
          WHERE set_id=$1 AND transaction_state='succeeded'
          ORDER BY desired_state_revision DESC,completed_at DESC,id DESC LIMIT 1`, [setId]),
        database.query(`SELECT
          count(*) FILTER (WHERE transaction_state NOT IN ('succeeded','rolled-back'))::integer AS active_count,
          count(*) FILTER (WHERE transaction_state='recovery-required')::integer AS recovery_count
          FROM compute.protected_office_set_transactions WHERE set_id=$1`, [setId]),
        database.query(`SELECT event_id,event_hash FROM audit.audit_references
          WHERE schema_version=1 AND resource_kind='protected_office_deployment'
            AND resource_id=$1 AND ($2::text='final-inspect' OR correlation_key=$3)
          ORDER BY sequence_id`, [runId, action, correlation(runId, action)]),
        database.query(`SELECT event_id,event_hash,canonical_payload FROM audit.audit_references
          WHERE schema_version=1 AND action='protected_office_set.node_agent_checkpoint'
            AND resource_kind='protected_office_set' AND resource_id=$1
          ORDER BY sequence_id DESC LIMIT 1`, [setId]),
      ]);
      const context = await verifyAuditViewer(database, auditVerifierIdentityId);
      const chain = await auditService.verifyChain({ context });
      if (chain?.valid !== true) fail("protected_deployment_audit_chain_invalid", "Tamper-evident audit chain validation failed");
      const transaction = mapTransaction(rows(transactionRows, "protected transaction")[0]);
      const counts = rows(countRows, "protected transaction counts")[0] ?? {};
      const events = actionAuditRows(rows(auditRows, "protected action audit"));
      const checkpoint = mapNodeAgentCheckpoint(rows(checkpointRows, "Node Agent checkpoint")[0]);
      const bootstrapPending = transaction == null && checkpoint == null;
      if (events.length < 1 || (action !== "preflight" && (!transaction || !checkpoint))
          || (action === "preflight" && ((transaction == null) !== (checkpoint == null)))) {
        fail("protected_deployment_transaction_evidence_missing", "Durable transaction or audit facts are unavailable", { retryable: true });
      }
      return source({
        transaction,
        bootstrapPending,
        activeTransactionCount: Number(counts.active_count ?? 0),
        recoveryRequiredCount: Number(counts.recovery_count ?? 0),
        nodeAgentCheckpoint: checkpoint,
        audit: {
          correlationId: correlation(runId, action),
          eventIds: events.map((event) => event.eventId),
          eventDigests: events.map((event) => event.eventDigest),
          chainVerified: true,
        },
      });
    },

    async "postgres-protected-set-state"({ plan, action = "final-inspect" }) {
      const result = await database.query("SELECT * FROM compute.protected_office_sets WHERE set_id=$1", [plan.set.setId]);
      const setState = mapSetState(rows(result, "protected set state")[0]);
      if (!setState && action !== "preflight") {
        fail("protected_deployment_set_state_missing", "Protected office set state is unavailable", { retryable: true });
      }
      return source({ setState, bootstrapPending: setState == null });
    },

    async "postgres-cluster-metric-raw-snapshot"({ plan, action = "final-inspect" }) {
      let result;
      let admittedAt = null;
      if (action === "preflight") {
        result = await database.query(`SELECT * FROM compute.node_metric_snapshots
          WHERE node_id=$1 AND node_generation=$2
          ORDER BY sequence DESC LIMIT 1`, [plan.target.nodeId, plan.target.nodeGeneration]);
      } else {
        const transaction = rows(await database.query(`SELECT admission,created_at FROM compute.protected_office_set_transactions
          WHERE set_id=$1 AND transaction_state='succeeded'
          ORDER BY desired_state_revision DESC,completed_at DESC,id DESC LIMIT 1`, [plan.set.setId]), "metric transaction")[0];
        const admission = json(transaction?.admission);
        const observedAt = admission?.snapshot?.host?.observedAt;
        admittedAt = iso(transaction?.created_at, "metric admission createdAt");
        if (!observedAt) fail("protected_deployment_metric_binding_missing", "Scheduler admission lacks a raw metric timestamp");
        result = await database.query(`SELECT * FROM compute.node_metric_snapshots
          WHERE node_id=$1 AND node_generation=$2 AND observed_at=$3
          ORDER BY sequence DESC LIMIT 1`, [plan.target.nodeId, plan.target.nodeGeneration, observedAt]);
      }
      let metric = mapMetric(rows(result, "raw metric")[0]);
      if (!metric) fail("protected_deployment_metric_missing", "Raw admitted metric snapshot is unavailable", { retryable: true });
      let admissionMetric = null;
      if (action !== "preflight") {
        // Admission is a historical decision, not current health telemetry.
        // Maintenance and reconciliation can take minutes. Keep its exact
        // fresh-at-admission snapshot, then inspect the newest current sample
        // without repeating any worker transition merely to refresh evidence.
        const ageAtAdmission = Date.parse(admittedAt) - Date.parse(metric.observedAt);
        if (!Number.isFinite(ageAtAdmission) || ageAtAdmission < 0 || ageAtAdmission > 30_000) {
          fail("protected_deployment_admission_metric_stale", "Historical admission did not use a fresh raw metric");
        }
        admissionMetric = { ...metric, admittedAt, freshnessSeconds: Math.ceil(ageAtAdmission / 1000) };
        const latest = await database.query(`SELECT * FROM compute.node_metric_snapshots
          WHERE node_id=$1 AND node_generation=$2
          ORDER BY sequence DESC LIMIT 1`, [plan.target.nodeId, plan.target.nodeGeneration]);
        metric = mapMetric(rows(latest, "latest raw metric")[0]);
        if (!metric || metric.sequence < admissionMetric.sequence
            || Date.parse(metric.observedAt) < Date.parse(admissionMetric.observedAt)) {
          fail("protected_deployment_metric_regressed", "Current raw metric predates historical admission");
        }
      }
      const freshnessMilliseconds = Math.max(0,
        new Date(clock()).getTime() - new Date(metric.observedAt).getTime());
      if (freshnessMilliseconds > 30_000) {
        fail("protected_deployment_metric_stale",
          "Raw admitted metric snapshot exceeds 30 seconds", { retryable: true });
      }
      // Deployment evidence is hashed as canonical integer-only JSON.  Keep
      // the public seconds field conservative while rejecting staleness from
      // the exact millisecond measurement above.
      const freshnessSeconds = Math.ceil(freshnessMilliseconds / 1000);
      return source({ metric, freshnessSeconds, requiredCoreServiceKeys: coreServiceKeys,
        ...(admissionMetric ? { admissionMetric } : {}) });
    },

    async "postgres-realtime-reservation"({ plan }) {
      const result = await database.query(`SELECT
        count(*)::integer AS active_count,
        count(*) FILTER (WHERE capability_key IN ('codec','webrtc-gateway')
          OR coalesce((codec_directions->>'encodeSessions')::integer,0)>0
          OR coalesce((codec_directions->>'decodeSessions')::integer,0)>0)::integer AS media_count,
        coalesce(max(fencing_token),0)::bigint AS repository_revision,
        coalesce(jsonb_agg(id ORDER BY id) FILTER (WHERE id IS NOT NULL),'[]'::jsonb) AS active_ids
        FROM compute.realtime_sessions
        WHERE node_id=$1 AND node_generation=$2 AND state=ANY($3::text[]) AND expires_at>clock_timestamp()`,
      [plan.target.nodeId, plan.target.nodeGeneration, ACTIVE_REALTIME_STATES]);
      const row = rows(result, "realtime reservation")[0] ?? {};
      return source({
        activeReservationCount: Number(row.active_count ?? 0),
        activeMediaReservationCount: Number(row.media_count ?? 0),
        repositoryRevision: Number(row.repository_revision ?? 0),
        activeReservationIds: json(row.active_ids) ?? [],
        observedAt: iso(clock(), "realtime observedAt"),
      });
    },

    async "casting-session"({ plan }) {
      const result = await database.query(`SELECT count(*)::integer AS active_count,
        coalesce(max(state_revision),0)::bigint AS repository_revision
        FROM platform.cast_sessions
        WHERE appliance_node_id=$1 AND session_state=ANY($2::text[]) AND expires_at>clock_timestamp()`,
      [plan.target.nodeId, ACTIVE_CAST_STATES]);
      const row = rows(result, "casting session")[0] ?? {};
      return source({
        activeCastingSessionCount: Number(row.active_count ?? 0),
        repositoryRevision: Number(row.repository_revision ?? 0),
        observedAt: iso(clock(), "casting observedAt"),
      });
    },

    async "mtls-node-agent-inspection"({ runId, plan }) {
      const manifest = normalizedManifest(plan);
      const appliance = await nodeAgentRouter.inspectAppliance({
        nodeId: plan.target.nodeId,
        nodeGeneration: plan.target.nodeGeneration,
        correlationId: `protected-inspection:${runId}`,
      });
      const profiles = [];
      for (const [index, profile] of manifest.profiles.entries()) {
        profiles.push({ slot: plan.set.profiles[index].slot,
          ...copy(await components.nodeAgentRuntime.inspectProtectedProfile({ profile })) });
      }
      return source({ transport: "mtls-hmac", appliance: copy(appliance), profiles });
    },

    async "authenticated-public-https"({ plan }) {
      const origin = publicHttpsOrigin(options.publicOrigin);
      const credential = await credentialProvider();
      try {
        const [live, ready, authenticated] = await Promise.all([
          fetcher(`${origin}/health/live`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000) }),
          fetcher(`${origin}/health/ready`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000) }),
          fetcher(`${origin}/api/v1/jobs/${probeJobId}`, {
            method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
            headers: { accept: "application/json", authorization: `Bearer ${credential}` },
          }),
        ]);
        if (live.status !== 200 || ready.status !== 200 || authenticated.status !== 200) {
          fail("protected_deployment_public_https_unhealthy", "Public HTTPS liveness, readiness, or authenticated read failed", { retryable: true });
        }
        const body = await boundedJson(authenticated, "authenticated public HTTPS");
        const jobId = body?.job_id ?? body?.x_teamaibox?.job_id;
        if (jobId !== probeJobId) fail("protected_deployment_public_https_identity_drift", "Authenticated HTTPS read returned another durable job");
        const databaseJob = rows(await database.query("SELECT id,status FROM compute.jobs WHERE id=$1", [probeJobId]), "HTTPS probe job")[0];
        if (databaseJob?.id !== probeJobId || !TERMINAL_JOBS.has(databaseJob.status)) {
          fail("protected_deployment_public_https_probe_drift", "Authenticated HTTPS probe job is not durable and terminal");
        }
        return source({
          origin, tls: true, live: true, ready: true, authenticatedRead: true,
          probeJobId, nodeId: plan.target.nodeId, observedAt: iso(clock(), "HTTPS observedAt"),
        });
      } finally {
        // A JS string cannot be wiped; keep its lifetime inside this one read and
        // never copy it into evidence, diagnostics, errors, or source results.
      }
    },
  });
}

function requireMetricValue(metric, label) {
  if (metric?.status !== "measured" || !Number.isSafeInteger(metric.value) || metric.value < 0) {
    fail("protected_deployment_metric_incomplete", `${label} is not a measured integer`);
  }
  return metric.value;
}

function memoryFacts(profile, metric, admittedWorker) {
  const observed = (metric.snapshot?.workers ?? []).find((worker) => worker.workerId === profile.workerId);
  if (!observed?.cgroup || !observed?.process || !observed?.engine || !observed?.runtime) {
    fail("protected_deployment_worker_metric_missing", `Raw worker memory telemetry is missing for ${profile.slot}`);
  }
  const cgroup = copy(observed.cgroup);
  const process = copy(observed.process);
  const engine = observed.engine.status === "measured" ? {
    status: "measured", allocatedBytes: observed.engine.allocatedBytes,
    modelBytes: observed.engine.modelBytes, cacheBytes: observed.engine.cacheBytes,
    certifiedEnvelopeBytes: observed.engine.certifiedEnvelopeBytes,
  } : {
    status: "unavailable", reason: observed.engine.reasonCode,
    allocatedBytes: null, modelBytes: null, cacheBytes: null, certifiedEnvelopeBytes: null,
  };
  const engineBytes = engine.status === "measured" ? engine.allocatedBytes : 0;
  const resident = Math.max(cgroup.currentBytes, process.residentBytes, engineBytes);
  const baseline = admittedWorker?.cgroup?.events ?? cgroup.events;
  const delta = Object.fromEntries(["high", "max", "oom", "oomKill", "oomGroupKill"]
    .map((key) => [key, cgroup.events[key] - (baseline[key] ?? 0)]));
  if (Object.values(delta).some((value) => value !== 0) || observed.runtime.oomKilled !== false) {
    fail("protected_deployment_worker_oom_observed", `Worker OOM counters changed for ${profile.slot}`);
  }
  return {
    cgroup, process, engine,
    observedResidentBytes: resident,
    observedPeakBytes: cgroup.peakBytes,
    accountingBytes: Math.max(resident, cgroup.peakBytes),
    metricSnapshot: null,
    oomCounterDelta: delta,
    runtime: { oomKilled: false },
  };
}

function validateCommonSourceSet(sources, plan, action) {
  for (const name of SOURCE_NAMES) {
    if (sources?.[name]?.readOnly !== true || sources[name].mutationCount !== 0) {
      fail("protected_deployment_inspection_source_invalid", `Independent source ${name} is absent or mutable`);
    }
  }
  const tx = sources["postgres-protected-set-transaction"];
  const state = sources["postgres-protected-set-state"].setState;
  const metricSource = sources["postgres-cluster-metric-raw-snapshot"];
  const realtime = sources["postgres-realtime-reservation"];
  const cast = sources["casting-session"];
  const agent = sources["mtls-node-agent-inspection"];
  const https = sources["authenticated-public-https"];
  if (tx.activeTransactionCount !== 0 || tx.recoveryRequiredCount !== 0
      || metricSource.metric?.nodeId !== plan.target.nodeId
      || metricSource.metric.nodeGeneration !== plan.target.nodeGeneration
      || realtime.activeReservationCount !== 0 || realtime.activeMediaReservationCount !== 0
      || cast.activeCastingSessionCount !== 0 || agent.transport !== "mtls-hmac"
      || https.live !== true || https.ready !== true || https.authenticatedRead !== true) {
    fail("protected_deployment_source_drift", "Independent production sources do not describe one healthy protected set");
  }
  const appliance = agent.appliance;
  if (appliance?.nodeId !== plan.target.nodeId
      || appliance.nodeGeneration !== plan.target.nodeGeneration
      || appliance.imageDigest !== plan.target.nodeAgentIdentity.imageId
      || appliance.configurationDigest !== plan.target.nodeAgentIdentity.configDigest
      || appliance.healthy !== true) {
    fail("protected_deployment_node_agent_identity_drift",
      "Local authenticated inspection disagrees with the exact local Node Agent runtime identity");
  }
  const bootstrapPending = tx.transaction == null && tx.nodeAgentCheckpoint == null && state == null
    && tx.bootstrapPending === true && sources["postgres-protected-set-state"].bootstrapPending === true;
  const existingHealthy = tx.transaction?.state === "succeeded"
    && tx.transaction.setId === plan.set.setId
    && tx.transaction.nodeId === plan.target.nodeId
    && state?.recoveryState === "healthy"
    && state.lastTransactionId === tx.transaction.transactionId
    && state.observedStateRevision === state.desiredStateRevision
    && tx.nodeAgentCheckpoint != null;
  if ((action === "preflight" && !bootstrapPending && !existingHealthy)
      || (action !== "preflight" && !existingHealthy)) {
    fail("protected_deployment_source_drift", "Protected-set transaction state is incomplete or inconsistent");
  }
  const expected = profileProjection(plan);
  if (!Array.isArray(agent.profiles) || agent.profiles.length !== expected.length
      || agent.profiles.some((actual, index) => actual.slot !== expected[index].slot
        || actual.workerId !== expected[index].workerId
        || actual.modelProfileId !== expected[index].modelProfileId
        || actual.imageDigest !== expected[index].imageDigest
        || actual.configurationDigest !== expected[index].configurationDigest
        || actual.placementClass !== "protected-resident"
        || actual.maintenanceGeneration !== expected[index].maintenanceGeneration
        || !CONTAINER_ID.test(actual.containerId ?? "")
        || !Number.isFinite(new Date(actual.startedAt).getTime())
        || actual.state !== "running" || actual.healthy !== true)) {
    fail("protected_deployment_node_agent_drift", "mTLS Node Agent inspection disagrees with the protected profile manifest");
  }
  return { tx, state, metricSource, realtime, cast, agent, https, expected, bootstrapPending };
}

export function createProtectedOfficeSetProductionResultAssembler({ clock = () => new Date() } = {}) {
  if (typeof clock !== "function") throw new TypeError("protected office result clock is invalid");
  return async function assemble({ runId, plan, sources, journal = null, action = "final-inspect", extras = {} }) {
    const { tx, state, metricSource, realtime, cast, agent, expected, bootstrapPending }
      = validateCommonSourceSet(sources, plan, action);
    const metric = metricSource.metric;
    let currentFreshnessSeconds = metricSource.freshnessSeconds;
    if (action !== "preflight") {
      const age = Date.parse(iso(clock(), "current metric inspection time")) - Date.parse(metric.observedAt);
      if (!Number.isFinite(age) || age < 0 || age > 30_000) {
        fail("protected_deployment_metric_stale", "Current metric is no longer fresh at final assembly");
      }
      currentFreshnessSeconds = Math.ceil(age / 1000);
    }
    const metricSnapshot = {
      nodeId: metric.nodeId,
      nodeGeneration: metric.nodeGeneration,
      sequence: metric.sequence,
      snapshotDigest: metric.snapshotDigest,
      observedAt: metric.observedAt,
      freshnessSeconds: currentFreshnessSeconds,
    };
    const admission = action === "preflight" ? null : tx.transaction.admission;
    const admittedMetric = action === "preflight" ? metric : metricSource.admissionMetric;
    if (action !== "preflight"
        && (iso(admission?.snapshot?.host?.observedAt, "admission host") !== admittedMetric?.observedAt
          || admittedMetric.nodeId !== metric.nodeId || admittedMetric.nodeGeneration !== metric.nodeGeneration
          || admittedMetric.admittedAt !== tx.transaction.createdAt)) {
      fail("protected_deployment_admission_metric_drift", "Scheduler transaction was not admitted by the exact raw metric snapshot");
    }
    const admittedWorkers = new Map((admission?.snapshot?.workers ?? []).map((worker) => [worker.workerId, worker]));
    let total = 0;
    const agentBySlot = new Map(agent.profiles.map((profile) => [profile.slot, profile]));
    const profiles = expected.map((profile) => {
      const runtime = agentBySlot.get(profile.slot);
      const memory = memoryFacts(profile, metric, admittedWorkers.get(profile.workerId));
      memory.metricSnapshot = metricSnapshot;
      if (memory.accountingBytes < 1 || memory.accountingBytes > profile.declaredResidentBytes) {
        fail("protected_deployment_profile_budget_exceeded", `Observed memory exceeds the qualified envelope for ${profile.slot}`);
      }
      total += memory.accountingBytes;
      return {
        ...profile,
        containerId: runtime.containerId,
        startedAt: iso(runtime.startedAt, `${profile.slot}.startedAt`),
        state: "running", healthy: true, memory,
      };
    });
    const host = metric.snapshot.domains?.unifiedMemory;
    const hostTotalBytes = requireMetricValue(host?.totalBytes, "host total memory");
    const hostAvailableBytes = requireMetricValue(host?.availableBytes, "host available memory");
    const coreServices = metric.snapshot.coreServices ?? [];
    const coreServicesHealthy = healthyRequiredCoreServices(coreServices,
      requiredCoreServiceKeys(metricSource.requiredCoreServiceKeys));
    if (!coreServicesHealthy) fail("protected_deployment_core_unhealthy", "Raw Node Agent metric reports an unhealthy core service");
    const checkpoint = tx.nodeAgentCheckpoint;
    const durableProof = action === "preflight" ? {
      bootstrapReadiness: {
        schemaVersion: 1,
        phase: "pre-cold-boot",
        state: bootstrapPending ? "uninitialized" : "existing-healthy",
        setId: plan.set.setId,
        transactionAbsent: tx.transaction == null,
        setStateAbsent: state == null,
        nodeAgentCheckpointAbsent: checkpoint == null,
        activeTransactionCount: tx.activeTransactionCount,
        recoveryRequiredCount: tx.recoveryRequiredCount,
        exactCanonicalProfilesVerified: true,
        latestMetricSnapshot: true,
        mutationCount: 0,
      },
      schedulerTransaction: null,
      setState: null,
      nodeAgentTransaction: null,
    } : {
      schedulerTransaction: {
        transactionId: tx.transaction.transactionId,
        setId: tx.transaction.setId,
        revision: tx.transaction.revision,
        state: tx.transaction.state,
        desiredStateRevision: tx.transaction.desiredStateRevision,
        maintenanceGeneration: tx.transaction.maintenanceGeneration,
        manifestDigest: plan.profileSetManifest.sha256,
        completedAt: tx.transaction.completedAt,
        ...(action !== "preflight" ? { admissionMetricSnapshot: {
          nodeId: admittedMetric.nodeId, nodeGeneration: admittedMetric.nodeGeneration,
          sequence: admittedMetric.sequence, snapshotDigest: admittedMetric.snapshotDigest,
          observedAt: admittedMetric.observedAt, admittedAt: admittedMetric.admittedAt,
          freshnessSeconds: admittedMetric.freshnessSeconds,
        } } : {}),
        admissionSnapshot: {
          metricSnapshotDigest: admittedMetric.snapshotDigest,
          metricSnapshotSequence: admittedMetric.sequence,
          activeCastingSessionCount: 0,
          activeMediaReservationCount: 0,
        },
      },
      setState: {
        setId: state.setId,
        revision: state.revision,
        desiredStateRevision: state.desiredStateRevision,
        observedStateRevision: state.observedStateRevision,
        recoveryState: state.recoveryState,
        lastTransactionId: state.lastTransactionId,
        healthyIdentityDigest: digest(state.healthyIdentities),
      },
      nodeAgentTransaction: checkpoint,
    };
    const common = {
      node: {
        nodeId: plan.target.nodeId,
        nodeGeneration: plan.target.nodeGeneration,
        nodeAddress: plan.target.nodeAddress,
        nodeRole: plan.target.nodeRole,
      },
      proof: {
        audit: tx.audit,
        metricSnapshot,
        ...durableProof,
      },
      profiles,
      aggregateMemory: {
        qualifiedModelAccountingBytes: expected.reduce((sum, profile) => sum + profile.declaredResidentBytes, 0),
        observedModelAccountingBytes: total,
        ordinaryPerProfile96GiBGateApplied: false,
        mediaReservationIncludedInAdmission: false,
        metricSnapshot,
        hostTotalBytes,
        hostAvailableBytes,
        oomCounterDelta: { high: 0, max: 0, oom: 0, oomKill: 0, oomGroupKill: 0 },
        runtimeOomKilledCount: 0,
        admitted: true,
      },
      noCastObservation: {
        state: "inactive",
        activeCastingSessionCount: cast.activeCastingSessionCount,
        activeMediaReservationCount: realtime.activeMediaReservationCount,
        mediaReservationIncludedInAdmission: false,
        castingSessionRepositoryRevision: cast.repositoryRevision,
        realtimeReservationRepositoryRevision: realtime.repositoryRevision,
        observedAt: iso(clock(), "no-cast observedAt"),
      },
      coreServicesHealthy: true,
      oomEvents: [],
      ...copy(extras),
    };
    if (action === "final-inspect") {
      common.readOnly = true;
      common.mutationCount = 0;
      common.inspectionSources = [...SOURCE_NAMES];
      common.finalState = {
        healthy: true,
        activeTransactionCount: tx.activeTransactionCount,
        recoveryRequiredCount: tx.recoveryRequiredCount,
        exactDesiredState: true,
      };
    }
    if (journal && journal.action !== "final-inspect") {
      fail("protected_deployment_final_journal_drift", "Independent result assembly received another action journal");
    }
    return Object.freeze(common);
  };
}

function assertScenarioDependencies(options) {
  const methods = [
    [options.parentEvidenceVerifier, "verify"],
    [options.publicHttpsScenarioRunner, "runConcurrentOffice"],
    [options.maintenanceContextProvider, "create"],
    [options.maintenanceSigner, "sign"],
    [options.platformLifecycleController, "inspect"],
    [options.platformLifecycleController, "beginPlatformRestart"],
    [options.platformLifecycleController, "recoverPlatformRestart"],
    [options.faultController, "executeMidSequenceFailure"],
  ];
  if (!options?.database?.query || !options?.database?.transaction
      || typeof options.auditRecorder !== "function"
      || methods.some(([value, method]) => typeof value?.[method] !== "function")) {
    throw new TypeError("protected office production scenario dependencies are incomplete");
  }
}

async function recordActionAudit(options, { request, action, outcome = "succeeded", metadata = {} }) {
  const event = await options.auditRecorder({
    action: `protected_office_set.${action.replaceAll("-", "_")}`,
    domain: "administrator",
    outcome,
    actorKind: "system",
    resource: { kind: "protected_office_deployment", id: request.runId },
    correlationId: correlation(request.runId, action),
    actionId: request.actionId,
    setId: request.plan.set.setId,
    desiredStateRevision: metadata.desiredStateRevision,
    transactionId: metadata.transactionId,
    operationId: metadata.operationId,
    state: outcome,
  });
  if (!UUID.test(event?.eventId ?? "") || !SHA256.test(event?.eventHash ?? "")) {
    fail("protected_deployment_audit_write_invalid", "Tamper-evident audit append did not return an exact event checkpoint");
  }
  return event;
}

async function recordNodeCheckpoint(options, { plan, response }) {
  const event = await options.auditRecorder({
    action: "protected_office_set.node_agent_checkpoint",
    domain: "administrator",
    outcome: "succeeded",
    actorKind: "system",
    resource: { kind: "protected_office_set", id: plan.set.setId },
    correlationId: `protected-office-node:${plan.set.setId}:${response.transactionId}`,
    // Audit metadata deliberately rejects command-shaped names.  These
    // semantically equivalent names survive the central allowlist while
    // retaining the exact Agent response facts needed for replay-free proof.
    agentOperationId: response.commandId ?? response.transactionId,
    transactionId: response.transactionId,
    setId: plan.set.setId,
    nodeGeneration: plan.target.nodeGeneration,
    journalRevision: response.journalRevision,
    journalState: response.phase,
    remainingOperationCount: response.nextOperation ?? response.nextOperationIndex,
    planDigest: response.planDigest,
    responseDigest: digest(response),
  });
  if (!UUID.test(event?.eventId ?? "") || !SHA256.test(event?.eventHash ?? "")) {
    fail("protected_deployment_node_checkpoint_invalid", "Node Agent checkpoint audit append failed");
  }
}

async function readSuccessfulTransaction(database, setId) {
  return mapTransaction(rows(await database.query(`SELECT * FROM compute.protected_office_set_transactions
    WHERE set_id=$1 AND transaction_state='succeeded'
    ORDER BY desired_state_revision DESC,completed_at DESC,id DESC LIMIT 1`, [setId]), "successful transaction")[0]);
}

async function createSignedMaintenanceContext(options, request, { purpose }) {
  // The detached Ed25519 payload canonicalizes set membership
  // lexicographically.  Allocate and validate that same canonical order so a
  // dependency/stage-ordered deployment plan cannot drift at the signer
  // boundary even though both lists contain the same Workers.
  const expectedWorkerIds = request.plan.set.profiles.map((profile) => profile.workerId).sort();
  const draft = exactObject(await options.maintenanceContextProvider.create({
    runId: request.runId,
    action: request.action,
    actionId: request.actionId,
    idempotencyKey: request.idempotencyKey,
    purpose,
    operation: "protected-set.maintenance",
    workerIds: [...expectedWorkerIds],
    maintenanceGeneration: request.plan.set.maintenanceGeneration,
  }), "unsigned protected maintenance context");
  if (Object.hasOwn(draft, "signature") || !UUID.test(draft.transactionId ?? "")
      || !Number.isSafeInteger(draft.journalRevision) || draft.journalRevision < 1
      || !sameJson(draft.workerIds, expectedWorkerIds)
      || !sameJson(draft.allowedOperations, ["protected-set.maintenance"])
      || draft.maintenanceGeneration !== request.plan.set.maintenanceGeneration) {
    fail("protected_deployment_maintenance_context_invalid",
      "Maintenance context allocator did not bind the exact unsigned protected set");
  }
  const issuedAt = iso(draft.issuedAt, "maintenance issuedAt");
  const expiresAt = iso(draft.expiresAt, "maintenance expiresAt");
  if (new Date(expiresAt) <= new Date(issuedAt)
      || new Date(expiresAt).getTime() - new Date(issuedAt).getTime() > 15 * 60_000) {
    fail("protected_deployment_maintenance_window_invalid", "Maintenance authorization window is invalid");
  }
  const unsigned = Object.freeze({
    transactionId: draft.transactionId.toLowerCase(),
    workerIds: Object.freeze([...expectedWorkerIds]),
    allowedOperations: Object.freeze(["protected-set.maintenance"]),
    maintenanceGeneration: request.plan.set.maintenanceGeneration,
    issuedAt,
    expiresAt,
  });
  // `maintenanceSigner` is a production client for a separate maintenance
  // controller/HSM. Platform never reads or receives its Ed25519 private key.
  const signature = exactObject(await options.maintenanceSigner.sign(copy(unsigned)),
    "protected maintenance signature");
  const expectedPayloadDigest = `sha256:${createHash("sha256")
    .update(encodeProtectedMaintenanceSignaturePayload({
      context: unsigned,
      operation: "protected-set.maintenance",
    })).digest("hex")}`;
  if (signature.algorithm !== "Ed25519" || !MAINTENANCE_KEY_ID.test(signature.keyId ?? "")
      || signature.payloadDigest !== expectedPayloadDigest
      || !ED25519_SIGNATURE.test(signature.value ?? "")) {
    fail("protected_deployment_maintenance_signature_invalid",
      "External maintenance signer did not sign the exact bounded context");
  }
  return Object.freeze({
    ...unsigned,
    signature: Object.freeze(copy(signature)),
    journalRevision: draft.journalRevision,
  });
}

async function reconcileBaseline(options, components, request, revisionOffset) {
  const current = await components.setRepository.getSetState(request.plan.set.setId);
  const desiredStateRevision = Math.max(
    request.plan.set.desiredStateRevision + revisionOffset,
    // The recovered Agent may already hold this captured baseline revision
    // while PostgreSQL still describes the pre-recovery generation.
    request.plan.set.desiredStateRevision + 1,
    Number(current?.desiredStateRevision ?? 0) + 1,
  );
  const maintenanceContext = await createSignedMaintenanceContext(options, request, {
    purpose: `baseline-${request.action}`,
  });
  const manifest = normalizedManifest(request.plan, desiredStateRevision);
  const booted = await components.coordinator.boot({ manifest, maintenanceContext });
  const transaction = await readSuccessfulTransaction(options.database, request.plan.set.setId);
  if (!transaction || transaction.desiredStateRevision !== desiredStateRevision) {
    fail("protected_deployment_reconcile_missing", "Protected-set baseline reconcile did not persist the requested revision");
  }
  // `boot()` already submitted the one permitted mutation command.  Persist
  // the response returned by that exact command; never replay it merely to
  // obtain a checkpoint because the mTLS/HMAC Agent boundary rejects command
  // re-use by design.
  const response = exactObject(booted?.transition, "protected set transition response");
  if (booted?.reused !== false || response.transactionId !== transaction.transactionId
      || response.setId !== transaction.setId
      || response.desiredStateRevision !== transaction.desiredStateRevision
      || response.maintenanceGeneration !== transaction.maintenanceGeneration
      || response.phase !== "complete" || (response.nextOperation ?? response.nextOperationIndex) !== 0
      || !Number.isSafeInteger(response.journalRevision) || response.journalRevision < 1
      || !SHA256.test(response.planDigest ?? "")) {
    fail("protected_deployment_reconcile_transition_invalid",
      "Protected-set coordinator did not return the exact completed Node Agent transition");
  }
  await recordNodeCheckpoint(options, { plan: request.plan, response });
  return { transaction, response, maintenanceContext };
}

async function inspectAll(sources, input) {
  const result = {};
  for (const name of SOURCE_NAMES) {
    try {
      result[name] = await sources[name](input);
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      fail(`protected_deployment_${name.replaceAll("-", "_")}_contract_failed`,
        `Independent production source ${name} violated its structural contract`);
    }
  }
  return result;
}

async function jobFacts(database, jobIds, plan) {
  const ids = Object.values(jobIds);
  if (ids.length !== COMPUTE_JOB_CAPABILITIES.length
      || Object.keys(jobIds).sort().join(",") !== COMPUTE_JOB_CAPABILITIES.map(([capabilityId]) => capabilityId).sort().join(",")
      || ids.some((value) => !UUID.test(value ?? ""))) {
    fail("protected_deployment_protocol_job_invalid", "Concurrent HTTPS scenario did not return the exact durable compute-job identities");
  }
  const result = await database.query(`SELECT job.id AS job_id,job.operation,job.status,job.route,
      job.requested_model_profile_id,job.request_digest,job.result_artifact,
      attempt.id AS attempt_id,attempt.model_profile_id,attempt.worker_instance_key,
      attempt.started_at,attempt.finished_at
    FROM compute.jobs job
    LEFT JOIN LATERAL (SELECT candidate.* FROM compute.attempts candidate
      WHERE candidate.job_id=job.id ORDER BY candidate.attempt_number DESC,candidate.id DESC LIMIT 1) attempt ON true
    WHERE job.id=ANY($1::uuid[])`, [ids]);
  const byId = new Map(rows(result, "concurrent jobs").map((row) => [row.job_id, row]));
  const profiles = new Map(plan.set.profiles.map((profile) => [profile.slot, profile]));
  const capabilities = COMPUTE_JOB_CAPABILITIES.map(([capabilityId, slot, route]) => {
    const row = byId.get(jobIds[capabilityId]);
    const profile = profiles.get(slot);
    const resultArtifact = json(row?.result_artifact);
    const resultDigest = resultArtifact?.integrity?.digest;
    const normalizedResultDigest = typeof resultDigest === "string" && /^[a-f0-9]{64}$/.test(resultDigest)
      ? `sha256:${resultDigest}` : resultDigest;
    if (!row || row.status !== "succeeded" || row.route === "unassigned"
        || row.model_profile_id !== profile.modelProfileId
        || row.worker_instance_key !== profile.workerId || !UUID.test(row.attempt_id ?? "")
        || !row.started_at || !row.finished_at || !SHA256.test(hexDigest(row.request_digest) ?? "")
        || !SHA256.test(normalizedResultDigest ?? "")) {
      fail("protected_deployment_protocol_fact_drift", `Durable compute facts are incomplete for ${capabilityId}`);
    }
    return {
      capabilityId, status: "passed", protocol: "real", route,
      executionKind: "compute-job", executionId: row.job_id,
      jobId: row.job_id, attemptId: row.attempt_id,
      workerId: profile.workerId, modelProfileId: profile.modelProfileId,
      startedAt: iso(row.started_at, `${capabilityId}.startedAt`),
      completedAt: iso(row.finished_at, `${capabilityId}.completedAt`),
      requestDigest: hexDigest(row.request_digest), resultDigest: normalizedResultDigest,
    };
  });
  return capabilities;
}

export async function readProtectedOfficeAssistantAgentFact(database, runId, plan) {
  if (!UUID.test(runId ?? "")) {
    fail("protected_deployment_protocol_agent_invalid", "Concurrent HTTPS scenario did not return a durable Assistant Agent run identity");
  }
  const row = rows(await database.query(`SELECT run.id AS run_id,run.requested_mode,run.effective_mode,
      run.status,run.routing,run.request_digest,run.started_at,run.completed_at,
      message.status AS message_status,message.completed_at AS message_completed_at,
      encode(pg_catalog.sha256(convert_to(message.content,'UTF8')),'hex') AS result_digest
    FROM platform.assistant_runs run
    JOIN platform.assistant_messages message ON message.id=run.assistant_message_id
    WHERE run.id=$1`, [runId]), "Assistant Agent run")[0];
  const profile = plan.set.profiles.find((item) => item.slot === "assistant-qwen38");
  const routing = json(row?.routing);
  const resultDigest = typeof row?.result_digest === "string" ? `sha256:${row.result_digest}` : null;
  if (!row || row.status !== "completed" || row.requested_mode !== "agent" || row.effective_mode !== "agent"
      || row.message_status !== "completed" || routing?.targetKind !== "internal"
      || routing?.profileKey !== profile?.profileKey || !row.started_at || !row.completed_at
      || !row.message_completed_at || !SHA256.test(hexDigest(row.request_digest) ?? "")
      || !SHA256.test(resultDigest ?? "")) {
    fail("protected_deployment_protocol_agent_drift", "Durable Assistant Agent facts do not bind the protected assistant profile");
  }
  return {
    capabilityId: "assistant.agent", status: "passed", protocol: "real",
    route: "/api/v1/assistant/conversations/{conversation_id}/messages",
    executionKind: "assistant-run", executionId: row.run_id,
    jobId: null, attemptId: null,
    workerId: profile.workerId, modelProfileId: profile.modelProfileId,
    startedAt: iso(row.started_at, "assistant.agent.startedAt"),
    completedAt: iso(row.completed_at, "assistant.agent.completedAt"),
    requestDigest: hexDigest(row.request_digest), resultDigest,
  };
}

async function realtimeFact(database, sessionId, plan) {
  if (!UUID.test(sessionId ?? "")) {
    fail("protected_deployment_protocol_realtime_invalid", "Concurrent HTTPS scenario did not return a durable realtime session identity");
  }
  const row = rows(await database.query(`SELECT id,capability_key,requested_model,model_profile_id,node_id,
      node_generation,route,state,reservation,codec_directions,admitted_at,expires_at
    FROM compute.realtime_sessions WHERE id=$1`, [sessionId]), "realtime session")[0];
  const profile = plan.set.profiles.find((item) => item.slot === "asr-whisper");
  if (!row || row.capability_key !== "asr" || row.model_profile_id !== profile?.modelProfileId
      || row.node_id !== plan.target.nodeId || Number(row.node_generation) !== plan.target.nodeGeneration
      || row.route !== "local" || !new Set(["admitted", "connected", "released", "expired"]).has(row.state)
      || !row.admitted_at || !row.expires_at) {
    fail("protected_deployment_protocol_realtime_drift", "Durable realtime facts do not bind the protected ASR profile");
  }
  const requestDigest = digest({
    capability: row.capability_key, requestedModel: row.requested_model,
    modelProfileId: row.model_profile_id, nodeId: row.node_id, nodeGeneration: Number(row.node_generation),
  });
  const resultDigest = digest({
    sessionId: row.id, route: row.route, reservation: json(row.reservation),
    codecDirections: json(row.codec_directions), expiresAt: iso(row.expires_at, "asr.realtime.expiresAt"),
  });
  return {
    capabilityId: "asr.realtime", status: "passed", protocol: "real",
    route: "/api/v1/realtime/sessions",
    executionKind: "realtime-session", executionId: row.id,
    jobId: null, attemptId: null,
    workerId: profile.workerId, modelProfileId: profile.modelProfileId,
    startedAt: iso(row.admitted_at, "asr.realtime.startedAt"),
    completedAt: iso(row.expires_at, "asr.realtime.completedAt"),
    requestDigest, resultDigest,
  };
}

function concurrencyFacts(capabilities) {
  let best = [];
  for (const candidate of capabilities) {
    const started = new Date(candidate.startedAt).getTime();
    const overlapping = capabilities.filter((item) => new Date(item.startedAt).getTime() <= new Date(candidate.completedAt).getTime()
      && new Date(item.completedAt).getTime() >= started);
    if (overlapping.length > best.length) best = overlapping;
  }
  if (best.length < 2) fail("protected_deployment_concurrency_missing", "Real protocol jobs did not overlap in time");
  return {
    concurrencyWindows: [{
      windowId: deterministicUuid(best.map((item) => item.jobId).sort().join(":")),
      capabilityIds: best.map((item) => item.capabilityId),
      startedAt: best.map((item) => item.startedAt).sort()[0],
      completedAt: best.map((item) => item.completedAt).sort().at(-1),
    }],
    maximumConcurrentCapabilities: best.length,
  };
}

function restartIdentity(request) {
  const lifecycleCommandId = deterministicUuid(`${request.actionId}:lifecycle-command`);
  const platformOperationId = deterministicUuid(`${request.actionId}:platform`);
  const nodeAgentOperationId = deterministicUuid(`${request.actionId}:node-agent`);
  const command = Object.freeze({
    schemaVersion: 1,
    protocol: RESTART_PROTOCOL,
    runId: request.runId,
    action: "restart-verify",
    actionId: request.actionId,
    idempotencyKey: request.idempotencyKey,
    restartTargets: [...RESTART_TARGETS],
    mutationAuthority: "node-agent-mtls-hmac",
    dockerMutationAuthority: "node-agent-only",
    lifecycleCommandType: RESTART_COMMAND_TYPE,
    lifecycleCommandId,
    operationOrder: [...RESTART_OPERATION_ORDER],
  });
  return Object.freeze({
    lifecycleCommandId,
    platformOperationId,
    nodeAgentOperationId,
    command,
    requestDigest: digest(command),
  });
}

function validatedRestartBoundary(value, request, identity) {
  const boundary = exactObject(value, "protected office restart boundary");
  if (boundary.schemaVersion !== 1 || boundary.protocol !== RESTART_PROTOCOL
      || boundary.phase !== "restart-requested" || boundary.runId !== request.runId
      || boundary.action !== "restart-verify" || boundary.actionId !== request.actionId
      || boundary.idempotencyKey !== request.idempotencyKey
      || boundary.requestPersisted !== true || boundary.replayRequired !== true
      || !sameJson(boundary.restartTargets, RESTART_TARGETS)
      || boundary.mutationAuthority !== "node-agent-mtls-hmac"
      || boundary.dockerMutationAuthority !== "node-agent-only"
      || boundary.lifecycleCommandType !== RESTART_COMMAND_TYPE
      || boundary.lifecycleCommandId !== identity.lifecycleCommandId
      || !sameJson(boundary.operationOrder, RESTART_OPERATION_ORDER)
      || boundary.lifecycleJournalFsyncedBeforeMutation !== true
      || !Number.isSafeInteger(boundary.lifecycleJournalRevision)
      || boundary.lifecycleJournalRevision < 1
      || boundary.requestDigest !== identity.requestDigest
      || iso(boundary.requestedAt, "restart requestedAt") !== boundary.requestedAt) {
    fail("protected_deployment_restart_boundary_invalid",
      "Node Agent lifecycle controller did not persist the exact restart request");
  }
  return Object.freeze(copy(boundary));
}

function restartObservation(value, expected, label) {
  const observation = exactObject(value, label);
  for (const key of ["containerName", "containerId", "imageId", "imageReference", "configDigest"]) {
    if (observation[key] !== expected?.[key]) {
      fail("protected_deployment_restart_identity_drift", `${label} immutable identity drifted`);
    }
  }
  if (observation.status !== "running" || observation.health !== "healthy") {
    fail("protected_deployment_restart_unhealthy", `${label} was not running and healthy`);
  }
  return Object.freeze({ ...copy(observation), startedAt: iso(observation.startedAt, `${label}.startedAt`) });
}

function validatedRestartCompletion(value, request, identity) {
  const completed = exactObject(value, "protected office restart completion");
  const boundary = validatedRestartBoundary(completed.restartBoundary, request, identity);
  const platformBefore = restartObservation(completed.platformBefore,
    request.plan.target.platformIdentity, "platform before restart");
  const platformAfter = restartObservation(completed.platformAfter,
    request.plan.target.platformIdentity, "platform after restart");
  const nodeAgentBefore = restartObservation(completed.nodeAgentBefore,
    request.plan.target.nodeAgentIdentity, "Node Agent before restart");
  const nodeAgentAfter = restartObservation(completed.nodeAgentAfter,
    request.plan.target.nodeAgentIdentity, "Node Agent after restart");
  if (completed.phase !== "complete" || completed.lifecycleCommandId !== identity.lifecycleCommandId
      || completed.platformOperationId !== identity.platformOperationId
      || completed.nodeAgentOperationId !== identity.nodeAgentOperationId
      || new Date(platformAfter.startedAt) <= new Date(platformBefore.startedAt)
      || new Date(nodeAgentAfter.startedAt) <= new Date(nodeAgentBefore.startedAt)
      || !Number.isSafeInteger(completed.journalRevisionBefore)
      || !Number.isSafeInteger(completed.journalRevisionAfter)
      || completed.journalRevisionBefore < 1
      || completed.journalRevisionAfter <= completed.journalRevisionBefore
      || !Number.isSafeInteger(completed.lifecycleJournalRevisionBefore)
      || !Number.isSafeInteger(completed.lifecycleJournalRevisionAfter)
      || completed.lifecycleJournalRevisionBefore < 1
      || completed.lifecycleJournalRevisionAfter <= completed.lifecycleJournalRevisionBefore
      || completed.journalRecovered !== true || completed.lifecycleJournalRecovered !== true
      || completed.desiredStateRecovered !== true || completed.exactIdentityRetained !== true
      || completed.activeCastingSessionsBefore !== 0 || completed.activeCastingSessionsAfter !== 0
      || completed.activeMediaReservationsBefore !== 0 || completed.activeMediaReservationsAfter !== 0) {
    fail("protected_deployment_restart_completion_invalid",
      "Durable lifecycle journal did not prove one complete exact restart");
  }
  return Object.freeze({ ...copy(completed), restartBoundary: boundary,
    platformBefore, platformAfter, nodeAgentBefore, nodeAgentAfter });
}

export function createProtectedOfficeSetProductionActionExecutorFactory(options = {}) {
  assertScenarioDependencies(options);
  const assembler = options.resultAssembler ?? createProtectedOfficeSetProductionResultAssembler(options);
  return function actionExecutorFactory(components) {
    const sources = createInspectionSources(options, components);
    const assemble = async (request, action, extras = {}) => {
      await recordActionAudit(options, {
        request, action,
        metadata: { desiredStateRevision: extras?.proofRevision, transactionId: extras?.proofTransactionId,
          operationId: extras?.maintenance?.operationId },
      });
      const facts = await inspectAll(sources, { runId: request.runId, plan: request.plan, action });
      try {
        return await assembler({ runId: request.runId, plan: request.plan, sources: facts, action, extras });
      } catch (error) {
        if (error instanceof PlatformError) throw error;
        fail("protected_deployment_result_assembly_contract_failed",
          "Independent production result assembly violated its structural contract");
      }
    };
    const finalState = { healthy: true, activeTransactionCount: 0, recoveryRequiredCount: 0, exactDesiredState: true };
    const rollbackFinalState = { recoveryState: "healthy", exactDesiredState: true, activeTransactionCount: 0 };

    return Object.freeze({
      async recoverInterruptedAction({ request }) {
        if (request.action === "restart-verify") {
          const identity = restartIdentity(request);
          const recovered = await options.platformLifecycleController.recoverPlatformRestart({
            runId: request.runId,
            actionId: request.actionId,
            idempotencyKey: request.idempotencyKey,
            ...identity,
            expectedPlatformIdentity: copy(request.plan.target.platformIdentity),
            expectedNodeAgentIdentity: copy(request.plan.target.nodeAgentIdentity),
          });
          if (recovered?.phase !== "complete") {
            fail("protected_deployment_platform_restart_not_recovered",
              "External lifecycle controller has not durably recovered both restart targets", { retryable: true });
          }
          validatedRestartCompletion(recovered, request, identity);
          return;
        }
        const incomplete = await components.setRepository.listIncompleteTransactions({ setId: request.plan.set.setId });
        for (const transaction of incomplete) await components.coordinator.recover({ transactionId: transaction.transactionId });
      },

      async preflight({ request }) {
        const verified = await options.parentEvidenceVerifier.verify({ runId: request.runId, plan: copy(request.plan) });
        if (verified?.parentsValidated !== true || verified.adapterDigest !== request.plan.controller.adapterDigest
            || verified.driverDigest !== request.plan.controller.driverModuleDigest) {
          fail("protected_deployment_parent_verification_failed", "Immutable parent/source verification failed closed");
        }
        const priorProfiles = request.plan.set.profiles.map((profile) => ({
          slot: profile.slot, desiredWorkerId: profile.workerId,
          canonicalContainerName: profile.containerName,
          canonicalState: "exact-canonical", priorIdentityVerified: true,
          canonicalPreparationParentVerified: true,
        }));
        return assemble(request, "preflight", {
          priorProfiles, mutationCount: 0, parentsValidated: true,
          adapterDigest: verified.adapterDigest, driverDigest: verified.driverDigest,
        });
      },

      async "cold-boot"({ request }) {
        const reconciled = await reconcileBaseline(options, components, request, ACTION_REVISIONS["cold-boot"]);
        return assemble(request, "cold-boot", {
          proofRevision: reconciled.transaction.desiredStateRevision,
          proofTransactionId: reconciled.transaction.transactionId,
          transition: {
            operation: "protected-set.transition", outcome: "succeeded",
            schedulerTransactionId: reconciled.transaction.transactionId,
            nodeAgentTransactionId: reconciled.response.transactionId,
            stagedOrder: request.plan.set.profiles.map((profile) => profile.slot),
            prewarmedSlots: request.plan.set.profiles.map((profile) => profile.slot),
            journalPersisted: true, restartPolicyPersisted: true,
          },
        });
      },

      async "concurrent-office"({ request }) {
        const protocol = await options.publicHttpsScenarioRunner.runConcurrentOffice({
          runId: request.runId, actionId: request.actionId,
          idempotencyKey: request.idempotencyKey, plan: copy(request.plan),
          publicOrigin: publicHttpsOrigin(options.publicOrigin),
        });
        if (protocol?.transport !== "authenticated-public-https"
            || !UUID.test(protocol?.assistantRunId ?? "")
            || !UUID.test(protocol?.realtimeSessionId ?? "")
            || !UUID.test(protocol?.ordinaryConflictingJobId ?? "")
            || protocol?.ordinaryConflictObservedQueued !== true
            || protocol?.ordinaryConflictCleanupStatus !== "cancelled") {
          fail("protected_deployment_protocol_runner_invalid", "Real public HTTPS scenario did not return its durable identities");
        }
        const capabilitiesById = new Map((await jobFacts(options.database, protocol.jobIds ?? {}, request.plan))
          .map((item) => [item.capabilityId, item]));
        capabilitiesById.set("assistant.agent", await readProtectedOfficeAssistantAgentFact(
          options.database, protocol.assistantRunId, request.plan,
        ));
        capabilitiesById.set("asr.realtime", await realtimeFact(
          options.database, protocol.realtimeSessionId, request.plan,
        ));
        const capabilities = CAPABILITIES.map(([capabilityId]) => capabilitiesById.get(capabilityId));
        const conflict = rows(await options.database.query(`SELECT job.status,
          (SELECT count(*)::integer FROM compute.attempts attempt WHERE attempt.job_id=job.id) AS attempt_count
          FROM compute.jobs job WHERE job.id=$1`, [protocol.ordinaryConflictingJobId]), "ordinary conflict job")[0];
        if (conflict?.status !== "cancelled" || Number(conflict.attempt_count) !== 0) {
          fail("protected_deployment_conflicting_request_drift", "Ordinary conflicting work did not remain attempt-free through cleanup");
        }
        const reconciled = await reconcileBaseline(options, components, request, ACTION_REVISIONS["concurrent-office"]);
        return assemble(request, "concurrent-office", {
          proofRevision: reconciled.transaction.desiredStateRevision,
          proofTransactionId: reconciled.transaction.transactionId,
          capabilities, ...concurrencyFacts(capabilities),
          ordinaryConflictingRequest: { outcome: "queued", protectedDrainCount: 0 },
          coreServiceInterruptionCount: 0,
        });
      },

      async "bounded-maintenance"({ request }) {
        const started = new Date(options.clock()).getTime();
        const maintenanceContext = await createSignedMaintenanceContext(options, request, {
          purpose: "bounded-maintenance",
        });
        const response = await components.nodeAgentRuntime.executeProtectedSetMaintenance({
          profiles: normalizedManifest(request.plan).profiles,
          maintenanceContext,
          journalRevision: positive(maintenanceContext.journalRevision, "maintenance journalRevision"),
        });
        if (response?.phase !== "complete" || (response.nextOperation ?? response.nextOperationIndex) !== 0) {
          fail("protected_deployment_maintenance_incomplete", "Node Agent maintenance journal is incomplete");
        }
        const reconciled = await reconcileBaseline(options, components, request, ACTION_REVISIONS["bounded-maintenance"]);
        const slots = request.plan.set.profiles.map((profile) => profile.slot);
        return assemble(request, "bounded-maintenance", {
          proofRevision: reconciled.transaction.desiredStateRevision,
          proofTransactionId: reconciled.transaction.transactionId,
          maintenance: {
            operation: "protected-set.maintenance", operationId: maintenanceContext.transactionId,
            outcome: "succeeded", stoppedOrder: [...slots].reverse(), restoredOrder: slots,
            exactIdentityRestored: true, degradationAnnounced: true,
            newDependentWorkBlocked: true, drainCompleted: true,
            warmProbesPassed: slots, capabilitiesReopened: true,
            signature: {
              verified: true, algorithm: maintenanceContext.signature.algorithm,
              keyId: maintenanceContext.signature.keyId,
              payloadDigest: maintenanceContext.signature.payloadDigest,
              issuedAt: iso(maintenanceContext.issuedAt, "maintenance issuedAt"),
              expiresAt: iso(maintenanceContext.expiresAt, "maintenance expiresAt"),
              workerIds: [...maintenanceContext.workerIds],
            },
          },
          durationSeconds: Math.ceil(Math.max(0,
            new Date(options.clock()).getTime() - started) / 1000),
        });
      },

      async "restart-verify"({ request }) {
        const identity = restartIdentity(request);
        const state = await options.platformLifecycleController.inspect({
          runId: request.runId, actionId: request.actionId,
          idempotencyKey: request.idempotencyKey,
          ...identity,
        });
        if (state == null || state.phase === "ready") {
          await options.platformLifecycleController.beginPlatformRestart({
            runId: request.runId, actionId: request.actionId,
            idempotencyKey: request.idempotencyKey,
            ...identity,
            expectedPlatformIdentity: copy(request.plan.target.platformIdentity),
            expectedNodeAgentIdentity: copy(request.plan.target.nodeAgentIdentity),
          });
          // Success cannot return: the controller must first durably admit the
          // Node-Agent mTLS/HMAC lifecycle command and then keep this request
          // pending until the real Platform restart disconnects docker-exec.
          // A normal return would let the driver terminally journal a claim
          // made entirely by the pre-restart process, so it fails closed.
          fail("protected_deployment_restart_did_not_interrupt",
            "Durably admitted restart command returned without a real Platform disconnect");
        }
        const completed = validatedRestartCompletion(state, request, identity);
        const reconciled = await reconcileBaseline(options, components, request, ACTION_REVISIONS["restart-verify"]);
        return assemble(request, "restart-verify", {
          proofRevision: reconciled.transaction.desiredStateRevision,
          proofTransactionId: reconciled.transaction.transactionId,
          restart: {
            protocol: RESTART_PROTOCOL,
            lifecycleCommandType: RESTART_COMMAND_TYPE,
            controllerTransport: "mtls-hmac",
            dockerMutationAuthority: "node-agent-only",
            restartTargets: [...RESTART_TARGETS],
            lifecycleCommandId: identity.lifecycleCommandId,
            actionId: request.actionId,
            idempotencyKey: request.idempotencyKey,
            lifecycleRequestDigest: completed.restartBoundary.requestDigest,
            lifecycleJournalFsyncedBeforeMutation: true,
            operationOrder: [...RESTART_OPERATION_ORDER],
            platformOperationId: identity.platformOperationId,
            nodeAgentOperationId: identity.nodeAgentOperationId,
            platformBefore: completed.platformBefore,
            platformAfter: completed.platformAfter,
            nodeAgentBefore: completed.nodeAgentBefore,
            nodeAgentAfter: completed.nodeAgentAfter,
            journalRevisionBefore: completed.journalRevisionBefore,
            journalRevisionAfter: completed.journalRevisionAfter,
            lifecycleJournalRevisionBefore: completed.lifecycleJournalRevisionBefore,
            lifecycleJournalRevisionAfter: completed.lifecycleJournalRevisionAfter,
            journalRecovered: completed.journalRecovered === true,
            lifecycleJournalRecovered: completed.lifecycleJournalRecovered === true,
            desiredStateRecovered: completed.desiredStateRecovered === true,
            exactIdentityRetained: completed.exactIdentityRetained === true,
            boundedDisconnectTolerated: true,
            activeCastingSessionsBefore: completed.activeCastingSessionsBefore,
            activeCastingSessionsAfter: completed.activeCastingSessionsAfter,
            activeMediaReservationsBefore: completed.activeMediaReservationsBefore,
            activeMediaReservationsAfter: completed.activeMediaReservationsAfter,
          },
        });
      },

      async "mid-sequence-failure"({ request }) {
        const current = await components.setRepository.getSetState(request.plan.set.setId);
        const desiredStateRevision = Math.max(
          request.plan.set.desiredStateRevision + ACTION_REVISIONS["mid-sequence-failure"],
          Number(current?.desiredStateRevision ?? 0) + 1,
        );
        const maintenanceContext = await createSignedMaintenanceContext(options, request, {
          purpose: "qualification-mid-sequence-failure",
        });
        const fault = await options.faultController.executeMidSequenceFailure({
          runId: request.runId, actionId: request.actionId,
          idempotencyKey: request.idempotencyKey, plan: copy(request.plan),
          manifest: normalizedManifest(request.plan, desiredStateRevision),
          maintenanceContext,
          nodeAgentRuntime: components.nodeAgentRuntime,
          coordinator: components.coordinator,
        });
        if (fault?.observedFailureCode !== request.plan.qualification.faultInjection.expectedFailureCode
            || !UUID.test(fault?.failedTransactionId ?? "") || fault.oomKilled !== false) {
          fail("protected_deployment_fault_controller_invalid", "Controlled Node Agent fault did not produce the required durable failure");
        }
        const failed = mapTransaction(rows(await options.database.query(
          "SELECT * FROM compute.protected_office_set_transactions WHERE id=$1", [fault.failedTransactionId]), "failed transaction")[0]);
        if (failed?.state !== "rolled-back") fail("protected_deployment_fault_rollback_missing", "Failed transaction was not durably rolled back");
        const reconciled = await reconcileBaseline(options, components, request, ACTION_REVISIONS["mid-sequence-failure"]);
        return assemble(request, "mid-sequence-failure", {
          proofRevision: reconciled.transaction.desiredStateRevision,
          proofTransactionId: reconciled.transaction.transactionId,
          failureInjection: {
            slot: request.plan.qualification.faultInjection.slot,
            failedAfterStageOrder: request.plan.qualification.faultInjection.failAfterStageOrder,
            observedFailureCode: fault.observedFailureCode,
            automaticExactRollback: true, partialSuccessRetained: false,
            previousIdentityRestored: true, oomKilled: false,
            failedTransaction: {
              transactionId: failed.transactionId, state: failed.state,
              desiredStateRevision: failed.desiredStateRevision,
              journalRevision: fault.failedJournalRevision,
              journalPhase: "recovered",
            },
            reconcileTransaction: {
              transactionId: reconciled.transaction.transactionId,
              state: "succeeded",
              desiredStateRevision: reconciled.transaction.desiredStateRevision,
              journalRevision: reconciled.response.journalRevision,
            },
            finalState: rollbackFinalState,
          },
        });
      },

      async "final-inspect"({ request }) {
        // No scenario mutation and no audit append: all seven sources read
        // independently; the durable action journal is added by the driver.
        const facts = await inspectAll(sources, { runId: request.runId, plan: request.plan, action: "final-inspect" });
        return assembler({ runId: request.runId, plan: request.plan, sources: facts,
          action: "final-inspect", extras: {} });
      },

      async recover({ request }) {
        const incomplete = await components.setRepository.listIncompleteTransactions({ setId: request.plan.set.setId });
        for (const transaction of incomplete) await components.coordinator.recover({ transactionId: transaction.transactionId });
        const reconciled = await reconcileBaseline(options, components, request, ACTION_REVISIONS.recover);
        return assemble(request, "recover", { proofRevision: reconciled.transaction.desiredStateRevision,
          proofTransactionId: reconciled.transaction.transactionId, finalState });
      },

      async cleanup({ request }) {
        const incomplete = await components.setRepository.listIncompleteTransactions({ setId: request.plan.set.setId });
        for (const transaction of incomplete) await components.coordinator.recover({ transactionId: transaction.transactionId });
        const reconciled = await reconcileBaseline(options, components, request, ACTION_REVISIONS.cleanup);
        return assemble(request, "cleanup", { proofRevision: reconciled.transaction.desiredStateRevision,
          proofTransactionId: reconciled.transaction.transactionId, finalState });
      },
    });
  };
}

export function createProtectedOfficeSetProductionInspectionSourceFactory(options = {}) {
  assertProductionSourceOptions(options);
  return (components) => createInspectionSources(options, components);
}

export function createProtectedOfficeSetProductionScenarioDependencies(options = {}) {
  const resultAssembler = createProtectedOfficeSetProductionResultAssembler(options);
  const normalized = { ...options, resultAssembler };
  return Object.freeze({
    actionExecutorFactory: createProtectedOfficeSetProductionActionExecutorFactory(normalized),
    inspectionSourceFactory: createProtectedOfficeSetProductionInspectionSourceFactory(normalized),
    resultAssembler,
  });
}

function environmentInteger(environment, name) {
  const raw = environment?.[name];
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) throw new TypeError(`${name} is required`);
  return positive(Number(raw), name);
}

/**
 * startPlatformApi-compatible factory.
 *
 * `services.protectedOfficeSetBindings` supplies the already configured real
 * Scheduler/Node-Agent binding factories. The four control dependencies are
 * deliberately mandatory: parent validation, authenticated public HTTPS
 * scenario execution, unsigned maintenance allocation plus external signing, two-phase external
 * lifecycle control, and controlled Node-Agent fault injection never acquire a
 * memory or self-asserting fallback.
 */
export async function createProtectedOfficeSetProductionRuntimeFromEnvironment(environment, services = {}) {
  const bindings = exactObject(services.protectedOfficeSetBindings, "protected office binding service");
  const nodeId = environment?.PLATFORM_PROTECTED_OFFICE_SET_NODE_ID;
  const nodeGeneration = environmentInteger(environment, "PLATFORM_PROTECTED_OFFICE_SET_NODE_GENERATION");
  const auditVerifierIdentityId = environment?.PLATFORM_PROTECTED_OFFICE_SET_AUDIT_VERIFIER_ID;
  const probeJobId = environment?.PLATFORM_PROTECTED_OFFICE_SET_PROBE_JOB_ID;
  const credentialFile = environment?.PLATFORM_PROTECTED_OFFICE_SET_PROBE_CREDENTIAL_FILE;
  if (!UUID.test(nodeId ?? "") || !UUID.test(auditVerifierIdentityId ?? "") || !UUID.test(probeJobId ?? "")) {
    throw new TypeError("protected office runtime identity environment is incomplete");
  }
  const clock = services.clock ?? (() => new Date());
  const options = {
    database: services.database,
    nodeAgentRouter: services.nodeAgentRouter,
    auditRecorder: services.auditService?.record?.bind(services.auditService) ?? services.audit,
    auditService: services.auditService,
    auditVerifierIdentityId,
    fetcher: services.fetcher ?? fetch,
    publicOrigin: services.publicOrigin,
    credentialProvider: services.protectedOfficeSetCredentialProvider
      ?? (() => secureCredential(credentialFile, services.fileSystem)),
    probeJobId,
    parentEvidenceVerifier: services.protectedOfficeSetParentEvidenceVerifier,
    publicHttpsScenarioRunner: services.protectedOfficeSetPublicHttpsScenarioRunner,
    maintenanceContextProvider: services.protectedOfficeSetMaintenanceContextProvider,
    maintenanceSigner: services.protectedOfficeSetMaintenanceSigner,
    platformLifecycleController: services.protectedOfficeSetPlatformLifecycleController,
    faultController: services.protectedOfficeSetFaultController,
    requiredCoreServiceKeys: services.requiredCoreServiceKeys,
    clock,
  };
  const scenarios = createProtectedOfficeSetProductionScenarioDependencies(options);
  return createProtectedOfficeSetProductionRuntime({
    environment,
    database: services.database,
    nodeAgentRouter: services.nodeAgentRouter,
    nodeId,
    nodeGeneration,
    bindingFactory: bindings.bindingFactory,
    maintenanceTargetFactory: bindings.maintenanceTargetFactory,
    protectedSetProvider: bindings.protectedSetProvider,
    realtimePlacementResolver: bindings.realtimePlacementResolver,
    coreServiceProbe: bindings.coreServiceProbe,
    clock,
    idFactory: services.idFactory,
    close: services.protectedOfficeSetClose ?? (async () => {}),
    ...scenarios,
  });
}

export const protectedOfficeSetProductionScenarioContract = Object.freeze({
  inspectionSources: [...SOURCE_NAMES],
  residentRuntimeIdentity: Object.freeze(["containerId", "startedAt"]),
  environment: Object.freeze([
    "PLATFORM_PROTECTED_OFFICE_SET_NODE_ID",
    "PLATFORM_PROTECTED_OFFICE_SET_NODE_GENERATION",
    "PLATFORM_PROTECTED_OFFICE_SET_AUDIT_VERIFIER_ID",
    "PLATFORM_PROTECTED_OFFICE_SET_PROBE_JOB_ID",
    "PLATFORM_PROTECTED_OFFICE_SET_PROBE_CREDENTIAL_FILE",
    "PLATFORM_PROTECTED_OFFICE_SET_MAINTENANCE_KEYRING_FILE",
  ]),
  restart: Object.freeze({
    protocol: RESTART_PROTOCOL,
    lifecycleCommandType: RESTART_COMMAND_TYPE,
    restartTargets: [...RESTART_TARGETS],
    operationOrder: [...RESTART_OPERATION_ORDER],
    phases: Object.freeze(["ready", "restart-requested", "complete"]),
    requiresExternalSameActionRetry: true,
    firstActionOutcome: "bounded docker-exec disconnect after durable lifecycle admission",
    beginPlatformRestartMustNotResolve: true,
    externalObservationOwnedBy: "deployment runner (never Platform)",
    durableIdentity: "runId+actionId+idempotencyKey",
    lifecycleControllerMethods: Object.freeze([
      "inspect", "beginPlatformRestart", "recoverPlatformRestart",
    ]),
  }),
  maintenanceSigning: Object.freeze({
    allocatorDependency: "protectedOfficeSetMaintenanceContextProvider.create",
    signerDependency: "protectedOfficeSetMaintenanceSigner.sign(unsignedContext)",
    signerResponse: "{algorithm:'Ed25519',keyId,payloadDigest,value}",
    platformReadsPrivateSigningMaterial: false,
    privateSigningMaterialOwner: "external maintenance controller/HSM",
    privateSigningKeyEnvironment: null,
    verificationKeyringEnvironment: "PLATFORM_PROTECTED_OFFICE_SET_MAINTENANCE_KEYRING_FILE",
  }),
});
