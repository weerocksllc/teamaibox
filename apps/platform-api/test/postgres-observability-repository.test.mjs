import assert from "node:assert/strict";
import test from "node:test";

import { PostgresObservabilityRepository } from "../src/operations/postgres-observability-repository.mjs";

const uuid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const NOW = new Date("2026-08-11T12:00:00.000Z");
function compact(sql) { return sql.replace(/\s+/g, " ").trim(); }
function signalRow() { return { id: uuid(1), signal_kind: "log", correlation_id: "request-diagnostic-12345678", producer_kind: "worker", producer_key: uuid(2), event_key: "worker.ready", severity: "info", observed_at: NOW, data: { level: "info" }, facts: { workerId: uuid(2) }, job_ids: [uuid(3)], attempt_ids: [uuid(4)] }; }
function healthRow() { return { id: uuid(5), correlation_id: "request-diagnostic-12345678", target_kind: "provider", target_key: uuid(6), health_state: "degraded", reason_code: "provider_timeout", observed_at: NOW, facts: { healthState: "degraded" }, signal_id: uuid(1) }; }
function alertRow() { return { id: uuid(7), alert_key: `health:provider:${uuid(6)}`, severity: "warning", alert_status: "open", target_kind: "provider", target_key: uuid(6), correlation_id: "request-diagnostic-12345678", title_key: "operations.alert.health_unhealthy", detail_key: "operations.alert.health_unhealthy_detail", facts: { healthState: "degraded" }, signal_ids: [uuid(1)], job_ids: [uuid(3)], occurrence_count: "2", opened_at: NOW, last_seen_at: NOW, resolved_at: null }; }

class Database {
  calls = [];
  constructor(handler) { this.handler = handler; }
  async query(sql, parameters = []) { const normalized = compact(sql); this.calls.push([normalized, parameters]); return this.handler(normalized, parameters); }
  async transaction(operation) { return operation({ query: (sql, parameters = []) => this.query(sql, parameters) }); }
}

test("PostgreSQL pages use timestamp and UUID together for every diagnostic collection", async () => {
  const database = new Database(() => ({ rows: [] })), repository = new PostgresObservabilityRepository({ database });
  const before = { id: uuid(123), at: NOW.toISOString() };
  for (const method of ["listSignals", "listHealth", "listAlerts"]) {
    await repository[method]({ limit: 38, before });
    const [sql, params] = database.calls.at(-1);
    assert.match(sql, /\((observed_at|last_seen_at),id\) < \(\$[67]::timestamptz,\$[78]::uuid\)/);
    assert.deepEqual(params.slice(-3), [38, before.at, before.id]);
    assert.doesNotMatch(sql, /OFFSET/);
  }
});

test("PostgreSQL observability repository persists and maps closed diagnostic records", async () => {
  const database = new Database((sql) => {
    if (sql.startsWith("INSERT INTO platform.diagnostic_signals")) return { rows: [signalRow()] };
    if (sql.startsWith("INSERT INTO platform.health_signals")) return { rows: [healthRow()] };
    if (sql.startsWith("INSERT INTO platform.operational_alerts")) return { rows: [alertRow()] };
    return { rows: [] };
  });
  const repository = new PostgresObservabilityRepository({ database });
  const savedSignal = await repository.insertSignal({ signalId: uuid(1), kind: "log", correlationId: "request-diagnostic-12345678", producer: { kind: "worker", key: uuid(2) }, eventKey: "worker.ready", severity: "info", observedAt: NOW, data: { level: "info" }, facts: { workerId: uuid(2) }, jobIds: [uuid(3)], attemptIds: [uuid(4)] });
  assert.equal(savedSignal.producer.kind, "worker");
  assert.deepEqual(savedSignal.jobIds, [uuid(3)]);
  const savedHealth = await repository.insertHealth({ healthId: uuid(5), correlationId: "request-diagnostic-12345678", target: { kind: "provider", key: uuid(6) }, state: "degraded", reasonCode: "provider_timeout", observedAt: NOW, facts: { healthState: "degraded" }, signalId: uuid(1) });
  assert.equal(savedHealth.state, "degraded");
  const savedAlert = await repository.upsertAlert({ alertId: uuid(7), alertKey: `health:provider:${uuid(6)}`, severity: "warning", target: { kind: "provider", key: uuid(6) }, correlationId: "request-diagnostic-12345678", titleKey: "operations.alert.health_unhealthy", detailKey: "operations.alert.health_unhealthy_detail", facts: {}, signalIds: [uuid(1)], jobIds: [uuid(3)], occurrenceCount: 1, openedAt: NOW, lastSeenAt: NOW });
  assert.equal(savedAlert.occurrenceCount, 2);
  assert.match(database.calls[2][0], /ON CONFLICT \(alert_key\).*alert_status='open'/);
  assert.doesNotMatch(database.calls[2][0], /LIMIT\s+256/i);
  assert.match(database.calls[2][0], /SELECT DISTINCT value FROM unnest/);
  assert.equal(JSON.stringify(database.calls).includes("private prompt"), false);
});

test("PostgreSQL observability queries preserve correlation, target, and bounded retention semantics", async () => {
  const database = new Database((sql) => {
    if (sql.includes("FROM platform.diagnostic_signals") && sql.startsWith("SELECT")) return { rows: [signalRow()] };
    if (sql.includes("FROM platform.health_signals") && sql.startsWith("WITH RECURSIVE")) return { rows: [healthRow()] };
    if (sql.includes("FROM platform.operational_alerts") && sql.startsWith("SELECT")) return { rows: [alertRow()] };
    if (sql.startsWith("DELETE FROM platform.diagnostic_signals")) return { rows: [{ id: uuid(1) }] };
    if (sql.startsWith("DELETE FROM platform.health_signals")) return { rows: [{ id: uuid(5) }] };
    if (sql.startsWith("DELETE FROM platform.diagnostic_exports")) return { rows: [] };
    if (sql.startsWith("DELETE FROM platform.operational_alerts")) return { rows: [{ id: uuid(7) }] };
    return { rows: [] };
  });
  const repository = new PostgresObservabilityRepository({ database });
  assert.equal((await repository.listSignals({ correlationId: "request-diagnostic-12345678", producerKinds: ["worker"], limit: 25 }))[0].eventKey, "worker.ready");
  assert.equal((await repository.currentHealth())[0].target.kind, "provider");
  assert.match(database.calls.at(-1)[0], /\(target_kind,target_key\) > \(previous.target_kind,previous.target_key\)/);
  assert.match(database.calls.at(-1)[0], /observed_at DESC,id DESC LIMIT 1/);
  assert.doesNotMatch(database.calls.at(-1)[0], /SELECT DISTINCT/);
  assert.equal((await repository.listAlerts({ statuses: ["open"], targetKinds: ["provider"], limit: 25 }))[0].status, "open");
  const deleted = await repository.purgeBefore({ signalCutoffs: { log: NOW, metric: NOW, trace: NOW }, healthBefore: NOW, exportBefore: NOW, resolvedAlertBefore: NOW });
  assert.deepEqual(deleted, { signals: 1, health: 1, exports: 0, alerts: 1 });
  assert.match(database.calls[0][0], /correlation_id=\$3/);
  assert.match(database.calls.at(-1)[0], /signal_kind='log'/);
  assert.match(database.calls.at(-1)[0], /NOT EXISTS .*health_signals/);
  assert.match(database.calls.at(-1)[0], /alert_status='open'/);
});

test("PostgreSQL observability repository requires transactional storage", () => {
  assert.throws(() => new PostgresObservabilityRepository({ database: { query() {} } }), /query and transaction/);
});
