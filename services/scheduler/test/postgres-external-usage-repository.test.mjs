import assert from "node:assert/strict";
import test from "node:test";

import { PostgresExternalUsageRepository } from "../src/postgres-external-usage-repository.mjs";

const uuid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const NOW = new Date("2026-08-11T08:00:00Z");
const compact = (sql) => sql.replace(/\s+/g, " ").trim();
const value = { attemptId: uuid(1), jobId: uuid(2), providerId: uuid(3), usage: { inputTokens: 1, outputTokens: 2, imageRequests: 0, audioMilliseconds: 0, source: "provider_reported" }, accountingMode: "provider_reported", rates: { inputMicrounitsPerMillionTokens: 1, outputMicrounitsPerMillionTokens: 2, imageMicrounitsPerRequest: 0, audioMicrounitsPerMinute: 0 }, currency: "USD", totalMicrounits: 2, observedAt: NOW };
function row() { return { attempt_id: value.attemptId, job_id: value.jobId, provider_id: value.providerId, usage: { source: "provider_reported", audioMilliseconds: 0, imageRequests: 0, outputTokens: 2, inputTokens: 1 }, accounting_mode: value.accountingMode, rates: { audioMicrounitsPerMinute: 0, imageMicrounitsPerRequest: 0, outputMicrounitsPerMillionTokens: 2, inputMicrounitsPerMillionTokens: 1 }, currency: value.currency, total_microunits: String(value.totalMicrounits), observed_at: NOW }; }
class Database { queries = []; async query(sql, parameters = []) { this.queries.push({ sql: compact(sql), parameters }); return { rows: compact(sql).startsWith("SELECT") ? [row()] : [] }; } async transaction(operation) { return operation({ query: (sql, parameters = []) => this.query(sql, parameters) }); } }

test("PostgreSQL usage insert is idempotent and rechecks all immutable facts", async () => {
  const database = new Database();
  const result = await new PostgresExternalUsageRepository({ database }).record(value);
  assert.equal(result.totalMicrounits, 2);
  assert.ok(database.queries[0].sql.includes("ON CONFLICT (attempt_id) DO NOTHING"));
  assert.ok(database.queries[1].sql.includes("FOR SHARE"));
});

test("PostgreSQL usage repository requires transactions", () => {
  assert.throws(() => new PostgresExternalUsageRepository({ database: { query() {} } }), /query and transaction/);
});
