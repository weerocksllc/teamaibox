import { randomUUID } from "node:crypto";
import { diagnosticPage, diagnosticPageSize, readDiagnosticCursor, writeDiagnosticCursor } from "./diagnostic-page.mjs";
import { diagnosticRows, diagnosticExportStream } from "./diagnostic-export-stream.mjs";
import { bufferedMediaResponse } from "../../../../services/object-service/src/buffered-media-budget.mjs";

import {
  currentCorrelationId,
  normalizeCorrelationId,
  PlatformError,
  redact,
} from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_.-]{1,127}$/;
const TARGET_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const TARGET_KINDS = Object.freeze(["core_service", "plugin", "node", "worker", "provider", "software_source", "storage_pool", "network_link"]);
const TARGET_KIND_SET = new Set(TARGET_KINDS);
const HEALTH_STATES = new Set(["unknown", "healthy", "degraded", "unavailable"]);
const LOG_LEVELS = new Set(["debug", "info", "warning", "error", "critical"]);
const TRACE_STATES = new Set(["ok", "error", "cancelled"]);
const ALERT_SEVERITIES = new Set(["info", "warning", "critical"]);
const SAFE_FACT_KEYS = new Set([
  "applicationKey", "architecture", "attemptNumber", "bytes", "cacheState", "coldStartMilliseconds",
  "concurrency", "crashCount", "dataClass", "direction", "durationMilliseconds", "errorCode", "generation",
  "healthState", "httpStatus", "identityId", "jobId", "latencyMilliseconds", "lifecycleState", "metricStatus",
  "modelProfileId", "networkLinkId", "nodeId", "operation", "outcome", "pluginId", "providerId", "queueDelayMilliseconds",
  "queueDepth", "reasonCode", "requestCount", "retryable", "revision", "sequence", "sourceId", "state", "storagePoolId",
  "targetKind", "targetKey", "teamId", "temperatureCelsius", "unifiedMemoryBytes", "unit", "value", "workerId",
  "nextRetryAt",
]);
const DEFAULT_RETENTION_DAYS = Object.freeze({ log: 14, metric: 30, trace: 14, health: 30, export: 7, resolvedAlert: 90 });

function fail(code, message, status = 400, retryable = false) { throw new PlatformError(code, message, { status, retryable }); }
function identity(context) {
  const id = context?.identityId ?? context?.identity?.id;
  if (!UUID.test(id ?? "")) fail("invalid_session", "Authentication is required", 401);
  return id;
}
function has(context, permission) { return context?.permissions?.includes(permission) === true; }
function requireView(context) {
  identity(context);
  if (!context.permissions?.some((permission) => new Set(["operations:view", "node:view", "node:manage"]).has(permission))) {
    fail("operations_permission_required", "Operations view permission is required", 403);
  }
}
function requireManage(context) { identity(context); if (!has(context, "operations:manage")) fail("operations_manage_permission_required", "Operations management permission is required", 403); }
function requiredKey(value, name) { if (typeof value !== "string" || !KEY.test(value)) throw new TypeError(`${name} must be a stable key`); return value; }
function requiredTarget(value, name = "target") {
  if (!TARGET_KIND_SET.has(value?.kind) || typeof value?.key !== "string" || !TARGET_KEY.test(value.key)) throw new TypeError(`${name} is invalid`);
  return Object.freeze({ kind: value.kind, key: value.key });
}
function requiredDate(value, name) { const result = value instanceof Date ? new Date(value) : new Date(value); if (!Number.isFinite(result.getTime())) throw new TypeError(`${name} must be a valid timestamp`); return result; }
function ids(values, name) {
  if (values === undefined || values === null) return Object.freeze([]);
  if (!Array.isArray(values) || values.some((value) => !UUID.test(value))) throw new TypeError(`${name} must contain UUIDs`);
  return Object.freeze([...new Set(values.map((value) => value.toLowerCase()))]);
}
function safeFactValue(value, name) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return value;
  if (typeof value === "string" && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:/@+ -]{0,255}$/.test(value)) return redact(value);
  if (value === null) return null;
  throw new TypeError(`facts.${name} is not a safe diagnostic scalar`);
}
export function projectSafeDiagnosticFacts(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("diagnostic facts must be an object");
  const output = {};
  for (const [name, value] of Object.entries(input)) {
    if (!SAFE_FACT_KEYS.has(name)) throw new TypeError(`diagnostic fact is not allowed: ${name}`);
    output[name] = safeFactValue(value, name);
  }
  return Object.freeze(output);
}
function correlation(value) { return normalizeCorrelationId(value ?? currentCorrelationId()); }
function boundedNumber(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}
function publicSignal(value) { return Object.freeze({ ...structuredClone(value), observedAt: new Date(value.observedAt).toISOString() }); }
function publicHealth(value) { return Object.freeze({ ...structuredClone(value), observedAt: new Date(value.observedAt).toISOString() }); }
function publicAlert(value) { return Object.freeze({ ...structuredClone(value), openedAt: new Date(value.openedAt).toISOString(), lastSeenAt: new Date(value.lastSeenAt).toISOString(), resolvedAt: value.resolvedAt ? new Date(value.resolvedAt).toISOString() : null }); }
function dateFilter(value, fallback, name) { return value == null ? new Date(fallback) : requiredDate(value, name); }
function sensitiveItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.referenceId !== "string" || !TARGET_KEY.test(item.referenceId)) throw new TypeError("sensitive content item reference is invalid");
  const contentType = requiredKey(item.contentType ?? "user_content", "sensitive content type");
  if (!Object.hasOwn(item, "content")) throw new TypeError("sensitive content item content is required");
  return Object.freeze({ referenceId: item.referenceId, contentType, content: redact(item.content) });
}

export class OperationalDiagnosticsService {
  #repository; #clock; #idFactory; #audit; #sensitiveContentSource; #retention;
  constructor({ repository, clock = () => new Date(), idFactory = randomUUID, audit = async () => {}, sensitiveContentSource = null, retentionDays = {} }) {
    for (const method of ["insertSignal", "insertHealth", "listSignals", "listHealth", "currentHealth", "upsertAlert", "resolveAlert", "listAlerts", "lookupJobIdsByAttemptIds", "recordExport", "purgeBefore"]) {
      if (typeof repository?.[method] !== "function") throw new TypeError(`observability repository.${method} is required`);
    }
    if (typeof clock !== "function" || typeof idFactory !== "function" || typeof audit !== "function") throw new TypeError("operational diagnostics dependencies are invalid");
    if (sensitiveContentSource !== null && typeof sensitiveContentSource.collect !== "function") throw new TypeError("sensitive content source is invalid");
    this.#repository = repository; this.#clock = clock; this.#idFactory = idFactory; this.#audit = audit; this.#sensitiveContentSource = sensitiveContentSource;
    this.#retention = Object.freeze({ ...DEFAULT_RETENTION_DAYS, ...retentionDays });
    for (const [name, days] of Object.entries(this.#retention)) if (!Number.isInteger(days) || days < 1 || days > 3650) throw new TypeError(`retentionDays.${name} is invalid`);
  }

  async #signal({ kind, correlationId, producer, eventKey, severity, observedAt, data, facts, jobIds, attemptIds }) {
    const value = Object.freeze({ signalId: this.#idFactory(), kind, correlationId: correlation(correlationId), producer: requiredTarget(producer, "producer"),
      eventKey: requiredKey(eventKey, "eventKey"), severity, observedAt: requiredDate(observedAt ?? this.#clock(), "observedAt"),
      data: Object.freeze(structuredClone(data)), facts: projectSafeDiagnosticFacts(facts), jobIds: ids(jobIds, "jobIds"), attemptIds: ids(attemptIds, "attemptIds") });
    if (!UUID.test(value.signalId)) throw new TypeError("idFactory must return a UUID");
    return this.#repository.insertSignal(value);
  }

  async recordLog({ correlationId = null, producer, eventKey, level = "info", observedAt = null, facts = {}, jobIds = [], attemptIds = [] }) {
    if (!LOG_LEVELS.has(level)) throw new TypeError("log level is invalid");
    return this.#signal({ kind: "log", correlationId, producer, eventKey, severity: level, observedAt, data: Object.freeze({ level }), facts, jobIds, attemptIds });
  }

  async recordMetric({ correlationId = null, producer, metricKey, value, unit, aggregation = "gauge", observedAt = null, facts = {}, jobIds = [], attemptIds = [] }) {
    requiredKey(metricKey, "metricKey"); requiredKey(unit, "unit");
    if (!new Set(["gauge", "counter", "histogram_sample"]).has(aggregation)) throw new TypeError("metric aggregation is invalid");
    return this.#signal({ kind: "metric", correlationId, producer, eventKey: `metric.${metricKey}`, severity: "info", observedAt,
      data: Object.freeze({ metricKey, value: boundedNumber(value, "metric value", { minimum: -Number.MAX_SAFE_INTEGER }), unit, aggregation }), facts, jobIds, attemptIds });
  }

  async recordTrace({ correlationId = null, producer, spanKey, status = "ok", durationMilliseconds, observedAt = null, facts = {}, jobIds = [], attemptIds = [] }) {
    requiredKey(spanKey, "spanKey"); if (!TRACE_STATES.has(status)) throw new TypeError("trace status is invalid");
    return this.#signal({ kind: "trace", correlationId, producer, eventKey: `trace.${spanKey}`, severity: status === "error" ? "error" : "info", observedAt,
      data: Object.freeze({ spanKey, status, durationMilliseconds: boundedNumber(durationMilliseconds, "durationMilliseconds", { maximum: 604_800_000 }) }), facts, jobIds, attemptIds });
  }

  async #openAlert({ alertKey, severity, target, correlationId, titleKey, detailKey, facts = {}, signalIds = [], jobIds = [], now }) {
    if (!ALERT_SEVERITIES.has(severity) || typeof alertKey !== "string" || alertKey.length > 512) throw new TypeError("alert is invalid");
    const at = requiredDate(now ?? this.#clock(), "alert time");
    const alertId = this.#idFactory(); if (!UUID.test(alertId)) throw new TypeError("idFactory must return a UUID");
    return this.#repository.upsertAlert(Object.freeze({ alertId, alertKey, severity, status: "open", target: requiredTarget(target),
      correlationId: correlation(correlationId), titleKey: requiredKey(titleKey, "titleKey"), detailKey: requiredKey(detailKey, "detailKey"),
      facts: projectSafeDiagnosticFacts(facts), signalIds: ids(signalIds, "signalIds"), jobIds: ids(jobIds, "jobIds"), occurrenceCount: 1,
      openedAt: at, lastSeenAt: at, resolvedAt: null }));
  }

  async recordHealth({ correlationId = null, target, state, reasonCode = null, observedAt = null, facts = {} }) {
    const normalizedTarget = requiredTarget(target), at = requiredDate(observedAt ?? this.#clock(), "observedAt"), cid = correlation(correlationId);
    if (!HEALTH_STATES.has(state)) throw new TypeError("health state is invalid");
    if (reasonCode !== null) requiredKey(reasonCode, "reasonCode");
    if (state === "healthy" && reasonCode !== null) throw new TypeError("healthy observations cannot have a reason code");
    const safeFacts = projectSafeDiagnosticFacts({ ...facts, healthState: state, ...(reasonCode ? { reasonCode } : {}) });
    const signal = await this.recordLog({ correlationId: cid, producer: normalizedTarget, eventKey: "health.observed",
      level: state === "unavailable" ? "error" : state === "degraded" ? "warning" : "info", observedAt: at, facts: safeFacts });
    const healthId = this.#idFactory(); if (!UUID.test(healthId)) throw new TypeError("idFactory must return a UUID");
    const value = Object.freeze({ healthId, correlationId: cid, target: normalizedTarget, state, reasonCode,
      observedAt: at, facts: safeFacts, signalId: signal.signalId });
    await this.#repository.insertHealth(value);
    const alertKey = `health:${normalizedTarget.kind}:${normalizedTarget.key}`;
    if (new Set(["degraded", "unavailable"]).has(state)) {
      await this.#openAlert({ alertKey, severity: state === "unavailable" ? "critical" : "warning", target: normalizedTarget, correlationId: cid,
        titleKey: "operations.alert.health_unhealthy", detailKey: "operations.alert.health_unhealthy_detail", facts: safeFacts,
        signalIds: [signal.signalId], now: at });
    } else if (state === "healthy") await this.#repository.resolveAlert(alertKey, { correlationId: cid, resolvedAt: at });
    return value;
  }

  async recordProviderHealth(provider, correlationId = null) {
    const observedAt = provider?.health?.observedAt ?? this.#clock();
    return this.recordHealth({ correlationId, target: { kind: "provider", key: provider.providerId ?? provider.providerKey },
      state: provider?.health?.state ?? "unknown", reasonCode: provider?.health?.errorCode ?? null, observedAt,
      facts: { ...(provider?.providerId ? { providerId: provider.providerId } : {}), ...(Number.isFinite(provider?.health?.latencyMilliseconds) ? { latencyMilliseconds: provider.health.latencyMilliseconds } : {}) } });
  }

  async recordSourceHealth(source, correlationId = null) {
    const state = source?.health?.state === "offline" || source?.health?.state === "detached" ? "unavailable" : source?.health?.state ?? "unknown";
    return this.recordHealth({ correlationId, target: { kind: "software_source", key: source.sourceId ?? source.sourceKey }, state,
      reasonCode: source?.health?.errorCode ?? (state === "unavailable" ? `source_${source.health.state}` : null), observedAt: source?.health?.observedAt ?? this.#clock(),
      facts: { ...(source?.sourceId ? { sourceId: source.sourceId } : {}), ...(Number.isFinite(source?.health?.latencyMilliseconds) ? { latencyMilliseconds: source.health.latencyMilliseconds } : {}) } });
  }

  async recordStoragePoolHealth(pool, correlationId = null) {
    return this.recordHealth({ correlationId, target: { kind: "storage_pool", key: pool.poolId ?? pool.poolKey }, state: pool.healthState ?? pool.health?.state ?? "unknown",
      reasonCode: pool.healthReasonCode ?? pool.health?.reasonCode ?? null, observedAt: pool.healthObservedAt ?? pool.health?.observedAt ?? pool.updatedAt ?? this.#clock(),
      facts: { ...(pool?.poolId ? { storagePoolId: pool.poolId } : {}) } });
  }

  async recordManagedNodeHealth(node, correlationId = null) {
    const nodeId = node?.nodeId;
    const rawState = node?.health?.state ?? node?.inventory?.health?.state ?? "unknown";
    const state = rawState === "offline" ? "unavailable" : rawState;
    const observedAt = node?.health?.observedAt ?? node?.observedAt ?? node?.updatedAt ?? this.#clock();
    const declaredReason = node?.health?.errorCode;
    const reasonCode = typeof declaredReason === "string" && KEY.test(declaredReason) ? declaredReason
      : state === "unavailable" ? "node_offline" : state === "degraded" ? "node_degraded" : null;
    const result = [await this.recordHealth({ correlationId, target: { kind: "node", key: nodeId ?? node?.nodeKey }, state,
      reasonCode, observedAt,
      facts: { ...(nodeId ? { nodeId } : {}), ...(node?.generation ? { generation: node.generation } : {}), ...(node?.lifecycleState ? { lifecycleState: node.lifecycleState } : {}) } })];
    for (const link of node?.inventory?.networkLinks ?? node?.networkLinks ?? []) {
      const linkState = link.health === "down" ? "unavailable" : link.health;
      result.push(await this.recordHealth({ correlationId, target: { kind: "network_link", key: `${nodeId ?? node.nodeKey}/${link.linkKey}` }, state: linkState,
        reasonCode: linkState === "healthy" ? null : `network_link_${link.health}`, observedAt,
        facts: { ...(nodeId ? { nodeId } : {}), networkLinkId: link.linkKey, latencyMilliseconds: link.latencyMicroseconds / 1000 } }));
    }
    return Object.freeze(result);
  }

  async recordNodeMetricHealth({ nodeId, nodeGeneration, snapshot }, correlationId = null) {
    if (!UUID.test(nodeId ?? "") || !Number.isSafeInteger(nodeGeneration) || nodeGeneration < 1 || !snapshot) throw new TypeError("node metric health input is invalid");
    const observedAt = snapshot.observedAt ?? this.#clock();
    const result = [await this.recordHealth({ correlationId, target: { kind: "node", key: nodeId }, state: "healthy", observedAt,
      facts: { nodeId, generation: nodeGeneration, sequence: snapshot.sequence } })];
    for (const service of snapshot.coreServices ?? []) {
      result.push(await this.recordHealth({ correlationId, target: { kind: "core_service", key: `${nodeId}/${service.serviceKey}` }, state: service.state,
        reasonCode: service.state === "healthy" ? null : `core_service_${service.state}`, observedAt,
        facts: { nodeId, state: service.state, ...(service.latencyMilliseconds?.status === "measured" ? { latencyMilliseconds: service.latencyMilliseconds.value } : {}) } }));
    }
    return Object.freeze(result);
  }

  async recordPluginHealth(plugin, correlationId = null) {
    const state = plugin?.health?.healthy === true || plugin?.health?.state === "healthy" ? "healthy"
      : plugin?.health?.state === "degraded" ? "degraded" : plugin?.health?.healthy === false || plugin?.health?.state === "unavailable" ? "unavailable" : "unknown";
    return this.recordHealth({ correlationId, target: { kind: "plugin", key: plugin?.pluginId }, state,
      reasonCode: state === "healthy" ? null : plugin?.health?.errorCode ?? plugin?.errorCode ?? (state === "unavailable" ? "plugin_health_failed" : null),
      observedAt: plugin?.health?.observedAt ?? plugin?.observedAt ?? this.#clock(),
      facts: { pluginId: plugin?.pluginId, ...(plugin?.lifecycleState ? { lifecycleState: plugin.lifecycleState } : {}), ...(plugin?.operation ? { operation: plugin.operation } : {}) } });
  }

  async recordWorkerLifecycleEvent(event) {
    if (event?.type === undefined || !KEY.test(event.type) || !UUID.test(event.workerId ?? "") || !UUID.test(event.nodeId ?? "") || !UUID.test(event.modelProfileId ?? "")) throw new TypeError("worker lifecycle event is invalid");
    const jobIds = ids(event.payload?.jobId ? [event.payload.jobId] : [], "event jobIds");
    const attemptIds = ids([...(event.payload?.attemptId ? [event.payload.attemptId] : []), ...(event.payload?.affectedAttemptIds ?? [])], "event attemptIds");
    const facts = { workerId: event.workerId, nodeId: event.nodeId, modelProfileId: event.modelProfileId, generation: event.generation,
      ...(event.payload?.reasonCode ? { reasonCode: event.payload.reasonCode } : {}), ...(Number.isSafeInteger(event.payload?.crashCount) ? { crashCount: event.payload.crashCount } : {}),
      ...(event.payload?.nextRetryAt ? { nextRetryAt: new Date(event.payload.nextRetryAt).toISOString() } : {}) };
    const signal = await this.recordLog({ correlationId: event.correlationId, producer: { kind: "worker", key: event.workerId }, eventKey: event.type,
      level: event.type === "worker.circuit_opened" ? "critical" : event.type.includes("failed") || event.type.includes("crashed") ? "error" : "info",
      observedAt: event.occurredAt, facts, jobIds, attemptIds });
    const alertKey = `worker-circuit:${event.modelProfileId}:${event.workerId}`;
    if (event.type === "worker.circuit_opened") {
      const affectedJobIds = await this.#repository.lookupJobIdsByAttemptIds(attemptIds);
      await this.#openAlert({ alertKey, severity: "critical", target: { kind: "worker", key: event.workerId }, correlationId: event.correlationId,
        titleKey: "operations.alert.worker_circuit_open", detailKey: "operations.alert.worker_circuit_open_detail", facts,
        signalIds: [signal.signalId], jobIds: [...new Set([...jobIds, ...affectedJobIds])], now: event.occurredAt });
    } else if (event.type === "worker.circuit_half_open") await this.#repository.resolveAlert(alertKey, { correlationId: correlation(event.correlationId), resolvedAt: requiredDate(event.occurredAt, "occurredAt") });
    return signal;
  }

  async getCorrelation({ context, correlationId, limit = 1000, cursor = null }) {
    requireView(context); const cid = correlation(correlationId);
    if (cid !== correlationId) fail("correlation_id_invalid", "Correlation identifier is invalid");
    const size = diagnosticPageSize(limit), scope = `correlation:${cid}`;
    const positions = readDiagnosticCursor(cursor, scope, ["signals", "health", "alerts"]);
    const collections = await Promise.all([
      ["signals", "listSignals", "signalId", "observedAt", publicSignal],
      ["health", "listHealth", "healthId", "observedAt", publicHealth],
      ["alerts", "listAlerts", "alertId", "lastSeenAt", publicAlert],
    ].map(async ([key, method, idField, timeField, project]) => {
      const rows = positions[key] === false ? [] : await this.#repository[method]({ correlationId: cid, before: positions[key], limit: size + 1 });
      const page = diagnosticPage(rows, size, idField, timeField);
      return { key, data: Object.freeze(page.data.map(project)), position: page.position };
    }));
    return Object.freeze({ correlationId: cid, ...Object.fromEntries(collections.map(({ key, data }) => [key, data])),
      nextCursor: writeDiagnosticCursor(scope, Object.fromEntries(collections.map(({ key, position }) => [key, position]))) });
  }

  async getHealth({ context }) { requireView(context); return Object.freeze({ generatedAt: requiredDate(this.#clock(), "clock").toISOString(), data: Object.freeze((await this.#repository.currentHealth()).map(publicHealth)) }); }
  async getAlerts({ context, status = "open", limit = 1000, cursor = null }) {
    requireView(context);
    if (!new Set(["open", "resolved", "all"]).has(status)) fail("alert_status_invalid", "Alert status is invalid");
    const size = diagnosticPageSize(limit), scope = `alerts:${status}`;
    const positions = readDiagnosticCursor(cursor, scope, ["alerts"]);
    const rows = positions.alerts === false ? [] : await this.#repository.listAlerts({ statuses: status === "all" ? null : [status], before: positions.alerts, limit: size + 1 });
    const page = diagnosticPage(rows, size, "alertId", "lastSeenAt");
    return Object.freeze({ generatedAt: requiredDate(this.#clock(), "clock").toISOString(), data: Object.freeze(page.data.map(publicAlert)),
      nextCursor: writeDiagnosticCursor(scope, { alerts: page.position }) });
  }

  #filters(input, now) {
    const until = dateFilter(input?.until, now, "until"), since = dateFilter(input?.since, new Date(until.getTime() - 24 * 60 * 60_000), "since");
    if (since > until) fail("diagnostic_range_invalid", "Diagnostic start must not be after its end");
    const correlationId = input?.correlationId == null ? null : correlation(input.correlationId);
    if (input?.correlationId != null && correlationId !== input.correlationId) fail("correlation_id_invalid", "Correlation identifier is invalid");
    const targetKinds = input?.targetKinds == null ? null : [...new Set(input.targetKinds)];
    if (targetKinds !== null && (!Array.isArray(input.targetKinds) || targetKinds.length < 1 || targetKinds.some((kind) => !TARGET_KIND_SET.has(kind)))) fail("diagnostic_target_invalid", "Diagnostic target filter is invalid");
    return Object.freeze({ since, until, correlationId, targetKinds });
  }

  async streamDiagnostics({ context, request = {}, signal }) {
    requireView(context); const requesterId = identity(context), now = requiredDate(this.#clock(), "clock"), filters = this.#filters(request, now);
    const includeSensitive = request.includeSensitive === true;
    let accessReason = null, content = [];
    if (includeSensitive) {
      if (!has(context, "diagnostic_sensitive:view")) fail("diagnostic_sensitive_permission_required", "Sensitive diagnostic content permission is required", 403);
      if (!this.#sensitiveContentSource) fail("diagnostic_sensitive_source_unavailable", "Sensitive diagnostic content source is unavailable", 503, true);
      accessReason = typeof request.reason === "string" ? request.reason.trim() : "";
      if (accessReason.length < 8 || /[\u0000-\u001f\u007f]/.test(accessReason)) fail("diagnostic_access_reason_required", "A specific sensitive-content access reason is required");
      const collected = await this.#sensitiveContentSource.collect({ filters, requesterId, reason: accessReason, signal });
      if (!collected || (!collected[Symbol.iterator] && !collected[Symbol.asyncIterator])) throw new TypeError("sensitive content source returned an invalid collection");
      content = (async function* () { for await (const item of collected) { signal?.throwIfAborted(); yield sensitiveItem(item); } })();
    }
    const exportId = this.#idFactory(); if (!UUID.test(exportId)) throw new TypeError("idFactory must return a UUID");
    const serializedFilters = Object.freeze({ since: filters.since.toISOString(), until: filters.until.toISOString(), correlationId: filters.correlationId, targetKinds: filters.targetKinds });
    const expiresAt = new Date(now.getTime() + this.#retention.export * 86_400_000);
    const header = { schemaVersion: 1, exportId, generatedAt: now.toISOString(), filters: serializedFilters, sensitiveContentIncluded: includeSensitive };
    const common = { since: filters.since, until: filters.until, correlationId: filters.correlationId };
    return { exportId, body: diagnosticExportStream({ header, expiresAt: expiresAt.toISOString(), signal, collections: {
      signals: diagnosticRows(this.#repository, "listSignals", { ...common, producerKinds: filters.targetKinds }, "signalId", "observedAt", publicSignal, signal),
      health: diagnosticRows(this.#repository, "listHealth", { ...common, targetKinds: filters.targetKinds }, "healthId", "observedAt", publicHealth, signal),
      alerts: diagnosticRows(this.#repository, "listAlerts", { ...common, targetKinds: filters.targetKinds }, "alertId", "lastSeenAt", publicAlert, signal),
      sensitiveContent: content,
    }, complete: async ({ counts, bundleDigest }) => {
      await this.#repository.recordExport({ exportId, requestedBy: requesterId, filters: serializedFilters, sensitiveIncluded: includeSensitive,
        accessReason, bundleDigest, signalCount: counts.signals, healthCount: counts.health, alertCount: counts.alerts, contentCount: counts.sensitiveContent, createdAt: now, expiresAt });
      await this.#audit({ action: includeSensitive ? "operations.diagnostic_sensitive_exported" : "operations.diagnostic_exported", actorIdentityId: requesterId,
        exportId, bundleDigest, sensitiveContentIncluded: includeSensitive, accessReason, occurredAt: now.toISOString() });
    } }) };
  }

  // Compatibility for in-process consumers. The HTTP path streams directly.
  async exportDiagnostics(input) {
    const result = await this.streamDiagnostics(input);
    const bytes = await bufferedMediaResponse({ headers: new Headers(), body: (async function* () {
      for await (const part of result.body) yield Buffer.from(part);
    })() });
    return Object.freeze(JSON.parse(bytes.toString("utf8")));
  }
  async runRetention({ context, now = null }) {
    requireManage(context); const actorIdentityId = identity(context), at = requiredDate(now ?? this.#clock(), "retention time"), ago = (days) => new Date(at.getTime() - days * 86_400_000);
    const result = await this.#repository.purgeBefore({ signalCutoffs: { log: ago(this.#retention.log), metric: ago(this.#retention.metric), trace: ago(this.#retention.trace) }, healthBefore: ago(this.#retention.health), exportBefore: ago(this.#retention.export), resolvedAlertBefore: ago(this.#retention.resolvedAlert) });
    await this.#audit({ action: "operations.diagnostic_retention_completed", actorIdentityId, deleted: result, occurredAt: at.toISOString() });
    return Object.freeze({ completedAt: at.toISOString(), deleted: Object.freeze({ ...result }) });
  }
}

export const operationalDiagnosticTargetKinds = TARGET_KINDS;
export const defaultOperationalRetentionDays = DEFAULT_RETENTION_DAYS;
