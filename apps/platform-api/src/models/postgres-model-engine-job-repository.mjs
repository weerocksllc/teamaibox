import { createHash } from "node:crypto";

function rows(result) { if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid"); return result.rows; }
function digestBytes(value) { if (!/^sha256:[a-f0-9]{64}$/.test(value ?? "")) throw new TypeError("SHA-256 value is invalid"); return Buffer.from(value.slice(7), "hex"); }
function digest(value) { if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw new TypeError("PostgreSQL SHA-256 value is invalid"); return `sha256:${Buffer.from(value).toString("hex")}`; }
function json(value) { return value === null ? null : (typeof value === "string" ? JSON.parse(value) : structuredClone(value)); }
function timestamp(value) { return value === null ? null : new Date(value).toISOString(); }
function tokenHash(value) { return createHash("sha256").update(value, "utf8").digest(); }
function mapped(row, jobKind) {
  if (!row) return null;
  return {
    jobId: row.id, jobKind,
    specification: json(row.specification), fingerprint: digest(row.specification_fingerprint),
    state: row.state, requestedBy: row.requested_by, operationKey: row.operation_key,
    claim: row.claimed_by_worker ? { workerId: row.claimed_by_worker, expiresAt: timestamp(row.claim_expires_at) } : null,
    result: json(row.result), errorCode: row.error_code,
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
  };
}
const mappedBuild = (row) => mapped(row, "engine-build");
const mappedDeployment = (row) => mapped(row, "engine-deployment");
function repositoryError(code, message) { const error = new Error(message); error.code = code; return error; }

export class PostgresModelEngineJobRepository {
  #database;

  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL transactional adapter is required");
    this.#database = database;
  }

  async #enqueue({ table, keyColumn, key, jobKind, specification, fingerprint, operationKey, requestedBy }) {
    return this.#database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [operationKey]);
      const mapper = jobKind === "engine-build" ? mappedBuild : mappedDeployment;
      const operationTable = jobKind === "engine-build" ? "model_engine_build_operations" : "model_engine_deployment_operations";
      const operationJobColumn = jobKind === "engine-build" ? "build_job_id" : "deployment_job_id";
      const previous = mapper(rows(await transaction.query(`
        SELECT job.* FROM compute.${operationTable} operation
        JOIN compute.${table} job ON job.id = operation.${operationJobColumn}
        WHERE operation.operation_key = $1 FOR UPDATE OF job`, [operationKey]))[0]);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw repositoryError("model_engine_job_conflict", "operation key has different immutable model engine facts");
        return { job: previous, created: false };
      }
      const existing = mapper(rows(await transaction.query(`
        SELECT * FROM compute.${table}
        WHERE specification_fingerprint = $1 FOR SHARE`, [digestBytes(fingerprint)]))[0]);
      if (existing) {
        await transaction.query(`
          INSERT INTO compute.${operationTable} (
            operation_key, ${operationJobColumn}, specification_fingerprint
          ) VALUES ($1,$2,$3)`, [operationKey, existing.jobId, digestBytes(fingerprint)]);
        return { job: existing, created: false };
      }
      const columns = jobKind === "engine-build"
        ? `${keyColumn}, specification_fingerprint, specification, requested_by, operation_key`
        : `${keyColumn}, build_job_id, specification_fingerprint, specification, requested_by, operation_key`;
      const parameters = jobKind === "engine-build"
        ? [key, digestBytes(fingerprint), JSON.stringify(specification), requestedBy, operationKey]
        : [key, specification.buildJobId, digestBytes(fingerprint), JSON.stringify(specification), requestedBy, operationKey];
      const placeholders = jobKind === "engine-build" ? "$1,$2,$3::jsonb,$4,$5" : "$1,$2,$3,$4::jsonb,$5,$6";
      const inserted = rows(await transaction.query(`
        INSERT INTO compute.${table} (${columns}) VALUES (${placeholders}) RETURNING *`, parameters))[0];
      await transaction.query(`
        INSERT INTO compute.${operationTable} (
          operation_key, ${operationJobColumn}, specification_fingerprint
        ) VALUES ($1,$2,$3)`, [operationKey, inserted.id, digestBytes(fingerprint)]);
      return { job: mapper(inserted), created: true };
    });
  }

  async enqueueBuild(input) {
    return this.#enqueue({
      ...input, table: "model_engine_build_jobs", keyColumn: "build_key",
      key: input.specification.buildKey, jobKind: "engine-build",
    });
  }

  async getBuild(jobId) {
    return mappedBuild(rows(await this.#database.query(`
      SELECT * FROM compute.model_engine_build_jobs WHERE id = $1`, [jobId]))[0]);
  }

  async claimBuild({ jobId, workerId, claimToken, expiresAt }) {
    const claimed = mappedBuild(rows(await this.#database.query(`
      UPDATE compute.model_engine_build_jobs
      SET state = 'running', claimed_by_worker = $2, claim_token_sha256 = $3,
          claim_expires_at = $4, updated_at = clock_timestamp()
      WHERE id = $1 AND state = 'queued' RETURNING *`, [jobId, workerId, tokenHash(claimToken), expiresAt]))[0]);
    if (!claimed) throw repositoryError("model_engine_job_not_claimable", "model engine build job is not claimable");
    return claimed;
  }

  async verifyBuildClaim({ jobId, workerId, claimToken }) {
    return Boolean(rows(await this.#database.query(`
      SELECT 1 FROM compute.model_engine_build_jobs
      WHERE id = $1 AND state = 'running' AND claimed_by_worker = $2
        AND claim_token_sha256 = $3 AND claim_expires_at > clock_timestamp()`, [jobId, workerId, tokenHash(claimToken)]))[0]);
  }

  async completeBuild({ jobId, workerId, claimToken, result }) {
    const completed = mappedBuild(rows(await this.#database.query(`
      UPDATE compute.model_engine_build_jobs
      SET state = 'succeeded', claimed_by_worker = NULL, claim_token_sha256 = NULL,
          claim_expires_at = NULL, result = $4::jsonb, updated_at = clock_timestamp()
      WHERE id = $1 AND state = 'running' AND claimed_by_worker = $2
        AND claim_token_sha256 = $3 AND claim_expires_at > clock_timestamp()
      RETURNING *`, [jobId, workerId, tokenHash(claimToken), JSON.stringify(result)]))[0]);
    if (!completed) throw repositoryError("model_engine_job_fenced", "model engine build completion is fenced");
    return completed;
  }

  async failBuild({ jobId, workerId, claimToken, errorCode }) {
    const failed = mappedBuild(rows(await this.#database.query(`
      UPDATE compute.model_engine_build_jobs
      SET state = 'failed', claimed_by_worker = NULL, claim_token_sha256 = NULL,
          claim_expires_at = NULL, error_code = $4, updated_at = clock_timestamp()
      WHERE id = $1 AND state = 'running' AND claimed_by_worker = $2
        AND claim_token_sha256 = $3 AND claim_expires_at > clock_timestamp()
      RETURNING *`, [jobId, workerId, tokenHash(claimToken), errorCode]))[0]);
    if (!failed) throw repositoryError("model_engine_job_fenced", "model engine build failure is fenced");
    return failed;
  }

  async enqueueDeployment(input) {
    return this.#enqueue({
      ...input, table: "model_engine_deployment_jobs", keyColumn: "deployment_key",
      key: input.specification.deploymentKey, jobKind: "engine-deployment",
    });
  }

  async getDeployment(jobId) {
    return mappedDeployment(rows(await this.#database.query(`
      SELECT * FROM compute.model_engine_deployment_jobs WHERE id = $1`, [jobId]))[0]);
  }

  async claimDeployment({ jobId, workerId, claimToken, expiresAt }) {
    const claimed = mappedDeployment(rows(await this.#database.query(`
      UPDATE compute.model_engine_deployment_jobs
      SET state = 'running', claimed_by_worker = $2, claim_token_sha256 = $3,
          claim_expires_at = $4, updated_at = clock_timestamp()
      WHERE id = $1 AND state = 'queued' RETURNING *`, [jobId, workerId, tokenHash(claimToken), expiresAt]))[0]);
    if (!claimed) throw repositoryError("model_engine_job_not_claimable", "model engine deployment job is not claimable");
    return claimed;
  }

  async verifyDeploymentClaim({ jobId, workerId, claimToken }) {
    return Boolean(rows(await this.#database.query(`
      SELECT 1 FROM compute.model_engine_deployment_jobs
      WHERE id = $1 AND state = 'running' AND claimed_by_worker = $2
        AND claim_token_sha256 = $3 AND claim_expires_at > clock_timestamp()`, [jobId, workerId, tokenHash(claimToken)]))[0]);
  }

  async completeDeployment({ jobId, workerId, claimToken, result }) {
    const completed = mappedDeployment(rows(await this.#database.query(`
      UPDATE compute.model_engine_deployment_jobs
      SET state = 'succeeded', claimed_by_worker = NULL, claim_token_sha256 = NULL,
          claim_expires_at = NULL, result = $4::jsonb, updated_at = clock_timestamp()
      WHERE id = $1 AND state = 'running' AND claimed_by_worker = $2
        AND claim_token_sha256 = $3 AND claim_expires_at > clock_timestamp()
      RETURNING *`, [jobId, workerId, tokenHash(claimToken), JSON.stringify(result)]))[0]);
    if (!completed) throw repositoryError("model_engine_job_fenced", "model engine deployment completion is fenced");
    return completed;
  }

  async failDeployment({ jobId, workerId, claimToken, errorCode }) {
    const failed = mappedDeployment(rows(await this.#database.query(`
      UPDATE compute.model_engine_deployment_jobs
      SET state = 'failed', claimed_by_worker = NULL, claim_token_sha256 = NULL,
          claim_expires_at = NULL, error_code = $4, updated_at = clock_timestamp()
      WHERE id = $1 AND state = 'running' AND claimed_by_worker = $2
        AND claim_token_sha256 = $3 AND claim_expires_at > clock_timestamp()
      RETURNING *`, [jobId, workerId, tokenHash(claimToken), errorCode]))[0]);
    if (!failed) throw repositoryError("model_engine_job_fenced", "model engine deployment failure is fenced");
    return failed;
  }
}
