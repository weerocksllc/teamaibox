import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEVERITY_RANK = Object.freeze({ critical: 0, warning: 1, info: 2 });

function fail(code, message, status = 400) { throw new PlatformError(code, message, { status }); }
function viewer(context) {
  if (!UUID.test(context?.identityId ?? context?.identity?.id ?? "")) fail("invalid_session", "Authentication is required", 401);
  if (!context.permissions?.some((permission) => new Set(["operations:view", "node:view", "node:manage"]).has(permission))) fail("operations_permission_required", "Operations view permission is required", 403);
}

function providerMetric(status, value = null, reasonCode = null) { return Object.freeze({ status, value, reasonCode }); }

export function projectExternalProviderMetrics(provider, now, freshnessMultiplier = 3) {
  const healthAt = provider.health?.observedAt ? new Date(provider.health.observedAt) : null;
  const staleAfterMilliseconds = Math.max(15_000, (provider.healthCheck?.intervalSeconds ?? 30) * freshnessMultiplier * 1000);
  const ageMilliseconds = healthAt && Number.isFinite(healthAt.getTime()) ? Math.max(0, now.getTime() - healthAt.getTime()) : null;
  const freshness = healthAt === null || !Number.isFinite(healthAt.getTime()) ? "missing" : ageMilliseconds <= staleAfterMilliseconds ? "fresh" : "stale";
  const latency = provider.health?.latencyMilliseconds;
  return Object.freeze({ providerId: provider.providerId, providerKey: provider.providerKey, displayName: provider.displayName,
    lifecycleState: provider.lifecycleState, modelMappings: Object.freeze((provider.modelMappings ?? []).map((mapping) => Object.freeze({ modelProfileId: mapping.modelProfileId, operations: Object.freeze([...(mapping.operations ?? [])]), contextWindow: mapping.contextWindow, enabled: mapping.enabled !== false }))),
    freshness: Object.freeze({ status: freshness, observedAt: healthAt && Number.isFinite(healthAt.getTime()) ? healthAt.toISOString() : null, ageMilliseconds, staleAfterMilliseconds }),
    health: Object.freeze({ state: provider.health?.state ?? "unknown", errorCode: provider.health?.errorCode ?? null,
      latencyMilliseconds: freshness === "stale" ? providerMetric("stale") : Number.isFinite(latency) ? providerMetric("measured", latency) : providerMetric("unavailable", null, "provider_latency_unavailable") }),
    metrics: Object.freeze({
      concurrencyLimit: providerMetric("configured", provider.limits?.concurrency ?? null),
      activeRequests: providerMetric("unavailable", null, "provider_active_requests_unavailable"),
      requestsPerMinuteLimit: providerMetric("configured", provider.limits?.requestsPerMinute ?? null),
      tokensPerMinuteLimit: provider.limits?.tokensPerMinute == null ? providerMetric("unsupported", null, "provider_token_limit_not_configured") : providerMetric("configured", provider.limits.tokensPerMinute),
      cpu: providerMetric("unsupported", null, "external_provider_hardware_not_exposed"),
      unifiedMemory: providerMetric("unsupported", null, "external_provider_hardware_not_exposed"),
      accelerator: providerMetric("unsupported", null, "external_provider_hardware_not_exposed"),
      temperaturePower: providerMetric("unsupported", null, "external_provider_hardware_not_exposed"),
    }) });
}

function alert(severity, code, scope, titleKey, detailKey, facts = {}) {
  return Object.freeze({ alertId: `${scope.kind}:${scope.id}:${code}`, severity, code, scope: Object.freeze(scope), titleKey, detailKey, facts: Object.freeze(facts) });
}

function metricValue(value) { return metricStatus(value) === "measured" ? value.value : null; }
function metricStatus(value) { return value?.effectiveStatus ?? value?.status ?? "missing"; }

function requiredMetricGaps(node) {
  if (node.freshness.status !== "fresh") return Object.freeze([]);
  const domains = node.metrics?.domains;
  const required = [
    ["cpu.utilizationPercent", domains?.cpu?.utilizationPercent],
    ["unifiedMemory.totalBytes", domains?.unifiedMemory?.totalBytes],
    ["unifiedMemory.usedBytes", domains?.unifiedMemory?.usedBytes],
    ["unifiedMemory.availableBytes", domains?.unifiedMemory?.availableBytes],
    ["storage.totalBytes", domains?.storage?.totalBytes],
    ["storage.availableBytes", domains?.storage?.availableBytes],
  ];
  return Object.freeze(required.filter(([, metric]) => !new Set(["measured", "stale"]).has(metricStatus(metric))).map(([key]) => key));
}

export function deriveDashboardAlerts(cluster, providers) {
  const alerts = [];
  for (const node of cluster.nodes) {
    if (node.freshness.status === "missing") alerts.push(alert("critical", "node_metrics_missing", { kind: "node", id: node.nodeId }, "operations.alert.node_missing", "operations.alert.node_missing_detail"));
    else if (node.freshness.status === "stale") alerts.push(alert("critical", "node_metrics_stale", { kind: "node", id: node.nodeId }, "operations.alert.node_stale", "operations.alert.node_stale_detail", { ageMilliseconds: node.freshness.ageMilliseconds }));
    const metricGaps = requiredMetricGaps(node);
    if (metricGaps.length > 0) alerts.push(alert("warning", "node_metric_gap", { kind: "node", id: node.nodeId }, "operations.alert.metric_gap", "operations.alert.metric_gap_detail", { metricKeys: metricGaps }));
    const memory = node.metrics?.domains.unifiedMemory;
    const used = metricValue(memory?.usedBytes), total = metricValue(memory?.totalBytes);
    if (used !== null && total > 0 && used / total >= 0.9) alerts.push(alert("warning", "unified_memory_pressure", { kind: "node", id: node.nodeId }, "operations.alert.memory_pressure", "operations.alert.memory_pressure_detail", { usedPercent: Math.round(used / total * 100) }));
    const storage = node.metrics?.domains.storage;
    const available = metricValue(storage?.availableBytes), storageTotal = metricValue(storage?.totalBytes);
    if (available !== null && storageTotal > 0 && available / storageTotal <= 0.1) alerts.push(alert("warning", "storage_low", { kind: "node", id: node.nodeId }, "operations.alert.storage_low", "operations.alert.storage_low_detail", { availablePercent: Math.round(available / storageTotal * 100) }));
    for (const worker of node.metrics?.workers ?? []) if (worker.state === "failed") alerts.push(alert("critical", "worker_failed", { kind: "worker", id: worker.workerId }, "operations.alert.worker_failed", "operations.alert.worker_failed_detail", { nodeId: node.nodeId, profileId: worker.profileId }));
    for (const queue of node.metrics?.queues ?? []) {
      const depth = metricValue(queue.depth);
      if (depth !== null && depth >= 10) alerts.push(alert("warning", "queue_backlog", { kind: "queue", id: queue.queueKey }, "operations.alert.queue_backlog", "operations.alert.queue_backlog_detail", { nodeId: node.nodeId, depth, reasons: queue.reasons.map((reason) => reason.reasonCode) }));
    }
    for (const service of node.metrics?.coreServices ?? []) if (service.state !== "healthy") alerts.push(alert(service.state === "unavailable" ? "critical" : "warning", "core_service_degraded", { kind: "core_service", id: service.serviceKey }, "operations.alert.core_service", "operations.alert.core_service_detail", { nodeId: node.nodeId, state: service.state }));
  }
  for (const provider of providers) {
    if (provider.freshness.status === "stale" || provider.freshness.status === "missing") alerts.push(alert("warning", "provider_health_stale", { kind: "provider", id: provider.providerId }, "operations.alert.provider_stale", "operations.alert.provider_stale_detail"));
    else if (!new Set(["healthy", "disabled"]).has(provider.health.state)) alerts.push(alert("warning", "provider_unhealthy", { kind: "provider", id: provider.providerId }, "operations.alert.provider_unhealthy", "operations.alert.provider_unhealthy_detail", { state: provider.health.state }));
  }
  return Object.freeze(alerts.sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] || left.alertId.localeCompare(right.alertId)));
}

export class OperationsDashboardService {
  #metrics; #providers; #clock; #localNodeId;
  constructor({ clusterMetricService, externalProviderService = null, localNodeId, clock = () => new Date() }) {
    if (!clusterMetricService?.getNode || (externalProviderService !== null && typeof externalProviderService.listOperations !== "function") || typeof clock !== "function") throw new TypeError("Operations dashboard dependencies are incomplete");
    if (!UUID.test(localNodeId ?? '')) throw new TypeError('Local appliance identity is required');
    this.#localNodeId = localNodeId; this.#metrics = clusterMetricService; this.#providers = externalProviderService; this.#clock = clock;
  }
  async #external(context, now) {
    if (!this.#providers) return Object.freeze({ status: "unavailable", reasonCode: "provider_catalog_unavailable", data: Object.freeze([]) });
    const result = await this.#providers.listOperations({ context });
    return Object.freeze({ status: "available", reasonCode: null, data: Object.freeze((result.data ?? []).map((provider) => projectExternalProviderMetrics(provider, now))) });
  }
  async getDashboard({ context }) {
    viewer(context); const now = this.#clock();
    const [{ node }, externalProviders] = await Promise.all([this.#metrics.getNode({ context, nodeId: this.#localNodeId }), this.#external(context, now)]);
    return Object.freeze({ generatedAt: now.toISOString(),
      appliance: { deviceId: this.#localNodeId, displayName: node.nodeKey, state: node.lifecycleState,
        collectionStatus: node.freshness.status === 'missing' ? 'unavailable' : node.freshness.status, metrics: node.metrics },
      externalProviders, alerts: deriveDashboardAlerts({nodes:[node]}, externalProviders.data) });
  }
  async getNode({ context, nodeId }) {
    viewer(context); const now = this.#clock();
    if (nodeId !== this.#localNodeId) fail('appliance_identity_mismatch', 'Only this appliance is available', 404);
    const node = await this.#metrics.getNode({ context, nodeId });
    return Object.freeze({ generatedAt: now.toISOString(), ...node });
  }
}
