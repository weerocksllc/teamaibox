import { createHash } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

const RUN_ID = /^protected-office-set-deployment(?:-v5)?-[0-9]{8}-a[1-9][0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{2,127}$/;
const SENSITIVE_KEY = /(password|secret|token|private.?key|authorization|cookie|prompt|transcript|image.?bytes|audio.?bytes)/i;
const ACTIONS = new Set([
  "preflight", "cold-boot", "concurrent-office", "bounded-maintenance",
  "restart-verify", "mid-sequence-failure", "final-inspect", "recover", "cleanup",
]);
const TERMINAL = new Set(["succeeded", "failed"]);
const MAXIMUM_RESULT_BYTES = 4 * 1024 * 1024;

function copy(value) { return value == null ? null : structuredClone(value); }
function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL protected deployment action result is invalid");
  return result.rows;
}
function digest(value) { return value == null ? null : `sha256:${Buffer.from(value).toString("hex")}`; }
function digestBytes(value, name) {
  if (!SHA256.test(value ?? "")) throw new TypeError(`${name} must be lowercase SHA-256`);
  return Buffer.from(value.slice(7), "hex");
}
function instant(value, name) {
  const result = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new TypeError(`${name} is invalid`);
  return result;
}
function revision(value, name = "expectedRevision") {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}
function json(value) { return value == null ? null : typeof value === "string" ? JSON.parse(value) : copy(value); }

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("protected deployment result contains an unsafe number");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("protected deployment result is not canonical JSON");
}

function assertRedacted(value, path = "result") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertRedacted(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new TypeError(`protected deployment action contains a sensitive field at ${path}.${key}`);
    assertRedacted(child, `${path}.${key}`);
  }
}

function boundedResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("protected deployment action result must be an object");
  }
  assertRedacted(value);
  const encoded = Buffer.from(canonicalJson(value), "utf8");
  if (encoded.byteLength < 2 || encoded.byteLength > MAXIMUM_RESULT_BYTES) {
    throw new TypeError("protected deployment action result is outside its bounded envelope");
  }
  return { value: copy(value), encoded };
}

export function protectedOfficeDeploymentResultDigest(value) {
  const { encoded } = boundedResult(value);
  return `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
}

function mapped(row) {
  if (!row) return null;
  return Object.freeze({
    runId: row.run_id,
    action: row.action,
    actionId: row.action_id,
    idempotencyKey: digest(row.idempotency_key),
    requestDigest: digest(row.request_digest),
    revision: Number(row.revision),
    state: row.action_state,
    recoveryCount: Number(row.recovery_count),
    resultDigest: digest(row.result_digest),
    result: json(row.result),
    failureCode: row.failure_code,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    persistedAt: row.persisted_at == null ? null : new Date(row.persisted_at),
  });
}

function conflict(code, message, retryable = true) {
  throw new PlatformError(code, message, { status: 409, retryable });
}

function translate(error) {
  if (error instanceof PlatformError || error instanceof TypeError) throw error;
  if (error?.code === "23505") conflict("protected_deployment_action_conflict", "Protected deployment action identity already exists");
  if (error?.code === "23514" && /terminal protected deployment action/.test(error.message ?? "")) {
    conflict("protected_deployment_action_terminal", "Terminal protected deployment action cannot change", false);
  }
  if (error?.code === "23514" && /revision is stale/.test(error.message ?? "")) {
    conflict("protected_deployment_action_revision_conflict", "Protected deployment action journal changed");
  }
  if (["23514", "22P02", "22007", "22008"].includes(error?.code)) {
    throw new PlatformError("protected_deployment_action_persistence_invalid",
      "Protected deployment action persistence violates its fail-closed envelope", { status: 409 });
  }
  throw error;
}

function identity(value) {
  if (!value || !RUN_ID.test(value.runId ?? "") || !ACTIONS.has(value.action)
      || !UUID.test(value.actionId ?? "") || !SHA256.test(value.idempotencyKey ?? "")
      || !SHA256.test(value.requestDigest ?? "")) {
    throw new TypeError("protected deployment action identity is invalid");
  }
  return value;
}

async function locked(database, runId, action) {
  return mapped(rows(await database.query(`
    SELECT * FROM compute.protected_office_deployment_actions
    WHERE run_id=$1 AND action=$2 FOR UPDATE`, [runId, action]))[0]);
}

function assertSameIdentity(current, value) {
  if (current.actionId !== value.actionId || current.idempotencyKey !== value.idempotencyKey
      || current.requestDigest !== value.requestDigest) {
    conflict("protected_deployment_action_idempotency_conflict",
      "Protected deployment action idempotency key was reused with different immutable facts", false);
  }
}

export class PostgresProtectedOfficeDeploymentActionRepository {
  #database;
  constructor({ database }) {
    if (!database?.query || !database?.transaction) {
      throw new TypeError("PostgreSQL protected deployment action repository requires a transactional adapter");
    }
    this.#database = database;
  }

  async beginAction(input) {
    const value = identity(input);
    const createdAt = instant(value.createdAt, "createdAt");
    try {
      return await this.#database.transaction(async (database) => {
        const inserted = rows(await database.query(`
          INSERT INTO compute.protected_office_deployment_actions (
            run_id,action,action_id,idempotency_key,request_digest,revision,
            action_state,recovery_count,result_digest,result,failure_code,
            created_at,updated_at,persisted_at
          ) VALUES ($1,$2,$3,$4,$5,1,'running',0,NULL,NULL,NULL,$6,$6,NULL)
          ON CONFLICT (run_id,action) DO NOTHING
          RETURNING run_id`, [
          value.runId, value.action, value.actionId,
          digestBytes(value.idempotencyKey, "idempotencyKey"),
          digestBytes(value.requestDigest, "requestDigest"), createdAt,
        ]));
        const current = await locked(database, value.runId, value.action);
        if (!current) throw new PlatformError("protected_deployment_action_missing",
          "Protected deployment action journal disappeared", { status: 503, retryable: false });
        assertSameIdentity(current, value);
        return Object.freeze({ ...current, created: inserted.length === 1 });
      });
    } catch (error) { translate(error); }
  }

  async getAction(runId, action) {
    if (!RUN_ID.test(runId ?? "") || !ACTIONS.has(action)) throw new TypeError("protected deployment action lookup is invalid");
    return mapped(rows(await this.#database.query(`
      SELECT * FROM compute.protected_office_deployment_actions WHERE run_id=$1 AND action=$2`,
    [runId, action]))[0]);
  }

  async listIncompleteActions({ runId = null } = {}) {
    if (runId != null && !RUN_ID.test(runId)) throw new TypeError("protected deployment run identity is invalid");
    const result = runId == null
      ? await this.#database.query(`SELECT * FROM compute.protected_office_deployment_actions
          WHERE action_state IN ('running','recovering') ORDER BY created_at,run_id,action`)
      : await this.#database.query(`SELECT * FROM compute.protected_office_deployment_actions
          WHERE run_id=$1 AND action_state IN ('running','recovering') ORDER BY created_at,action`, [runId]);
    return rows(result).map(mapped);
  }

  async #transition(runId, action, expectedRevision, { from, state, updatedAt, result = null,
    resultDigest = null, failureCode = null, recovering = false, terminal = false }) {
    if (!RUN_ID.test(runId ?? "") || !ACTIONS.has(action)) throw new TypeError("protected deployment action transition is invalid");
    revision(expectedRevision);
    const at = instant(updatedAt, "updatedAt");
    let savedResult = null;
    if (result != null) {
      const bounded = boundedResult(result);
      savedResult = bounded.value;
      const calculated = `sha256:${createHash("sha256").update(bounded.encoded).digest("hex")}`;
      if (resultDigest !== calculated) throw new TypeError("protected deployment action result digest drifted");
    } else if (resultDigest != null) {
      throw new TypeError("protected deployment action result is missing");
    }
    if (failureCode != null && !ERROR_CODE.test(failureCode)) throw new TypeError("protected deployment action failure code is invalid");
    try {
      return await this.#database.transaction(async (database) => {
        const current = await locked(database, runId, action);
        if (!current) return null;
        if (current.revision !== expectedRevision) {
          conflict("protected_deployment_action_revision_conflict", "Protected deployment action journal changed");
        }
        if (!from.includes(current.state)) {
          conflict(TERMINAL.has(current.state) ? "protected_deployment_action_terminal" : "protected_deployment_action_state_conflict",
            TERMINAL.has(current.state) ? "Terminal protected deployment action cannot change" : "Protected deployment action state changed",
            !TERMINAL.has(current.state));
        }
        const row = rows(await database.query(`
          UPDATE compute.protected_office_deployment_actions
          SET revision=revision+1,action_state=$4,
              recovery_count=recovery_count+$5,result_digest=$6,result=$7::jsonb,
              failure_code=$8,updated_at=$9,persisted_at=$10
          WHERE run_id=$1 AND action=$2 AND revision=$3 RETURNING *`, [
          runId, action, expectedRevision, state, recovering ? 1 : 0,
          resultDigest == null ? null : digestBytes(resultDigest, "resultDigest"),
          savedResult == null ? null : JSON.stringify(savedResult), failureCode, at, terminal ? at : null,
        ]))[0];
        if (!row) conflict("protected_deployment_action_revision_conflict", "Protected deployment action journal changed");
        return mapped(row);
      });
    } catch (error) { translate(error); }
  }

  markRecovering(runId, action, expectedRevision, { updatedAt }) {
    return this.#transition(runId, action, expectedRevision, {
      from: ["running"], state: "recovering", updatedAt, recovering: true,
    });
  }

  resumeAction(runId, action, expectedRevision, { updatedAt }) {
    return this.#transition(runId, action, expectedRevision, {
      from: ["recovering"], state: "running", updatedAt,
    });
  }

  completeAction(runId, action, expectedRevision, { result, resultDigest, persistedAt }) {
    return this.#transition(runId, action, expectedRevision, {
      from: ["running", "recovering"], state: "succeeded", updatedAt: persistedAt,
      result, resultDigest, terminal: true,
    });
  }

  failAction(runId, action, expectedRevision, { failureCode, persistedAt }) {
    return this.#transition(runId, action, expectedRevision, {
      from: ["running", "recovering"], state: "failed", updatedAt: persistedAt,
      failureCode, terminal: true,
    });
  }
}

export function protectedOfficeDeploymentActionProof(value) {
  if (!value || value.state !== "succeeded" || !value.persistedAt || !SHA256.test(value.resultDigest ?? "")) {
    throw new TypeError("successful protected deployment action journal is required");
  }
  return Object.freeze({
    runId: value.runId,
    action: value.action,
    actionId: value.actionId,
    idempotencyKey: value.idempotencyKey,
    revision: value.revision,
    state: value.state,
    resultDigest: value.resultDigest,
    persistedAt: value.persistedAt.toISOString(),
  });
}
