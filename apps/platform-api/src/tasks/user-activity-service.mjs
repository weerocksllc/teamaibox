import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_KEY = /^[a-z][a-z0-9_.-]{1,127}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const INTERNAL_CONTEXT = Object.freeze({
  identityId: "00000000-0000-4000-8000-000000000001",
  permissions: Object.freeze(["node:view", "provider:view"]),
});

export const USER_SERVICE_CATALOG = Object.freeze([
  Object.freeze({ applicationKey: "official.assistant", capabilityKey: "assistant", aliases: Object.freeze(["assistant", "agent", "chat", "llm.chat"]), operations: Object.freeze(["responses", "chat.completions"]) }),
  Object.freeze({ applicationKey: "official.drawing", capabilityKey: "drawing", aliases: Object.freeze(["drawing", "image", "image.generation"]), operations: Object.freeze(["images.generations", "images.edits"]) }),
  Object.freeze({ applicationKey: "official.ocr", capabilityKey: "ocr", aliases: Object.freeze(["ocr", "ocr.document"]), operations: Object.freeze(["ocr"]) }),
  Object.freeze({ applicationKey: "official.asr", capabilityKey: "asr", aliases: Object.freeze(["asr", "speech.transcription"]), operations: Object.freeze(["transcriptions"]) }),
  Object.freeze({ applicationKey: "official.translation", capabilityKey: "translation", aliases: Object.freeze(["translation", "translate"]), operations: Object.freeze(["translations"]) }),
]);

function fail(code, message, status) { throw new PlatformError(code, message, { status }); }
function identity(context) {
  const value = context?.identityId ?? context?.identity?.id;
  if (!UUID.test(value ?? "")) fail("invalid_session", "Authentication is required", 401);
  return value;
}
function requirePermission(context, permission) {
  const actor = identity(context);
  if (!context.permissions?.includes(permission)) fail("task_permission_required", "Own-task permission is required", 403);
  return actor;
}
function metric(value) {
  return value?.effectiveStatus === "measured" || value?.status === "measured" || value?.status === "partial"
    ? value.value : null;
}
function safeTimestamp(value) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
function safeReason(value) {
  const aliases = {
    model_loading: "tasks.wait.model_loading",
    worker_preparing: "tasks.wait.worker_preparing",
    capacity_busy: "tasks.wait.capacity_busy",
    resource_unavailable: "tasks.wait.capacity_busy",
    queue_backlog: "tasks.wait.queue_backlog",
    external_provider: "tasks.wait.external_provider",
    exclusive_job: "tasks.wait.exclusive_job",
  };
  return aliases[value] ?? (value === null || value === undefined ? null : "tasks.wait.capacity_busy");
}
function publicState(value) {
  if (new Set(["admitted", "preparing"]).has(value)) return "preparing";
  if (value === "succeeded") return "completed";
  if (new Set(["expired", "incomplete"]).has(value)) return "failed";
  return new Set(["queued", "running", "completed", "failed", "cancelled"]).has(value) ? value : "failed";
}
function taskKind(record) {
  const value = record.taskKind ?? record.capabilityKey ?? "unknown";
  return SAFE_KEY.test(value) ? value : "unknown";
}
function sanitizeFailure(record) {
  const failure = record.failure ?? record.error;
  if (!failure) return null;
  return Object.freeze({
    code: SAFE_KEY.test(failure.errorCode ?? failure.code ?? "") ? (failure.errorCode ?? failure.code) : "task_failed",
    guidanceKey: SAFE_KEY.test(failure.guidanceKey ?? "") ? failure.guidanceKey : "tasks.failure.retry_later",
    retryable: failure.retryable === true,
    retryAction: SAFE_KEY.test(failure.retryAction ?? "") ? failure.retryAction : null,
  });
}
function sanitizeResults(record) {
  if (!Array.isArray(record.results)) return Object.freeze([]);
  return Object.freeze(record.results.flatMap((result) => {
    if (typeof result?.label !== "string" || result.label.length > 80
        || typeof result?.artifactRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(result.artifactRef)) return [];
    return [Object.freeze({ label: result.label, artifactRef: result.artifactRef })];
  }));
}
function projectAvailability(record) {
  const state = new Set(["available", "busy", "degraded", "unavailable", "unknown"]).has(record?.state) ? record.state : "unknown";
  const applicationKey = SAFE_KEY.test(record?.applicationKey ?? "") ? record.applicationKey : "official.unknown";
  const capabilityKey = SAFE_KEY.test(record?.capabilityKey ?? "") ? record.capabilityKey : "unknown";
  const estimateStatus = record?.wait?.estimateStatus === "estimated" ? "estimated" : "unavailable";
  const estimatedSeconds = estimateStatus === "estimated" && Number.isSafeInteger(record?.wait?.estimatedSeconds)
    && record.wait.estimatedSeconds >= 0 && record.wait.estimatedSeconds <= 7 * 24 * 60 * 60 ? record.wait.estimatedSeconds : null;
  const basis = new Set(["no_queue", "queue_age_proxy"]).has(record?.wait?.basis) ? record.wait.basis : null;
  return Object.freeze({ applicationKey, capabilityKey, state,
    reasonKey: SAFE_KEY.test(record?.reasonKey ?? "") ? record.reasonKey : "services.reason.telemetry",
    wait: Object.freeze({ estimateStatus: estimatedSeconds === null ? "unavailable" : estimateStatus, estimatedSeconds, basis: estimatedSeconds === null ? null : basis }),
    observedAt: safeTimestamp(record?.observedAt) });
}
function projectTask(record, availability) {
  const kind = taskKind(record);
  const state = publicState(record.state ?? record.status);
  const rawProgress = Number(record.progress?.value ?? record.progress ?? 0);
  const progress = Math.round(Math.max(0, Math.min(100, record.jobId ? rawProgress * 100 : rawProgress)) * 100) / 100;
  const service = availability.find((item) => item.capabilityKey === kind
    || USER_SERVICE_CATALOG.find((entry) => entry.capabilityKey === item.capabilityKey)?.aliases.includes(kind));
  const reasonKey = safeReason(record.waitingReason) ?? (state === "queued" || state === "preparing" ? service?.reasonKey ?? "tasks.wait.capacity_busy" : null);
  return Object.freeze({
    taskId: record.taskId ?? record.id ?? record.jobId,
    taskKind: kind,
    titleKey: SAFE_KEY.test(record.titleKey ?? "") ? record.titleKey : `tasks.kind.${kind}`,
    state,
    progress,
    progressRevision: Number.isSafeInteger(record.progressRevision ?? record.progress?.revision) ? (record.progressRevision ?? record.progress.revision) : 1,
    cancellationRequested: state !== "completed" && (record.cancellationRequested === true || record.cancelRequestedAt != null),
    wait: Object.freeze({
      reasonKey,
      estimateStatus: reasonKey ? service?.wait.estimateStatus ?? "unavailable" : "not_applicable",
      estimatedSeconds: reasonKey ? service?.wait.estimatedSeconds ?? null : null,
    }),
    failure: sanitizeFailure(record),
    results: sanitizeResults(record),
    canCancel: !TERMINAL.has(state) && record.cancellationRequested !== true && record.cancelRequestedAt == null,
    createdAt: safeTimestamp(record.createdAt),
    updatedAt: safeTimestamp(record.updatedAt),
    terminalAt: safeTimestamp(record.terminalAt),
  });
}

async function optional(call, fallback) {
  try { return await call(); } catch { return fallback; }
}

export class ClusterUserServiceAvailabilitySource {
  #nodes; #metrics; #providers; #clock;
  constructor({ managedNodeService = null, clusterMetricService = null, externalProviderService = null, clock = () => new Date() } = {}) {
    if (managedNodeService !== null && typeof managedNodeService.list !== "function") throw new TypeError("Managed node service is invalid");
    if (clusterMetricService !== null && typeof clusterMetricService.getCluster !== "function") throw new TypeError("Cluster metric service is invalid");
    if (externalProviderService !== null && typeof externalProviderService.listOperations !== "function") throw new TypeError("External provider service is invalid");
    this.#nodes = managedNodeService; this.#metrics = clusterMetricService; this.#providers = externalProviderService; this.#clock = clock;
  }

  async snapshot() {
    const [nodeResult, metricResult, providerResult] = await Promise.all([
      this.#nodes ? optional(() => this.#nodes.list({ context: INTERNAL_CONTEXT }), { data: [] }) : { data: [] },
      this.#metrics ? optional(() => this.#metrics.getCluster({ context: INTERNAL_CONTEXT }), null) : null,
      this.#providers ? optional(() => this.#providers.listOperations({ context: INTERNAL_CONTEXT }), { data: [] }) : { data: [] },
    ]);
    const nodes = nodeResult.data ?? [], providers = providerResult.data ?? [];
    const queues = metricResult?.aggregate?.queues ?? [];
    const generatedAt = this.#clock().toISOString();
    return Object.freeze(USER_SERVICE_CATALOG.map((definition) => {
      const local = nodes.flatMap((node) => node.lifecycleState === "removed" || node.lifecycleState === "disabled" ? []
        : (node.inventory?.capabilities ?? []).filter((capability) => definition.aliases.includes(capability.capabilityKey))
          .map((capability) => node.lifecycleState === "ready" ? capability.state : "degraded"));
      const external = providers.some((provider) => provider.lifecycleState === "healthy" && provider.health?.state === "healthy"
        && (provider.modelMappings ?? []).some((mapping) => mapping.enabled !== false && mapping.operations?.some((operation) => definition.operations.includes(operation))));
      const relatedQueues = queues.filter((queue) => definition.aliases.some((alias) => queue.queueKey === alias || queue.queueKey.startsWith(`${alias}.`)));
      const queueDepth = relatedQueues.reduce((sum, queue) => sum + (metric(queue.depth) ?? 0), 0);
      const waitMilliseconds = Math.max(0, ...relatedQueues.map((queue) => metric(queue.oldestWaitMilliseconds) ?? 0));
      const hasRoute = external || local.includes("available");
      const state = hasRoute ? (queueDepth > 0 ? "busy" : "available")
        : local.includes("degraded") ? "degraded"
          : metricResult?.collectionStatus === "stale" || metricResult?.collectionStatus === "partial" ? "unknown" : "unavailable";
      const reasonKey = state === "available" ? "services.reason.ready" : state === "busy" ? "services.reason.busy"
        : state === "degraded" ? "services.reason.degraded" : state === "unknown" ? "services.reason.telemetry" : "services.reason.unavailable";
      return Object.freeze({ applicationKey: definition.applicationKey, capabilityKey: definition.capabilityKey, state, reasonKey,
        wait: Object.freeze({ estimateStatus: state === "available" ? "estimated" : queueDepth > 0 && waitMilliseconds > 0 ? "estimated" : "unavailable",
          estimatedSeconds: state === "available" ? 0 : queueDepth > 0 && waitMilliseconds > 0 ? Math.ceil(waitMilliseconds / 1000) : null,
          basis: state === "available" ? "no_queue" : queueDepth > 0 && waitMilliseconds > 0 ? "queue_age_proxy" : null }),
        observedAt: generatedAt });
    }));
  }
}

/** App launchability is authoritative; unrelated provider telemetry cannot enable an app. */
export class CatalogUserServiceAvailabilitySource {
  #catalog; #metrics; #clock;
  constructor({ applicationCatalogService, clusterMetricService = null, clock = () => new Date() }) {
    if (!applicationCatalogService?.list) throw new TypeError("Application catalog is required");
    this.#catalog = applicationCatalogService; this.#metrics = clusterMetricService; this.#clock = clock;
  }
  async snapshot({ context } = {}) {
    const [catalog, metrics] = await Promise.all([
      this.#catalog.list({ context }),
      this.#metrics ? optional(() => this.#metrics.getCluster({ context: INTERNAL_CONTEXT }), null) : null,
    ]);
    return Object.freeze(USER_SERVICE_CATALOG.flatMap((definition) => {
      const app = catalog.applications.find((item) => item.pluginKey === definition.applicationKey);
      if (!app?.authorized) return [];
      const queues = (metrics?.aggregate?.queues ?? []).filter((queue) => definition.aliases.some(
        (alias) => queue.queueKey === alias || queue.queueKey.startsWith(`${alias}.`)));
      const known = metrics?.collectionStatus === "fresh" && queues.length > 0
        && queues.every((queue) => Number.isFinite(metric(queue.depth)) && metric(queue.depth) >= 0);
      const depth = known ? queues.reduce((sum, queue) => sum + metric(queue.depth), 0) : null;
      const wait = known ? Math.max(0, ...queues.map((queue) => metric(queue.oldestWaitMilliseconds) ?? 0)) : null;
      const state = !app.launchable ? "unavailable" : depth > 0 ? "busy" : "available";
      const seconds = app.launchable && depth === 0 ? 0 : app.launchable && depth > 0 && wait > 0 ? Math.ceil(wait / 1000) : null;
      return [Object.freeze({ applicationKey: definition.applicationKey, capabilityKey: definition.capabilityKey,
        state, reasonKey: `services.reason.${state === "available" ? "ready" : state}`,
        wait: Object.freeze({ estimateStatus: seconds === null ? "unavailable" : "estimated", estimatedSeconds: seconds,
          basis: seconds === null ? null : depth === 0 ? "no_queue" : "queue_age_proxy" }),
        observedAt: this.#clock().toISOString() })];
    }));
  }
}

export class UserActivityService {
  #tasks; #availability; #clock;
  constructor({ taskSource, availabilitySource = null, clock = () => new Date() }) {
    if (!taskSource || (!taskSource.listOwnTasks && !taskSource.listOwn)) throw new TypeError("Own-task source is incomplete");
    if (availabilitySource !== null && typeof availabilitySource.snapshot !== "function") throw new TypeError("Service availability source is invalid");
    this.#tasks = taskSource; this.#availability = availabilitySource; this.#clock = clock;
  }

  async overview({ context }) {
    const ownerIdentityId = requirePermission(context, "task:own:view");
    const [signals, records] = await Promise.all([
      this.#availability ? optional(() => this.#availability.snapshot({ context }), []) : [],
      this.#tasks.listOwn
        ? this.#tasks.listOwn({ ownerIdentityId, includeResult: false, limit: 100 })
        : this.#tasks.listOwnTasks(ownerIdentityId),
    ]);
    const availability = Object.freeze(signals.map(projectAvailability));
    const tasks = Object.freeze(records.map((record) => projectTask(record, availability)));
    return Object.freeze({ generatedAt: this.#clock().toISOString(), availability,
      tasks, summary: Object.freeze({ total: tasks.length, active: tasks.filter((task) => !TERMINAL.has(task.state)).length,
        waiting: tasks.filter((task) => new Set(["queued", "preparing"]).has(task.state)).length,
        failed: tasks.filter((task) => task.state === "failed").length }) });
  }

  async cancelOwn({ context, taskId }) {
    const ownerIdentityId = requirePermission(context, "task:own:manage");
    if (!UUID.test(taskId ?? "")) fail("task_not_found", "Task was not found", 404);
    let record;
    if (this.#tasks.cancelOwn) record = await this.#tasks.cancelOwn({ ownerIdentityId, taskId });
    else if (this.#tasks.cancel) record = await this.#tasks.cancel({ ownerIdentityId, jobId: taskId });
    else if (this.#tasks.requestCancellation) record = await this.#tasks.requestCancellation(ownerIdentityId, taskId);
    else fail("task_cancellation_unavailable", "Task cancellation is unavailable", 503);
    // Cancellation already has an authoritative result. A cluster health
    // lookup must not delay it or turn a successful cancellation into an error.
    return projectTask(record, []);
  }

  async resultOwn({ context, taskId }) {
    const ownerIdentityId = requirePermission(context, "task:own:view");
    if (!UUID.test(taskId ?? "")) fail("task_result_not_found", "Task result was not found", 404);
    if (typeof this.#tasks.resultReference !== "function") {
      fail("task_result_unavailable", "Task result is unavailable", 503);
    }
    return this.#tasks.resultReference({ ownerIdentityId, jobId: taskId, expiresInSeconds: 300 });
  }
}
