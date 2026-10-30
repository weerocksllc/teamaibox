import assert from "node:assert/strict";
import test from "node:test";

import { OperationsDashboardService, deriveDashboardAlerts, projectExternalProviderMetrics } from "../src/operations/operations-dashboard-service.mjs";

const NODE = "018f6f18-24d7-7c21-9b62-8c0174199502", ADMIN = "018f6f18-24d7-7c21-9b62-8c017419958b", PROVIDER = "018f6f18-24d7-7c21-9b62-8c0174199510";
const context = { identityId: ADMIN, permissions: ["operations:view"] };
const measured = (value) => ({ status: "measured", value, reasonCode: null, effectiveStatus: "measured" });

function cluster() { return { generatedAt: "2026-08-11T08:00:00.000Z", nodeCount: 1, freshNodeCount: 1, collectionStatus: "fresh",
  nodes: [{ nodeId: NODE, nodeKey: "spark-01", freshness: { status: "fresh", ageMilliseconds: 1000, staleAfterMilliseconds: 30000 }, metrics: { domains: { cpu: { utilizationPercent: measured(42) }, unifiedMemory: { usedBytes: measured(120), availableBytes: measured(8), totalBytes: measured(128) }, storage: { availableBytes: measured(5), totalBytes: measured(100) } }, workers: [{ workerId: ADMIN, profileId: null, state: "failed" }], queues: [{ queueKey: "drawing.batch", depth: measured(12), reasons: [{ reasonCode: "model_loading", count: 12 }] }], coreServices: [{ serviceKey: "object.service", state: "degraded" }] } }],
  aggregate: { domains: {}, processes: [], workers: [], models: [], jobs: {}, reservations: {}, queues: [], coreServices: [] } }; }

function provider(overrides = {}) { return { providerId: PROVIDER, providerKey: "external.lab", displayName: "A100 lab", lifecycleState: "healthy", limits: { concurrency: 8, requestsPerMinute: 120, tokensPerMinute: null }, healthCheck: { intervalSeconds: 30 }, health: { state: "healthy", latencyMilliseconds: 24, errorCode: null, observedAt: "2026-08-11T07:59:50.000Z" }, modelMappings: [{ modelProfileId: ADMIN, operations: ["responses"], contextWindow: 131072, enabled: true }], ...overrides }; }

test("dashboard combines local attribution, external known limits, explicit unsupported hardware, and alerts", async () => {
  const local = cluster(), calls = [];
  const service = new OperationsDashboardService({ localNodeId: NODE, clock: () => new Date("2026-08-11T08:00:00.000Z"),
    clusterMetricService: { async getCluster(input) { calls.push(["cluster", input]); return local; }, async getNode(input) { calls.push(["node", input]); return { node: local.nodes[0] }; } },
    externalProviderService: { async listOperations(input) { calls.push(["provider", input]); return { data: [provider()] }; } } });
  const result = await service.getDashboard({ context });
  assert.equal(result.externalProviders.data[0].metrics.concurrencyLimit.status, "configured");
  assert.equal(result.externalProviders.data[0].metrics.concurrencyLimit.value, 8);
  assert.equal(result.externalProviders.data[0].metrics.accelerator.status, "unsupported");
  assert.equal(result.externalProviders.data[0].metrics.accelerator.value, null);
  assert.deepEqual(result.alerts.map((item) => item.code), ["worker_failed", "core_service_degraded", "storage_low", "unified_memory_pressure", "queue_backlog"]);
  assert.equal(calls.length, 2);
});

test("external provider health freshness is independent from unsupported hardware", () => {
  const value = projectExternalProviderMetrics(provider(), new Date("2026-08-11T08:02:00.000Z"));
  assert.equal(value.freshness.status, "stale");
  assert.equal(value.health.latencyMilliseconds.status, "stale");
  assert.equal(value.metrics.cpu.status, "unsupported");
  const alerts = deriveDashboardAlerts({ nodes: [] }, [value]);
  assert.equal(alerts[0].code, "provider_health_stale");
});

test("node alert matrix detects stale or missing telemetry, critical metric gaps, pressure, disk thresholds, and queue backlog, then clears on recovery", () => {
  const recovered = cluster(), node = recovered.nodes[0];
  node.metrics.domains.unifiedMemory.usedBytes = measured(40);
  node.metrics.domains.unifiedMemory.availableBytes = measured(60);
  node.metrics.domains.storage.availableBytes = measured(75);
  node.metrics.workers[0].state = "ready";
  node.metrics.queues[0].depth = measured(0);
  node.metrics.queues[0].reasons = [];
  node.metrics.coreServices[0].state = "healthy";
  assert.deepEqual(deriveDashboardAlerts(recovered, []), []);

  const stale = structuredClone(recovered);
  stale.nodes[0].freshness = { status: "stale", ageMilliseconds: 31_000, staleAfterMilliseconds: 30_000 };
  for (const domain of Object.values(stale.nodes[0].metrics.domains)) {
    for (const metric of Object.values(domain)) if (metric.effectiveStatus === "measured") metric.effectiveStatus = "stale";
  }
  assert.deepEqual(deriveDashboardAlerts(stale, []).map((item) => item.code), ["node_metrics_stale"]);

  const missing = structuredClone(recovered);
  missing.nodes[0].freshness = { status: "missing", ageMilliseconds: null, staleAfterMilliseconds: null };
  missing.nodes[0].metrics = null;
  assert.deepEqual(deriveDashboardAlerts(missing, []).map((item) => item.code), ["node_metrics_missing"]);

  const degraded = cluster();
  degraded.nodes[0].metrics.domains.cpu.utilizationPercent = { status: "unavailable", value: null, reasonCode: "collector_gap", effectiveStatus: "unavailable" };
  const alerts = deriveDashboardAlerts(degraded, []);
  assert.deepEqual(new Set(alerts.map((item) => item.code)), new Set(["node_metric_gap", "unified_memory_pressure", "storage_low", "worker_failed", "queue_backlog", "core_service_degraded"]));
  assert.deepEqual(alerts.find((item) => item.code === "node_metric_gap").facts.metricKeys, ["cpu.utilizationPercent"]);
});

test("dashboard does not fabricate providers when the provider catalog is unavailable", async () => {
  const service = new OperationsDashboardService({ localNodeId: NODE, clusterMetricService: { async getCluster() { return { ...cluster(), nodes: [] }; }, async getNode() { return {node: cluster().nodes[0]}; } } });
  const result = await service.getDashboard({ context });
  assert.equal(result.externalProviders.status, "unavailable");
  assert.equal(result.externalProviders.data.length, 0);
});

test("operations dashboard is administrator permission gated", async () => {
  const service = new OperationsDashboardService({ localNodeId: NODE, clusterMetricService: { async getCluster() { return cluster(); }, async getNode() { return {node: cluster().nodes[0]}; } } });
  await assert.rejects(service.getDashboard({ context: { identityId: ADMIN, permissions: [] } }), { code: "operations_permission_required" });
});
