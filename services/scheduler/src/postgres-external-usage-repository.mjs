import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { isDeepStrictEqual } from "node:util";

function rows(result) { if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid"); return result.rows; }
function json(value) { return typeof value === "string" ? JSON.parse(value) : structuredClone(value); }
function mapped(row) { return row ? { attemptId: row.attempt_id, jobId: row.job_id, providerId: row.provider_id, usage: json(row.usage), accountingMode: row.accounting_mode, rates: json(row.rates), currency: row.currency, totalMicrounits: row.total_microunits == null ? null : Number(row.total_microunits), observedAt: new Date(row.observed_at) } : null; }
function same(left, right) { return left.jobId === right.jobId && left.providerId === right.providerId && left.accountingMode === right.accountingMode && left.currency === right.currency && left.totalMicrounits === right.totalMicrounits && new Date(left.observedAt).getTime() === new Date(right.observedAt).getTime() && isDeepStrictEqual(left.usage, right.usage) && isDeepStrictEqual(left.rates, right.rates); }

export class PostgresExternalUsageRepository {
  #database;
  constructor({ database }) { if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL database adapter with query and transaction is required"); this.#database = database; }
  async record(value) { return this.#database.transaction(async (transaction) => {
    await transaction.query(`INSERT INTO compute.external_attempt_accounting (attempt_id,job_id,provider_id,usage,accounting_mode,rates,currency,total_microunits,observed_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8,$9) ON CONFLICT (attempt_id) DO NOTHING`, [value.attemptId, value.jobId, value.providerId, JSON.stringify(value.usage), value.accountingMode, JSON.stringify(value.rates), value.currency, value.totalMicrounits, value.observedAt]);
    const result = mapped(rows(await transaction.query(`SELECT * FROM compute.external_attempt_accounting WHERE attempt_id=$1 FOR SHARE`, [value.attemptId]))[0]);
    if (!result || !same(result, value)) throw new PlatformError("external_usage_conflict", "External usage already has different facts", { status: 409 });
    return result;
  }); }
  async findByAttempt(attemptId) { return mapped(rows(await this.#database.query(`SELECT * FROM compute.external_attempt_accounting WHERE attempt_id=$1`, [attemptId]))[0]); }
}
