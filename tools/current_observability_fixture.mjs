#!/usr/bin/env node
/** Create or exactly remove a bounded current-Platform observability fixture. */

import { randomUUID } from "node:crypto";

const mode = process.env.TEAMAIBOX_OBSERVABILITY_FIXTURE_MODE ?? process.argv.at(-1);
const correlationId = process.env.TEAMAIBOX_OBSERVABILITY_CORRELATION_ID;

if (!new Set(["create", "cleanup", "residual"]).has(mode)
    || typeof correlationId !== "string"
    || !/^current-observability-[0-9]{8}-a[1-9][0-9]*$/.test(correlationId)) {
  throw new TypeError("observability fixture mode or correlation ID is invalid");
}

const root = "file:///opt/teamaibox";
const { createPostgresDatabaseFromEnvironment } = await import(`${root}/packages/persistence/src/postgres-database.mjs`);
const { PostgresObservabilityRepository } = await import(`${root}/apps/platform-api/src/operations/postgres-observability-repository.mjs`);
const { OperationalDiagnosticsService } = await import(`${root}/apps/platform-api/src/operations/operational-diagnostics-service.mjs`);

const database = await createPostgresDatabaseFromEnvironment(process.env);
try {
  if (mode === "create") {
    const repository = new PostgresObservabilityRepository({ database });
    const service = new OperationalDiagnosticsService({ repository });
    const workerId = randomUUID();
    const nodeId = randomUUID();
    const modelProfileId = randomUUID();
    const jobId = randomUUID();
    const attemptId = randomUUID();
    const providerId = randomUUID();
    const producer = { kind: "core_service", key: "platform-api" };
    await service.recordLog({ correlationId, producer, eventKey: "qualification.request_completed",
      facts: { operation: "current_observability_acceptance", httpStatus: 200 }, jobIds: [jobId] });
    await service.recordMetric({ correlationId, producer, metricKey: "qualification_latency", value: 17,
      unit: "milliseconds", facts: { operation: "current_observability_acceptance" }, jobIds: [jobId] });
    await service.recordTrace({ correlationId, producer, spanKey: "qualification_roundtrip", status: "ok",
      durationMilliseconds: 17, facts: { operation: "current_observability_acceptance" }, jobIds: [jobId] });
    await service.recordProviderHealth({ providerId, health: { state: "unavailable", errorCode: "provider_timeout",
      latencyMilliseconds: 5000, observedAt: new Date().toISOString() } }, correlationId);
    await service.recordProviderHealth({ providerId, health: { state: "healthy", errorCode: null,
      latencyMilliseconds: 17, observedAt: new Date().toISOString() } }, correlationId);
    const common = { workerId, nodeId, modelProfileId, generation: 1, correlationId };
    await service.recordWorkerLifecycleEvent({ ...common, type: "worker.execution_started", occurredAt: new Date(),
      payload: { jobId, attemptId } });
    await service.recordWorkerLifecycleEvent({ ...common, type: "worker.circuit_opened", occurredAt: new Date(),
      payload: { reasonCode: "model_load_crash", crashCount: 3, nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
        affectedAttemptIds: [attemptId] } });
    await service.recordWorkerLifecycleEvent({ ...common, type: "worker.circuit_half_open", occurredAt: new Date(), payload: {} });
    const facts = await database.query(`SELECT
      (SELECT count(*)::integer FROM platform.diagnostic_signals WHERE correlation_id=$1) AS signals,
      (SELECT count(*)::integer FROM platform.health_signals WHERE correlation_id=$1) AS health,
      (SELECT count(*)::integer FROM platform.operational_alerts WHERE correlation_id=$1) AS alerts`, [correlationId]);
    process.stdout.write(`${JSON.stringify({ mode, correlationId, ...facts.rows[0] })}\n`);
  } else if (mode === "cleanup") {
    const removed = await database.transaction(async (transaction) => {
      const alerts = await transaction.query("DELETE FROM platform.operational_alerts WHERE correlation_id=$1 RETURNING id", [correlationId]);
      const health = await transaction.query("DELETE FROM platform.health_signals WHERE correlation_id=$1 RETURNING id", [correlationId]);
      const signals = await transaction.query("DELETE FROM platform.diagnostic_signals WHERE correlation_id=$1 RETURNING id", [correlationId]);
      return { signals: signals.rows.length, health: health.rows.length, alerts: alerts.rows.length };
    });
    process.stdout.write(`${JSON.stringify({ mode, correlationId, ...removed })}\n`);
  } else {
    const result = await database.query(`SELECT
      (SELECT count(*)::integer FROM platform.diagnostic_signals WHERE correlation_id=$1) AS signals,
      (SELECT count(*)::integer FROM platform.health_signals WHERE correlation_id=$1) AS health,
      (SELECT count(*)::integer FROM platform.operational_alerts WHERE correlation_id=$1) AS alerts`, [correlationId]);
    process.stdout.write(`${JSON.stringify({ mode, correlationId, ...result.rows[0] })}\n`);
  }
} finally {
  await database.close();
}
