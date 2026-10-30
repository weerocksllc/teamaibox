import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { MemoryObservabilityRepository } from "../src/operations/memory-observability-repository.mjs";
import { OperationalDiagnosticsService } from "../src/operations/operational-diagnostics-service.mjs";
import { WorkerObservabilityEventSink } from "../../../services/scheduler/src/worker-observability-event-sink.mjs";

const ADMIN = "018f6f18-24d7-7c21-9b62-8c017419958b";
const WORKER = "018f6f18-24d7-7c21-9b62-8c0174199501";
const NODE = "018f6f18-24d7-7c21-9b62-8c0174199502";
const PROFILE = "018f6f18-24d7-7c21-9b62-8c0174199503";
const JOB = "018f6f18-24d7-7c21-9b62-8c0174199504";
const ATTEMPT = "018f6f18-24d7-7c21-9b62-8c0174199505";
const PROVIDER = "018f6f18-24d7-7c21-9b62-8c0174199506";
const SOURCE = "018f6f18-24d7-7c21-9b62-8c0174199507";
const POOL = "018f6f18-24d7-7c21-9b62-8c0174199508";
const CORRELATION = "request-diagnostic-12345678";
const view = { identityId: ADMIN, permissions: ["operations:view"] };
const manage = { identityId: ADMIN, permissions: ["operations:view", "operations:manage"] };
const sensitive = { identityId: ADMIN, permissions: ["operations:view", "diagnostic_sensitive:view"] };

function fixture(options = {}) {
  const repository = new MemoryObservabilityRepository(), audits = [];
  const service = new OperationalDiagnosticsService({ repository, clock: () => new Date("2026-08-11T12:00:00.000Z"),
    audit: async (event) => audits.push(event), ...options });
  return { repository, service, audits };
}

test("current health uses the latest observation and UUID ties without losing a target", async () => {
  const { repository, service } = fixture();
  for (const [suffix, when, key] of [[1, 10, "one"], [3, 10, "one"], [2, 10, "one"], [4, 9, "one"], [5, 9, "two"]]) {
    await repository.insertHealth({ healthId: `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
      target: { kind: "worker", key }, observedAt: new Date(when), state: "healthy", facts: {} });
  }
  const page = await service.getHealth({ context: view });
  assert.equal(page.data.length, 2);
  assert.ok(page.data[0].healthId.endsWith("003"));
  assert.ok(page.data[1].healthId.endsWith("005"));
});

test("alerts and unequal correlation collections paginate beyond 1000 without lost ties", async () => {
  const { service } = fixture();
  for (let i = 0; i < 1005; i++) await service.recordHealth({ correlationId: CORRELATION,
    target: { kind: "provider", key: `provider-${i}` }, state: "unavailable", reasonCode: "provider_timeout" });
  await service.recordLog({ correlationId: CORRELATION, producer: { kind: "worker", key: WORKER }, eventKey: "worker.ready" });
  let cursor = null;
  const alerts = [], combined = { signals: [], health: [], alerts: [] };
  do {
    const page = await service.getAlerts({ context: view, cursor });
    alerts.push(...page.data); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(alerts.length, 1005);
  assert.equal(new Set(alerts.map((v) => v.alertId)).size, 1005);
  do {
    const page = await service.getCorrelation({ context: view, correlationId: CORRELATION, limit: 37, cursor });
    for (const key of Object.keys(combined)) combined[key].push(...page[key]);
    cursor = page.nextCursor;
  } while (cursor);
  for (const [key, idField, count] of [["signals", "signalId", 1006], ["health", "healthId", 1005], ["alerts", "alertId", 1005]]) {
    assert.equal(combined[key].length, count);
    assert.equal(new Set(combined[key].map((v) => v[idField])).size, count);
  }
});

test("finished correlation collections do not restart and cursors cannot change scope", async () => {
  const { service } = fixture();
  for (let i = 0; i < 4; i++) await service.recordLog({ correlationId: CORRELATION, producer: { kind: "worker", key: WORKER }, eventKey: "worker.ready" });
  const first = await service.getCorrelation({ context: view, correlationId: CORRELATION, limit: 2 });
  const last = await service.getCorrelation({ context: view, correlationId: CORRELATION, limit: 2, cursor: first.nextCursor });
  assert.equal(last.signals.length, 2);
  assert.deepEqual(last.health, []); assert.deepEqual(last.alerts, []);
  assert.equal(last.nextCursor, null);
  await assert.rejects(service.getAlerts({ context: view, cursor: first.nextCursor }), { code: "diagnostic_cursor_invalid" });
  await assert.rejects(service.getCorrelation({ context: view, correlationId: "different-correlation", cursor: first.nextCursor }), { code: "diagnostic_cursor_invalid" });
  for (const cursor of ["garbage", "", Buffer.from(JSON.stringify({ scope: `correlation:${CORRELATION}`, positions: { signals: { id: WORKER, at: "bad" }, health: false, alerts: false } })).toString("base64url")]) {
    await assert.rejects(service.getCorrelation({ context: view, correlationId: CORRELATION, cursor }), { code: "diagnostic_cursor_invalid" });
  }
  await assert.rejects(service.getAlerts({ context: view, limit: 0 }), { code: "diagnostic_page_size_invalid" });
  await assert.rejects(service.getCorrelation({ context: { identityId: ADMIN, permissions: [] }, correlationId: CORRELATION, cursor: first.nextCursor }), { code: "operations_permission_required" });
});

test("diagnostic relationships preserve more than 256 IDs and still validate and deduplicate", async () => {
  const { service } = fixture();
  const linked = Array.from({ length: 600 }, () => randomUUID());
  const saved = await service.recordLog({ producer: { kind: "worker", key: WORKER }, eventKey: "worker.completed",
    jobIds: [...linked, linked[0]], attemptIds: linked });
  assert.deepEqual(saved.jobIds, linked);
  assert.deepEqual(saved.attemptIds, linked);
  await assert.rejects(service.recordLog({ producer: { kind: "worker", key: WORKER }, eventKey: "worker.completed",
    jobIds: [...linked, "not-a-uuid"] }), /must contain UUIDs/);
});

test("repeated alerts retain every relationship after 256 observations", async () => {
  const { service } = fixture();
  for (let index = 0; index < 300; index++) {
    await service.recordHealth({ target: { kind: "provider", key: PROVIDER }, state: "unavailable", reasonCode: "provider_timeout" });
  }
  const result = await service.getAlerts({ context: view });
  assert.equal(result.data[0].signalIds.length, 300);
  assert.equal(new Set(result.data[0].signalIds).size, 300);
  assert.equal(result.data[0].occurrenceCount, 300);
});

test("stores only closed structured log, metric, and trace facts and supports correlation lookup", async () => {
  const { service } = fixture();
  await service.recordLog({ correlationId: CORRELATION, producer: { kind: "core_service", key: "platform-api" }, eventKey: "request.completed", facts: { operation: "jobs.submit", httpStatus: 202, jobId: JOB }, jobIds: [JOB] });
  await service.recordMetric({ correlationId: CORRELATION, producer: { kind: "worker", key: WORKER }, metricKey: "request.latency", value: 24, unit: "milliseconds", facts: { workerId: WORKER, modelProfileId: PROFILE }, jobIds: [JOB] });
  await service.recordTrace({ correlationId: CORRELATION, producer: { kind: "provider", key: PROVIDER }, spanKey: "provider.responses", status: "ok", durationMilliseconds: 42, facts: { providerId: PROVIDER }, jobIds: [JOB] });
  const result = await service.getCorrelation({ context: view, correlationId: CORRELATION });
  assert.deepEqual(result.signals.map((item) => item.kind).sort(), ["log", "metric", "trace"]);
  assert.ok(result.signals.every((item) => item.correlationId === CORRELATION));
  await assert.rejects(service.recordLog({ producer: { kind: "core_service", key: "platform-api" }, eventKey: "unsafe.event", facts: { prompt: "private user content" } }), /not allowed/);
  await assert.rejects(service.getCorrelation({ context: { identityId: ADMIN, permissions: [] }, correlationId: CORRELATION }), { code: "operations_permission_required" });
});

test("projects provider, source, and storage health into actionable alerts and resolves recovery", async () => {
  const { service } = fixture();
  await service.recordProviderHealth({ providerId: PROVIDER, health: { state: "unavailable", errorCode: "provider_timeout", latencyMilliseconds: 5000, observedAt: "2026-08-11T11:50:00.000Z" } }, CORRELATION);
  await service.recordSourceHealth({ sourceId: SOURCE, health: { state: "offline", errorCode: "upstream_offline", observedAt: "2026-08-11T11:51:00.000Z" } }, CORRELATION);
  await service.recordStoragePoolHealth({ poolId: POOL, healthState: "degraded", healthReasonCode: "pool_io_error", updatedAt: "2026-08-11T11:52:00.000Z" }, CORRELATION);
  let alerts = await service.getAlerts({ context: view });
  assert.equal(alerts.data.length, 3);
  assert.deepEqual(new Set(alerts.data.map((item) => item.target.kind)), new Set(["provider", "software_source", "storage_pool"]));
  const health = await service.getHealth({ context: view });
  assert.equal(health.data.length, 3);
  await service.recordProviderHealth({ providerId: PROVIDER, health: { state: "healthy", errorCode: null, latencyMilliseconds: 20, observedAt: "2026-08-11T11:59:00.000Z" } }, CORRELATION);
  await service.recordSourceHealth({ sourceId: SOURCE, health: { state: "healthy", errorCode: null, observedAt: "2026-08-11T11:59:10.000Z" } }, CORRELATION);
  await service.recordStoragePoolHealth({ poolId: POOL, healthState: "healthy", healthReasonCode: null, updatedAt: "2026-08-11T11:59:20.000Z" }, CORRELATION);
  alerts = await service.getAlerts({ context: view });
  assert.equal(alerts.data.length, 0);
  const resolved = await service.getAlerts({ context: view, status: "resolved" });
  assert.deepEqual(new Set(resolved.data.map((item) => item.target.kind)), new Set(["provider", "software_source", "storage_pool"]));
});

test("projects node, network, core-service, and plugin producers into the same closed health model", async () => {
  const { service } = fixture();
  await service.recordManagedNodeHealth({ nodeId: NODE, generation: 3, lifecycleState: "ready", health: { state: "degraded", errorCode: "node_memory_pressure", observedAt: "2026-08-11T11:55:00.000Z" },
    inventory: { networkLinks: [{ linkKey: "lan0", health: "down", latencyMicroseconds: 800 }] } }, CORRELATION);
  await service.recordNodeMetricHealth({ nodeId: NODE, nodeGeneration: 3, snapshot: { observedAt: "2026-08-11T11:56:00.000Z", sequence: 42,
    coreServices: [{ serviceKey: "platform.api", state: "unavailable", latencyMilliseconds: { status: "measured", value: 5000 } }] } }, CORRELATION);
  await service.recordPluginHealth({ pluginId: "official.drawing", lifecycleState: "enabled", health: { healthy: false, errorCode: "plugin_probe_timeout", observedAt: "2026-08-11T11:57:00.000Z" } }, CORRELATION);
  const health = await service.getHealth({ context: view });
  assert.deepEqual(new Set(health.data.map((item) => item.target.kind)), new Set(["node", "network_link", "core_service", "plugin"]));
  const alerts = await service.getAlerts({ context: view });
  assert.deepEqual(new Set(alerts.data.map((item) => item.target.kind)), new Set(["network_link", "core_service", "plugin"]));
  assert.equal(alerts.data.some((item) => JSON.stringify(item).includes("prompt")), false);
});

test("worker circuit alert links prior execution diagnostics to affected jobs and clears on half-open", async () => {
  const { service } = fixture();
  const common = { protocolVersion: 1, workerId: WORKER, nodeId: NODE, modelProfileId: PROFILE, generation: 2, correlationId: CORRELATION };
  await service.recordWorkerLifecycleEvent({ ...common, eventId: randomUUID(), type: "worker.execution_started", occurredAt: new Date("2026-08-11T11:58:00.000Z"), payload: { jobId: JOB, attemptId: ATTEMPT } });
  await service.recordWorkerLifecycleEvent({ ...common, eventId: randomUUID(), type: "worker.circuit_opened", occurredAt: new Date("2026-08-11T11:59:00.000Z"), payload: { reasonCode: "model_load_crash", crashCount: 3, nextRetryAt: "2026-08-11T12:15:00.000Z", affectedAttemptIds: [ATTEMPT] } });
  const open = await service.getAlerts({ context: view });
  assert.equal(open.data.length, 1);
  assert.deepEqual(open.data[0].jobIds, [JOB]);
  assert.equal(open.data[0].facts.reasonCode, "model_load_crash");
  await service.recordWorkerLifecycleEvent({ ...common, eventId: randomUUID(), type: "worker.circuit_half_open", occurredAt: new Date("2026-08-11T12:16:00.000Z"), payload: {} });
  assert.equal((await service.getAlerts({ context: view })).data.length, 0);
});

test("diagnostic export excludes content by default and separately gates and audits sensitive access", async () => {
  const { service, audits } = fixture({ sensitiveContentSource: { async collect() { return [{ referenceId: JOB, content: "allowed prompt", note: "Authorization: Bearer super-secret-token" }]; } } });
  await service.recordLog({ correlationId: CORRELATION, producer: { kind: "core_service", key: "platform-api" }, eventKey: "request.completed", facts: { operation: "assistant.respond" } });
  const ordinary = await service.exportDiagnostics({ context: view, request: { correlationId: CORRELATION } });
  assert.equal(ordinary.sensitiveContentIncluded, false);
  assert.deepEqual(ordinary.sensitiveContent, []);
  assert.match(ordinary.bundleDigest, /^sha256:[0-9a-f]{64}$/);
  await assert.rejects(service.exportDiagnostics({ context: view, request: { includeSensitive: true, reason: "incident review" } }), { code: "diagnostic_sensitive_permission_required" });
  const privileged = await service.exportDiagnostics({ context: sensitive, request: { correlationId: CORRELATION, includeSensitive: true, reason: "incident review 42" } });
  assert.equal(privileged.sensitiveContentIncluded, true);
  assert.equal(privileged.sensitiveContent[0].content, "allowed prompt");
  assert.equal(JSON.stringify(privileged).includes("super-secret-token"), false);
  assert.equal(audits.at(-1).action, "operations.diagnostic_sensitive_exported");
  assert.equal(audits.at(-1).accessReason, "incident review 42");
});

test("retention applies per-signal and evidence lifetimes and requires manage permission", async () => {
  const { service } = fixture();
  await service.recordLog({ observedAt: "2026-07-01T00:00:00.000Z", producer: { kind: "core_service", key: "old-api" }, eventKey: "old.event" });
  await service.recordMetric({ observedAt: "2026-07-01T00:00:00.000Z", producer: { kind: "node", key: NODE }, metricKey: "old.metric", value: 1, unit: "count" });
  await service.recordLog({ observedAt: "2026-08-11T11:00:00.000Z", producer: { kind: "core_service", key: "new-api" }, eventKey: "new.event" });
  await assert.rejects(service.runRetention({ context: view }), { code: "operations_manage_permission_required" });
  const result = await service.runRetention({ context: manage });
  assert.equal(result.deleted.signals, 2);
  const bundle = await service.exportDiagnostics({ context: view, request: { since: "2026-08-01T00:00:00.000Z", until: "2026-08-11T12:00:00.000Z" } });
  assert.equal(bundle.signals.length, 1);
  assert.equal(bundle.signals[0].producer.key, "new-api");
});

test("retention protects signals referenced by current health and open circuit alerts", async () => {
  const { service } = fixture();
  await service.recordHealth({ correlationId: CORRELATION, target: { kind: "provider", key: PROVIDER }, state: "degraded", reasonCode: "provider_slow", observedAt: "2026-07-20T00:00:00.000Z" });
  const common = { workerId: WORKER, nodeId: NODE, modelProfileId: PROFILE, generation: 2, correlationId: CORRELATION };
  await service.recordWorkerLifecycleEvent({ ...common, type: "worker.circuit_opened", occurredAt: "2026-07-20T00:00:00.000Z", payload: { reasonCode: "model_load_crash", crashCount: 3, affectedAttemptIds: [] } });
  const result = await service.runRetention({ context: manage });
  assert.equal(result.deleted.signals, 0);
  const bundle = await service.exportDiagnostics({ context: view, request: { since: "2026-07-15T00:00:00.000Z", until: "2026-08-11T12:00:00.000Z" } });
  assert.equal(bundle.signals.length, 2);
  assert.equal(bundle.health.length, 1);
  assert.equal(bundle.alerts.length, 2);
});

test("worker observability sink preserves the durable lifecycle sink and isolates telemetry failure", async () => {
  const calls = [], errors = [];
  const sink = new WorkerObservabilityEventSink({ downstream: { async publish(event) { calls.push(["durable", event.type]); } },
    diagnostics: { async recordWorkerLifecycleEvent() { throw new Error("diagnostics unavailable"); } }, onError: async (error, event) => errors.push([error.message, event.type]) });
  await sink.publish({ type: "worker.ready" });
  assert.deepEqual(calls, [["durable", "worker.ready"]]);
  assert.deepEqual(errors, [["diagnostics unavailable", "worker.ready"]]);
  const rejected = new WorkerObservabilityEventSink({ downstream: { async publish() { throw new Error("outbox unavailable"); } }, diagnostics: { async recordWorkerLifecycleEvent() { calls.push(["unexpected"]); } } });
  await assert.rejects(rejected.publish({ type: "worker.ready" }), /outbox unavailable/);
  assert.equal(calls.some(([kind]) => kind === "unexpected"), false);
});
