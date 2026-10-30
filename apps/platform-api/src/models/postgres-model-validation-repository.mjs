import { createHash } from "node:crypto";

function rows(result) { if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid"); return result.rows; }
function digestBytes(value) { if (!/^sha256:[a-f0-9]{64}$/.test(value ?? "")) throw new TypeError("SHA-256 value is invalid"); return Buffer.from(value.slice(7), "hex"); }
function digest(value) { if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw new TypeError("PostgreSQL SHA-256 value is invalid"); return `sha256:${Buffer.from(value).toString("hex")}`; }
function json(value) { return value === null ? null : (typeof value === "string" ? JSON.parse(value) : structuredClone(value)); }
function timestamp(value) { return value === null ? null : new Date(value).toISOString(); }
function tokenHash(value) { return createHash("sha256").update(value, "utf8").digest(); }
function mappedStage(row) {
  return {
    ordinal: Number(row.ordinal), stage: row.stage, specification: json(row.specification),
    state: row.state,
    claim: row.claimed_by_worker ? { workerId: row.claimed_by_worker, expiresAt: timestamp(row.claim_expires_at) } : null,
    result: json(row.result), createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
  };
}
function mappedRun(row, stages = []) {
  if (!row) return null;
  return {
    runId: row.id, plan: json(row.plan), fingerprint: digest(row.plan_fingerprint),
    state: row.state, requestedBy: row.requested_by, operationKey: row.operation_key,
    currentOrdinal: Number(row.current_ordinal), createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at), stages,
  };
}
function repositoryError(code, message) { const error = new Error(message); error.code = code; return error; }

export class PostgresModelValidationRepository {
  #database;
  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL transactional adapter is required");
    this.#database = database;
  }

  async #loadRun(database, runId, { lock = false } = {}) {
    const row = rows(await database.query(`
      SELECT * FROM compute.model_validation_runs WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`, [runId]))[0];
    if (!row) return null;
    const stages = rows(await database.query(`
      SELECT * FROM compute.model_validation_stages
      WHERE run_id = $1 ORDER BY ordinal`, [runId])).map(mappedStage);
    return mappedRun(row, stages);
  }

  async createRun({ plan, fingerprint, operationKey, requestedBy }) {
    return this.#database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [operationKey]);
      const previous = rows(await transaction.query(`
        SELECT run.* FROM compute.model_validation_operations operation
        JOIN compute.model_validation_runs run ON run.id = operation.run_id
        WHERE operation.operation_key = $1 FOR UPDATE OF run`, [operationKey]))[0];
      if (previous) {
        const run = await this.#loadRun(transaction, previous.id);
        if (run.fingerprint !== fingerprint) throw repositoryError("model_validation_conflict", "validation operation key has different immutable facts");
        return { run, created: false };
      }
      const existing = rows(await transaction.query(`
        SELECT * FROM compute.model_validation_runs
        WHERE plan_fingerprint = $1 FOR SHARE`, [digestBytes(fingerprint)]))[0];
      if (existing) {
        await transaction.query(`
          INSERT INTO compute.model_validation_operations (
            operation_key, run_id, plan_fingerprint
          ) VALUES ($1,$2,$3)`, [operationKey, existing.id, digestBytes(fingerprint)]);
        return { run: await this.#loadRun(transaction, existing.id), created: false };
      }
      const inserted = rows(await transaction.query(`
        INSERT INTO compute.model_validation_runs (
          run_key, plan_fingerprint, profile_key, build_job_id,
          deployment_job_id, plan, requested_by, operation_key
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
        RETURNING *`, [
        plan.runKey, digestBytes(fingerprint), plan.profile.profileKey,
        plan.build.jobId, plan.deployment.jobId, JSON.stringify(plan), requestedBy, operationKey,
      ]))[0];
      await transaction.query(`
        INSERT INTO compute.model_validation_stages (
          run_id, ordinal, stage, specification, state
        )
        SELECT $1, item.ordinality - 1, item.value ->> 'stage', item.value,
               CASE WHEN item.ordinality = 1 THEN 'queued' ELSE 'pending' END
        FROM jsonb_array_elements($2::jsonb -> 'stages') WITH ORDINALITY AS item(value, ordinality)`, [inserted.id, JSON.stringify(plan)]);
      await transaction.query(`
        INSERT INTO compute.model_validation_operations (
          operation_key, run_id, plan_fingerprint
        ) VALUES ($1,$2,$3)`, [operationKey, inserted.id, digestBytes(fingerprint)]);
      return { run: await this.#loadRun(transaction, inserted.id), created: true };
    });
  }

  async getRun(runId) { return this.#loadRun(this.#database, runId); }

  async claimNextStage({ runId, workerId, claimToken, expiresAt }) {
    return this.#database.transaction(async (transaction) => {
      const row = rows(await transaction.query(`
        UPDATE compute.model_validation_stages stage
        SET state = 'running', claimed_by_worker = $2, claim_token_sha256 = $3,
            claim_expires_at = $4, updated_at = clock_timestamp()
        FROM compute.model_validation_runs run
        WHERE run.id = $1 AND run.state = 'validating'
          AND stage.run_id = run.id AND stage.ordinal = run.current_ordinal
          AND stage.state = 'queued'
        RETURNING stage.*`, [runId, workerId, tokenHash(claimToken), expiresAt]))[0];
      if (!row) throw repositoryError("model_validation_not_claimable", "model validation stage is not claimable");
      return { run: await this.#loadRun(transaction, runId), stage: mappedStage(row) };
    });
  }

  async verifyStageClaim({ runId, ordinal, workerId, claimToken }) {
    return Boolean(rows(await this.#database.query(`
      SELECT 1 FROM compute.model_validation_stages stage
      JOIN compute.model_validation_runs run ON run.id = stage.run_id
      WHERE stage.run_id = $1 AND stage.ordinal = $2 AND stage.state = 'running'
        AND run.state = 'validating' AND run.current_ordinal = stage.ordinal
        AND stage.claimed_by_worker = $3 AND stage.claim_token_sha256 = $4
        AND stage.claim_expires_at > clock_timestamp()`, [runId, ordinal, workerId, tokenHash(claimToken)]))[0]);
  }

  async completeStage({ runId, ordinal, workerId, claimToken, result }) {
    return this.#database.transaction(async (transaction) => {
      await transaction.query(`
        SELECT compute.complete_model_validation_stage($1,$2::smallint,$3,$4,$5::jsonb)`, [
        runId, ordinal, workerId, tokenHash(claimToken), JSON.stringify(result),
      ]);
      const run = await this.#loadRun(transaction, runId);
      if (!run) throw repositoryError("model_validation_not_found", "model validation run was not found");
      return { run, stage: run.stages[ordinal] };
    });
  }
}
