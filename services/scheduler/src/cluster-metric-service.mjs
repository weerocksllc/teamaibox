import { createHash } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { bufferedMediaBytes } from "../../object-service/src/buffered-media-budget.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_.-]{2,127}$/;
const REASON = /^[a-z][a-z0-9_.-]{2,127}$/;
const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SENSITIVE_FIELD = /(?:secret|token|password|credential|authorization|cookie|private|prompt|content|filename|command|argv|environment|userId|teamId)/i;
const SUPPORT = new Set(["measured", "unsupported", "unavailable"]);

export const NODE_METRIC_DOMAIN_CATALOG = Object.freeze({
  cpu: Object.freeze({
    logicalCores: Object.freeze({ integer: true, maximum: 4096, reducer: "sum" }),
    utilizationPercent: Object.freeze({ maximum: 100, reducer: "average" }),
    load1: Object.freeze({ maximum: 1_000_000, reducer: "sum" }),
  }),
  unifiedMemory: Object.freeze({
    totalBytes: Object.freeze({ integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" }),
    usedBytes: Object.freeze({ integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" }),
    availableBytes: Object.freeze({ integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" }),
    dedicatedAcceleratorMemoryBytes: Object.freeze({ integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" }),
  }),
  accelerator: Object.freeze({
    utilizationPercent: Object.freeze({ maximum: 100, reducer: "average" }),
    temperatureCelsius: Object.freeze({ maximum: 250, reducer: "maximum" }),
    powerWatts: Object.freeze({ maximum: 100_000, reducer: "sum" }),
    powerLimitWatts: Object.freeze({ maximum: 100_000, reducer: "sum" }),
  }),
  storage: Object.freeze({
    totalBytes: Object.freeze({ integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" }),
    usedBytes: Object.freeze({ integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" }),
    availableBytes: Object.freeze({ integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" }),
    readBytesPerSecond: Object.freeze({ integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" }),
    writeBytesPerSecond: Object.freeze({ integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" }),
  }),
  network: Object.freeze({
    receiveBytesPerSecond: Object.freeze({ integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" }),
    transmitBytesPerSecond: Object.freeze({ integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" }),
    availableBitsPerSecond: Object.freeze({ integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" }),
    receiveErrors: Object.freeze({ integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" }),
    transmitErrors: Object.freeze({ integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" }),
  }),
  codecs: Object.freeze({
    encodeActive: Object.freeze({ integer: true, maximum: 1_000_000, reducer: "sum" }),
    encodeCapacity: Object.freeze({ integer: true, maximum: 1_000_000, reducer: "sum" }),
    decodeActive: Object.freeze({ integer: true, maximum: 1_000_000, reducer: "sum" }),
    decodeCapacity: Object.freeze({ integer: true, maximum: 1_000_000, reducer: "sum" }),
  }),
});

const RESOURCE_CATALOG = Object.freeze({
  cpuMillis: { integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" },
  unifiedMemoryBytes: { integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" },
  acceleratorUnits: { maximum: 1_000_000, reducer: "sum" },
  codecSessions: { integer: true, maximum: 1_000_000, reducer: "sum" },
  storageBytes: { integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" },
  networkBitsPerSecond: { integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" },
});

const JOB_CATALOG = Object.freeze({
  queued: { integer: true, maximum: 1_000_000, reducer: "sum" },
  preparing: { integer: true, maximum: 1_000_000, reducer: "sum" },
  running: { integer: true, maximum: 1_000_000, reducer: "sum" },
  succeeded: { integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" },
  failed: { integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" },
  cancelled: { integer: true, maximum: Number.MAX_SAFE_INTEGER, reducer: "sum" },
});

function fail(code, message, status = 400, details = null, retryable = false) {
  throw new PlatformError(code, message, { status, details, retryable });
}

function exactObject(value, field, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("node_metric_invalid", `${field} is invalid`, 400, { field });
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
    fail("node_metric_invalid", `${field} fields are invalid`, 400, { field });
  }
  return value;
}

function noSensitiveFacts(value, path = "snapshot") {
  if (!value || typeof value !== "object") return;
  for (const [name, child] of Object.entries(value)) {
    if (SENSITIVE_FIELD.test(name)) fail("node_metric_sensitive", "Node metrics contain a forbidden field", 400, { field: `${path}.${name}` });
    noSensitiveFacts(child, `${path}.${name}`);
  }
}

function date(value, field) {
  if (typeof value !== "string" || value.length > 64) fail("node_metric_invalid", `${field} is invalid`, 400, { field });
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail("node_metric_invalid", `${field} must be canonical ISO-8601`, 400, { field });
  return parsed;
}

function integer(value, field, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("node_metric_invalid", `${field} is invalid`, 400, { field });
  return value;
}

function identifier(value, field, pattern = TARGET_ID) {
  if (typeof value !== "string" || !pattern.test(value)) fail("node_metric_invalid", `${field} is invalid`, 400, { field });
  return value;
}

function nullableUuid(value, field) { return value == null ? null : identifier(value, field, UUID); }

function normalizeMetric(value, field, definition) {
  exactObject(value, field, ["status", "value", "reasonCode"]);
  if (!SUPPORT.has(value.status)) fail("node_metric_invalid", `${field}.status is invalid`, 400, { field: `${field}.status` });
  if (value.status === "measured") {
    if (value.reasonCode !== null || typeof value.value !== "number" || !Number.isFinite(value.value)
        || value.value < 0 || value.value > definition.maximum || (definition.integer && !Number.isSafeInteger(value.value))) {
      fail("node_metric_invalid", `${field} measurement is invalid`, 400, { field });
    }
    return Object.freeze({ status: "measured", value: value.value, reasonCode: null });
  }
  if (value.value !== null || typeof value.reasonCode !== "string" || !REASON.test(value.reasonCode)) {
    fail("node_metric_invalid", `${field} support reason is invalid`, 400, { field });
  }
  return Object.freeze({ status: value.status, value: null, reasonCode: value.reasonCode });
}

function normalizeMetricMap(value, field, catalog) {
  exactObject(value, field, Object.keys(catalog));
  return Object.freeze(Object.fromEntries(Object.entries(catalog).map(([key, definition]) => [key, normalizeMetric(value[key], `${field}.${key}`, definition)])));
}

function metricArray(value, field, normalizer) {
  if (!Array.isArray(value)) fail("node_metric_invalid", `${field} is invalid`, 400, { field });
  return Object.freeze(value.map((item, index) => normalizer(item, `${field}.${index}`)));
}

function normalizeProcess(value, field) {
  exactObject(value, field, ["targetKind", "targetId", "cpuPercent", "unifiedMemoryBytes", "cgroupMemoryBytes", "acceleratorMemoryBytes"]);
  if (!new Set(["worker", "core_service", "plugin", "agent_sandbox"]).has(value.targetKind)) fail("node_metric_invalid", `${field}.targetKind is invalid`);
  return Object.freeze({ targetKind: value.targetKind, targetId: identifier(value.targetId, `${field}.targetId`),
    cpuPercent: normalizeMetric(value.cpuPercent, `${field}.cpuPercent`, { maximum: 100_000 }),
    unifiedMemoryBytes: normalizeMetric(value.unifiedMemoryBytes, `${field}.unifiedMemoryBytes`, { integer: true, maximum: Number.MAX_SAFE_INTEGER }),
    cgroupMemoryBytes: normalizeMetric(value.cgroupMemoryBytes, `${field}.cgroupMemoryBytes`, { integer: true, maximum: Number.MAX_SAFE_INTEGER }),
    acceleratorMemoryBytes: normalizeMetric(value.acceleratorMemoryBytes, `${field}.acceleratorMemoryBytes`, { integer: true, maximum: Number.MAX_SAFE_INTEGER }) });
}

function normalizeWorker(value, field) {
  exactObject(value, field, ["workerId", "state", "profileId", "jobId", "cpuPercent", "unifiedMemoryBytes", "acceleratorUtilizationPercent"], ["cgroup", "process", "engine", "runtime"]);
  if (!new Set(["cold", "preparing", "ready", "busy", "draining", "failed", "stopped"]).has(value.state)) fail("node_metric_invalid", `${field}.state is invalid`);
  let cgroup = null;
  if (value.cgroup !== null && value.cgroup !== undefined) {
    exactObject(value.cgroup, `${field}.cgroup`, ["currentBytes", "peakBytes", "maximumBytes", "events"], ["inactiveFileBytes"]);
    exactObject(value.cgroup.events, `${field}.cgroup.events`, ["high", "max", "oom", "oomKill", "oomGroupKill"]);
    const maximumBytes = value.cgroup.maximumBytes === "max" ? "max"
      : integer(value.cgroup.maximumBytes, `${field}.cgroup.maximumBytes`);
    cgroup = Object.freeze({ currentBytes: integer(value.cgroup.currentBytes, `${field}.cgroup.currentBytes`),
      ...(value.cgroup.inactiveFileBytes === undefined ? {} : { inactiveFileBytes: integer(value.cgroup.inactiveFileBytes,
        `${field}.cgroup.inactiveFileBytes`, 0, value.cgroup.currentBytes) }),
      peakBytes: integer(value.cgroup.peakBytes, `${field}.cgroup.peakBytes`), maximumBytes,
      events: Object.freeze(Object.fromEntries(["high", "max", "oom", "oomKill", "oomGroupKill"]
        .map((key) => [key, integer(value.cgroup.events[key], `${field}.cgroup.events.${key}`)]))) });
  }
  let process = null;
  if (value.process !== null && value.process !== undefined) {
    exactObject(value.process, `${field}.process`, ["residentBytes"]);
    process = Object.freeze({ residentBytes: integer(value.process.residentBytes, `${field}.process.residentBytes`) });
  }
  const engineValue = value.engine ?? { status: "unavailable", reasonCode: "worker_engine_memory_not_reported",
    allocatedBytes: null, modelBytes: null, cacheBytes: null, certifiedEnvelopeBytes: null };
  exactObject(engineValue, `${field}.engine`, ["status", "reasonCode", "allocatedBytes", "modelBytes", "cacheBytes", "certifiedEnvelopeBytes"]);
  if (!new Set(["measured", "unavailable"]).has(engineValue.status)) fail("node_metric_invalid", `${field}.engine.status is invalid`);
  const engineFields = ["allocatedBytes", "modelBytes", "cacheBytes", "certifiedEnvelopeBytes"];
  if (engineValue.status === "measured" && (engineValue.reasonCode !== null
      || engineFields.some((key) => !Number.isSafeInteger(engineValue[key]) || engineValue[key] < 0))) {
    fail("node_metric_invalid", `${field}.engine measurement is invalid`);
  }
  if (engineValue.status === "unavailable" && (typeof engineValue.reasonCode !== "string" || !REASON.test(engineValue.reasonCode)
      || engineFields.some((key) => engineValue[key] !== null))) fail("node_metric_invalid", `${field}.engine support reason is invalid`);
  const engine = Object.freeze({ status: engineValue.status, reasonCode: engineValue.reasonCode,
    ...Object.fromEntries(engineFields.map((key) => [key, engineValue[key]])) });
  const runtimeValue = value.runtime ?? { status: "unavailable", reasonCode: "worker_runtime_inspection_unavailable", oomKilled: null };
  exactObject(runtimeValue, `${field}.runtime`, ["status", "reasonCode", "oomKilled"]);
  if (!new Set(["measured", "unavailable"]).has(runtimeValue.status)
      || (runtimeValue.status === "measured" && (runtimeValue.reasonCode !== null || typeof runtimeValue.oomKilled !== "boolean"))
      || (runtimeValue.status === "unavailable" && (!REASON.test(runtimeValue.reasonCode ?? "") || runtimeValue.oomKilled !== null))) {
    fail("node_metric_invalid", `${field}.runtime is invalid`);
  }
  return Object.freeze({ workerId: identifier(value.workerId, `${field}.workerId`, UUID), state: value.state,
    profileId: nullableUuid(value.profileId, `${field}.profileId`), jobId: nullableUuid(value.jobId, `${field}.jobId`),
    cpuPercent: normalizeMetric(value.cpuPercent, `${field}.cpuPercent`, { maximum: 100_000 }),
    unifiedMemoryBytes: normalizeMetric(value.unifiedMemoryBytes, `${field}.unifiedMemoryBytes`, { integer: true, maximum: Number.MAX_SAFE_INTEGER }),
    acceleratorUtilizationPercent: normalizeMetric(value.acceleratorUtilizationPercent, `${field}.acceleratorUtilizationPercent`, { maximum: 100 }),
    cgroup, process, engine, runtime: Object.freeze({ status: runtimeValue.status, reasonCode: runtimeValue.reasonCode, oomKilled: runtimeValue.oomKilled }) });
}

function normalizeModel(value, field) {
  exactObject(value, field, ["profileId", "state", "workerId", "unifiedMemoryBytes", "loadMilliseconds"]);
  if (!new Set(["unloaded", "loading", "loaded", "unloading", "failed"]).has(value.state)) fail("node_metric_invalid", `${field}.state is invalid`);
  return Object.freeze({ profileId: identifier(value.profileId, `${field}.profileId`, UUID), state: value.state,
    workerId: nullableUuid(value.workerId, `${field}.workerId`),
    unifiedMemoryBytes: normalizeMetric(value.unifiedMemoryBytes, `${field}.unifiedMemoryBytes`, { integer: true, maximum: Number.MAX_SAFE_INTEGER }),
    loadMilliseconds: normalizeMetric(value.loadMilliseconds, `${field}.loadMilliseconds`, { maximum: Number.MAX_SAFE_INTEGER }) });
}

function normalizeQueue(value, field) {
  exactObject(value, field, ["queueKey", "depth", "oldestWaitMilliseconds", "reasons"]);
  const reasons = metricArray(value.reasons, `${field}.reasons`, (reason, reasonField) => {
    exactObject(reason, reasonField, ["reasonCode", "count"]);
    return Object.freeze({ reasonCode: identifier(reason.reasonCode, `${reasonField}.reasonCode`, REASON), count: integer(reason.count, `${reasonField}.count`, 0, 1_000_000) });
  });
  if (new Set(reasons.map((reason) => reason.reasonCode)).size !== reasons.length) fail("node_metric_invalid", `${field}.reasons contains duplicates`);
  return Object.freeze({ queueKey: identifier(value.queueKey, `${field}.queueKey`, KEY),
    depth: normalizeMetric(value.depth, `${field}.depth`, { integer: true, maximum: 1_000_000 }),
    oldestWaitMilliseconds: normalizeMetric(value.oldestWaitMilliseconds, `${field}.oldestWaitMilliseconds`, { integer: true, maximum: Number.MAX_SAFE_INTEGER }), reasons });
}

function normalizeCoreService(value, field) {
  exactObject(value, field, ["serviceKey", "state", "availabilityPercent", "latencyMilliseconds", "errorRatePercent"]);
  if (!new Set(["healthy", "degraded", "unavailable"]).has(value.state)) fail("node_metric_invalid", `${field}.state is invalid`);
  return Object.freeze({ serviceKey: identifier(value.serviceKey, `${field}.serviceKey`, KEY), state: value.state,
    availabilityPercent: normalizeMetric(value.availabilityPercent, `${field}.availabilityPercent`, { maximum: 100 }),
    latencyMilliseconds: normalizeMetric(value.latencyMilliseconds, `${field}.latencyMilliseconds`, { maximum: Number.MAX_SAFE_INTEGER }),
    errorRatePercent: normalizeMetric(value.errorRatePercent, `${field}.errorRatePercent`, { maximum: 100 }) });
}

export function normalizeNodeMetricSnapshot(value, { memoryBudget = bufferedMediaBytes } = {}) {
  // Budget the normalized copies, maps and duplicate-identity sets together.
  // Counts are not product limits; process telemetry must not lose its tail.
  let entries = 0;
  for (const section of ["processes", "workers", "models", "queues", "coreServices"]) {
    if (Array.isArray(value?.[section])) entries += value[section].length;
  }
  for (const queue of Array.isArray(value?.queues) ? value.queues : []) {
    if (Array.isArray(queue?.reasons)) entries += queue.reasons.length;
  }
  if (entries * 2048 > memoryBudget()) {
    fail("node_metric_memory_unavailable", "Available memory is insufficient to normalize node metrics", 503, null, true);
  }
  noSensitiveFacts(value);
  exactObject(value, "snapshot", ["schemaVersion", "observedAt", "sequence", "collector", "domains", "processes", "workers", "models", "jobs", "queues", "reservations", "coreServices"], ["memoryPressure"]);
  if (value.schemaVersion !== 1) fail("node_metric_invalid", "snapshot.schemaVersion is invalid");
  const collector = exactObject(value.collector, "snapshot.collector", ["agentVersion", "bootId"]);
  if (typeof collector.agentVersion !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(collector.agentVersion)) fail("node_metric_invalid", "snapshot.collector.agentVersion is invalid");
  identifier(collector.bootId, "snapshot.collector.bootId", UUID);
  exactObject(value.domains, "snapshot.domains", Object.keys(NODE_METRIC_DOMAIN_CATALOG));
  const domains = Object.freeze(Object.fromEntries(Object.entries(NODE_METRIC_DOMAIN_CATALOG).map(([key, catalog]) => [key, normalizeMetricMap(value.domains[key], `snapshot.domains.${key}`, catalog)])));
  const memoryPressureValue = value.memoryPressure ?? { someAverage10: { status: "unavailable", value: null, reasonCode: "host_memory_pressure_unavailable" }, fullAverage10: { status: "unavailable", value: null, reasonCode: "host_memory_pressure_unavailable" } };
  exactObject(memoryPressureValue, "snapshot.memoryPressure", ["someAverage10", "fullAverage10"]);
  const memoryPressure = Object.freeze({
    someAverage10: normalizeMetric(memoryPressureValue.someAverage10, "snapshot.memoryPressure.someAverage10", { maximum: 1 }),
    fullAverage10: normalizeMetric(memoryPressureValue.fullAverage10, "snapshot.memoryPressure.fullAverage10", { maximum: 1 }),
  });
  const result = Object.freeze({ schemaVersion: 1, observedAt: date(value.observedAt, "snapshot.observedAt").toISOString(),
    sequence: integer(value.sequence, "snapshot.sequence", 1), collector: Object.freeze({ agentVersion: collector.agentVersion, bootId: collector.bootId }), domains, memoryPressure,
    processes: metricArray(value.processes, "snapshot.processes", normalizeProcess),
    workers: metricArray(value.workers, "snapshot.workers", normalizeWorker),
    models: metricArray(value.models, "snapshot.models", normalizeModel),
    jobs: normalizeMetricMap(value.jobs, "snapshot.jobs", JOB_CATALOG), queues: metricArray(value.queues, "snapshot.queues", normalizeQueue),
    reservations: normalizeMetricMap(value.reservations, "snapshot.reservations", RESOURCE_CATALOG),
    coreServices: metricArray(value.coreServices, "snapshot.coreServices", normalizeCoreService) });
  for (const [section, keys] of [["workers", "workerId"], ["models", "profileId"], ["coreServices", "serviceKey"], ["queues", "queueKey"]]) {
    if (new Set(result[section].map((item) => item[keys])).size !== result[section].length) fail("node_metric_invalid", `snapshot.${section} contains duplicate identities`);
  }
  const memory = result.domains.unifiedMemory;
  if ([memory.totalBytes, memory.usedBytes, memory.availableBytes].every((metric) => metric.status === "measured")
      && memory.usedBytes.value + memory.availableBytes.value > memory.totalBytes.value) fail("node_metric_invalid", "Unified memory evidence exceeds its total");
  return result;
}

function hash(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function repositoryError(error) {
  if (typeof error?.code === "string" && error.code.startsWith("node_metric_")) fail(error.code, error.message, 409, null, true);
  throw error;
}

function assertViewer(context) {
  if (!UUID.test(context?.identityId ?? "")) fail("invalid_session", "Authentication is required", 401);
  if (!context.permissions?.some((permission) => new Set(["node:view", "node:manage", "operations:view"]).has(permission))) fail("operations_permission_required", "Operations view permission is required", 403);
}

function assertNodeTransport(transportIdentity, node, nodeId, generation) {
  if (!transportIdentity?.mutualTls || !transportIdentity.certificateVerified) fail("managed_node_mtls_required", "Verified mutual TLS is required", 401);
  if (transportIdentity.subjectNodeId !== nodeId || transportIdentity.certificateFingerprint !== node.certificateFingerprint) fail("managed_node_certificate_rejected", "Managed node certificate does not match", 401);
  if (node.generation !== generation) fail("stale_node_generation", "Managed node generation changed", 409);
  if (!new Set(["ready", "draining"]).has(node.lifecycleState)) fail("managed_node_not_reporting", "Managed node is not allowed to report metrics", 409);
}

function freshness(snapshot, now) {
  if (!snapshot) return Object.freeze({ status: "missing", ageMilliseconds: null, staleAfterMilliseconds: null });
  const ageMilliseconds = Math.max(0, now.getTime() - snapshot.observedAt.getTime());
  return Object.freeze({ status: ageMilliseconds <= snapshot.staleAfterMilliseconds ? "fresh" : "stale", ageMilliseconds, staleAfterMilliseconds: snapshot.staleAfterMilliseconds });
}

function effectiveMetric(metric, state) {
  return Object.freeze({ ...metric, effectiveStatus: state === "stale" && metric.status === "measured" ? "stale" : metric.status });
}

function effectiveMetricMap(value, state) {
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, metric]) => [key, effectiveMetric(metric, state)])));
}

function effectiveMetricItem(value, metricKeys, state) {
  return Object.freeze({ ...value, ...Object.fromEntries(metricKeys.map((key) => [key, effectiveMetric(value[key], state)])) });
}

function presentSnapshot(record, now) {
  if (!record) return null;
  const currentFreshness = freshness(record, now);
  const state = currentFreshness.status;
  const domains = Object.freeze(Object.fromEntries(Object.entries(record.snapshot.domains).map(([domain, metrics]) => [domain,
    effectiveMetricMap(metrics, state)])));
  return Object.freeze({ nodeId: record.nodeId, nodeGeneration: record.nodeGeneration, sequence: record.sequence,
    observedAt: record.observedAt.toISOString(), receivedAt: record.receivedAt.toISOString(), snapshotDigest: record.snapshotDigest,
    freshness: currentFreshness, collector: record.snapshot.collector, domains,
    memoryPressure: effectiveMetricMap(record.snapshot.memoryPressure ?? {
      someAverage10: { status: "unavailable", value: null, reasonCode: "host_memory_pressure_unavailable" },
      fullAverage10: { status: "unavailable", value: null, reasonCode: "host_memory_pressure_unavailable" },
    }, state),
    processes: Object.freeze(record.snapshot.processes.map((item) => effectiveMetricItem(item,
      ["cpuPercent", "unifiedMemoryBytes", "cgroupMemoryBytes", "acceleratorMemoryBytes"], state))),
    workers: Object.freeze(record.snapshot.workers.map((item) => effectiveMetricItem(item,
      ["cpuPercent", "unifiedMemoryBytes", "acceleratorUtilizationPercent"], state))),
    models: Object.freeze(record.snapshot.models.map((item) => effectiveMetricItem(item,
      ["unifiedMemoryBytes", "loadMilliseconds"], state))),
    jobs: effectiveMetricMap(record.snapshot.jobs, state),
    queues: Object.freeze(record.snapshot.queues.map((item) => effectiveMetricItem(item, ["depth", "oldestWaitMilliseconds"], state))),
    reservations: effectiveMetricMap(record.snapshot.reservations, state),
    coreServices: Object.freeze(record.snapshot.coreServices.map((item) => effectiveMetricItem(item,
      ["availabilityPercent", "latencyMilliseconds", "errorRatePercent"], state))) });
}

function aggregateMetricValues(records, metricFor, definition, now) {
  const entries = records.map((record) => ({ record, fresh: freshness(record, now), metric: record ? metricFor(record.snapshot) : null }));
  const measured = entries.filter((entry) => entry.fresh.status === "fresh" && entry.metric.status === "measured");
  const staleMeasured = entries.filter((entry) => entry.fresh.status === "stale" && entry.metric.status === "measured");
  const unsupported = entries.filter((entry) => entry.metric?.status === "unsupported");
  const unavailable = entries.filter((entry) => entry.metric?.status === "unavailable" || !entry.metric);
  if (measured.length === 0) {
    if (staleMeasured.length > 0) return Object.freeze({ status: "stale", value: null, measuredNodes: 0, totalNodes: records.length });
    if (unsupported.length > 0 && unavailable.length === 0) return Object.freeze({ status: "unsupported", value: null, measuredNodes: 0, totalNodes: records.length });
    return Object.freeze({ status: "unavailable", value: null, measuredNodes: 0, totalNodes: records.length });
  }
  const values = measured.map((entry) => entry.metric.value);
  const value = definition.reducer === "maximum" ? Math.max(...values)
    : definition.reducer === "average" ? values.reduce((sum, item) => sum + item, 0) / values.length
      : values.reduce((sum, item) => sum + item, 0);
  const complete = measured.length === records.length;
  return Object.freeze({ status: complete ? "measured" : "partial", value,
    measuredNodes: measured.length, totalNodes: records.length,
    unsupportedNodes: unsupported.length, staleNodes: staleMeasured.length, unavailableNodes: unavailable.length });
}

function aggregateDomains(records, now) {
  return Object.freeze(Object.fromEntries(Object.entries(NODE_METRIC_DOMAIN_CATALOG).map(([domain, catalog]) => [domain,
    Object.freeze(Object.fromEntries(Object.entries(catalog).map(([key, definition]) => [key, aggregateMetricValues(records, (snapshot) => snapshot.domains[domain][key], definition, now)])))])));
}

function aggregateMetricMap(records, now, field, catalog) {
  return Object.freeze(Object.fromEntries(Object.entries(catalog).map(([key, definition]) => [key,
    aggregateMetricValues(records, (snapshot) => snapshot[field][key], definition, now)])));
}

function flattenFresh(records, now, field) {
  return Object.freeze(records.flatMap((record) => freshness(record, now).status === "fresh"
    ? record.snapshot[field].map((item) => Object.freeze({ nodeId: record.nodeId, nodeGeneration: record.nodeGeneration, ...structuredClone(item) })) : []));
}

export class ClusterMetricService {
  #repository; #nodes; #localNodeId; #clock; #staleMs; #futureSkewMs; #healthSink; #onHealthSinkError;
  constructor({ repository, managedNodeRepository, localNodeId, clock = () => new Date(), staleAfterMilliseconds = 30_000, maximumFutureSkewMilliseconds = 5_000,
    healthSink = null, onHealthSinkError = async () => {} }) {
    if (!repository || ["record", "latestForNode", "listLatest"].some((method) => typeof repository[method] !== "function")
        || !managedNodeRepository || ["findNode", "listNodes"].some((method) => typeof managedNodeRepository[method] !== "function")
        || typeof clock !== "function" || !Number.isSafeInteger(staleAfterMilliseconds) || staleAfterMilliseconds < 5_000 || staleAfterMilliseconds > 300_000
        || !Number.isSafeInteger(maximumFutureSkewMilliseconds) || maximumFutureSkewMilliseconds < 0 || maximumFutureSkewMilliseconds > 60_000
        || (healthSink !== null && typeof healthSink.recordNodeMetricHealth !== "function") || typeof onHealthSinkError !== "function") {
      throw new TypeError("Cluster metric dependencies are incomplete");
    }
    if (!UUID.test(localNodeId ?? "")) throw TypeError("Local appliance metric identity is required");
    this.#localNodeId = localNodeId;
    this.#repository = repository; this.#nodes = managedNodeRepository; this.#clock = clock; this.#staleMs = staleAfterMilliseconds; this.#futureSkewMs = maximumFutureSkewMilliseconds;
    this.#healthSink = healthSink; this.#onHealthSinkError = onHealthSinkError;
  }

  async ingest({ transportIdentity, nodeId, nodeGeneration, snapshot }) {
    identifier(nodeId, "nodeId", UUID); integer(nodeGeneration, "nodeGeneration", 1);
    if (nodeId !== this.#localNodeId) fail("appliance_node_mismatch", "仅支持本机资源。", 409);
    const node = await this.#nodes.findNode(nodeId);
    if (!node) fail("managed_node_not_found", "Managed node was not found", 404);
    assertNodeTransport(transportIdentity, node, nodeId, nodeGeneration);
    const normalized = normalizeNodeMetricSnapshot(snapshot);
    const now = this.#clock();
    const observedAt = new Date(normalized.observedAt);
    if (observedAt.getTime() > now.getTime() + this.#futureSkewMs) fail("node_metric_clock_skew", "Node metric timestamp is too far in the future", 409);
    const stored = await this.#repository.record({ nodeId, nodeGeneration, sequence: normalized.sequence, observedAt, receivedAt: now,
      staleAfterMilliseconds: this.#staleMs, snapshotDigest: hash(normalized), snapshot: normalized }).catch(repositoryError);
    try { await this.#healthSink?.recordNodeMetricHealth({ nodeId, nodeGeneration, snapshot: normalized }); }
    catch (error) { try { await this.#onHealthSinkError(error, { nodeId, nodeGeneration, sequence: normalized.sequence }); } catch { /* diagnostic reporting is non-authoritative */ } }
    return presentSnapshot(stored, now);
  }

  async getNode({ context, nodeId }) {
    assertViewer(context); identifier(nodeId, "nodeId", UUID);
    if (nodeId !== this.#localNodeId) fail("appliance_node_mismatch", "仅支持本机资源。", 409);
    const node = await this.#nodes.findNode(nodeId);
    if (!node || node.lifecycleState === "removed") fail("managed_node_not_found", "Managed node was not found", 404);
    const now = this.#clock();
    const record = await this.#repository.latestForNode(nodeId);
    const current = record?.nodeGeneration === node.generation ? record : null;
    return Object.freeze({ generatedAt: now.toISOString(), node: Object.freeze({ nodeId: node.nodeId, nodeKey: node.nodeKey, generation: node.generation,
      lifecycleState: node.lifecycleState, health: structuredClone(node.health), metrics: presentSnapshot(current, now), freshness: freshness(current, now) }) });
  }

  async getCluster({ context }) {
    assertViewer(context);
    const now = this.#clock();
    const [local, record] = await Promise.all([this.#nodes.findNode(this.#localNodeId), this.#repository.latestForNode(this.#localNodeId)]);
    const currentNodes = local && local.lifecycleState !== "removed" ? [local] : [];
    const recorded = record ? [record] : [];
    const byNode = new Map(recorded.map((record) => [record.nodeId, record]));
    const records = currentNodes.map((node) => { const record = byNode.get(node.nodeId); return record?.nodeGeneration === node.generation ? record : null; });
    const publicNodes = currentNodes.map((node, index) => Object.freeze({ nodeId: node.nodeId, nodeKey: node.nodeKey, generation: node.generation,
      lifecycleState: node.lifecycleState, health: structuredClone(node.health), metrics: presentSnapshot(records[index], now), freshness: freshness(records[index], now) }));
    const presentRecords = records.filter(Boolean);
    const freshNodeCount = presentRecords.filter((record) => freshness(record, now).status === "fresh").length;
    return Object.freeze({ generatedAt: now.toISOString(), nodeCount: currentNodes.length, freshNodeCount,
      collectionStatus: currentNodes.length === 0 ? "unavailable" : freshNodeCount === currentNodes.length ? "fresh" : freshNodeCount > 0 ? "partial" : "stale",
      nodes: Object.freeze(publicNodes), aggregate: Object.freeze({ domains: aggregateDomains(records, now),
        processes: flattenFresh(presentRecords, now, "processes"), workers: flattenFresh(presentRecords, now, "workers"), models: flattenFresh(presentRecords, now, "models"),
        jobs: aggregateMetricMap(records, now, "jobs", JOB_CATALOG), reservations: aggregateMetricMap(records, now, "reservations", RESOURCE_CATALOG),
        queues: flattenFresh(presentRecords, now, "queues"), coreServices: flattenFresh(presentRecords, now, "coreServices") }) });
  }
}

export function isMetricSnapshotDigest(value) { return SHA256.test(value ?? ""); }
