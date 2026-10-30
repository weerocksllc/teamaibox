import { Buffer } from "node:buffer";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid");
  return result.rows;
}

function date(value) {
  return value === null || value === undefined ? null : new Date(value);
}

function operation(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerIdentityId: row.owner_identity_id,
    bindingId: row.binding_id,
    promptId: row.prompt_id,
    upstreamRequestId: row.upstream_request_id,
    actionKind: row.operation_kind,
    tool: row.tool_name,
    titleKey: row.title_key,
    actionScope: structuredClone(row.operation_scope),
    actionDigest: `sha256:${Buffer.from(row.action_digest).toString("hex")}`,
    sideEffectClass: row.side_effect_class,
    policyId: row.policy_id,
    policyRevision: Number(row.policy_revision),
    policyDisposition: row.policy_disposition,
    status: row.status,
    lifecycleState: row.lifecycle_state,
    upstreamReplyState: row.upstream_reply_state,
    executionBoundary: row.execution_boundary,
    decisionKind: row.decision_kind,
    decisionActorIdentityId: row.decided_by_identity_id,
    authenticationEventId: row.authentication_event_id,
    authenticationProofDigest: row.authentication_proof_digest ? `sha256:${Buffer.from(row.authentication_proof_digest).toString("hex")}` : null,
    authenticatedAt: date(row.authenticated_at),
    reconciliationOutcome: row.reconciliation_outcome,
    reconciliationReasonCode: row.reconciliation_reason_code,
    resultDigest: row.result_digest ? `sha256:${Buffer.from(row.result_digest).toString("hex")}` : null,
    revision: Number(row.revision),
    createdAt: date(row.created_at),
    expiresAt: date(row.expires_at),
    decidedAt: date(row.decided_at),
    updatedAt: date(row.updated_at),
  };
}

const RETURNING = " RETURNING *";

export class PostgresOperationConfirmationRepository {
  #database;

  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL operation confirmation database with transactions is required");
    this.#database = database;
  }

  async insertOperation(value) {
    return this.#database.transaction(async (transaction) => {
      const inserted = rows(await transaction.query(`
        INSERT INTO platform.agent_operation_confirmations (
          id, owner_identity_id, agent_session_key, operation_kind, title_key,
          operation_scope, status, created_at, expires_at, binding_id, prompt_id,
          upstream_request_id, tool_name, action_digest, side_effect_class,
          policy_id, policy_revision, policy_disposition, lifecycle_state,
          upstream_reply_state, execution_boundary, revision, updated_at,
          bridge_schema_version
        ) SELECT
          $1,$2,$3,$4,$5,$6::jsonb,'pending',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
          'pending','none','none',1,$7,1
        FROM platform.agent_session_bindings b
        JOIN platform.agent_prompts p ON p.id = $10 AND p.binding_id = b.id
        WHERE b.id = $9 AND b.owner_identity_id = $2
        ON CONFLICT (binding_id, upstream_request_id) WHERE bridge_schema_version = 1 DO NOTHING
        RETURNING *`, [
        value.id, value.ownerIdentityId, value.bindingId, value.actionKind, value.titleKey,
        JSON.stringify(value.actionScope), value.createdAt, value.expiresAt, value.bindingId,
        value.promptId, value.upstreamRequestId, value.tool,
        Buffer.from(value.actionDigest.slice(7), "hex"), value.sideEffectClass,
        value.policyId, value.policyRevision, value.policyDisposition,
      ]));
      if (inserted.length > 0) return { inserted: true, operation: operation(inserted[0]) };
      const existing = operation(rows(await transaction.query(`
        SELECT * FROM platform.agent_operation_confirmations
        WHERE binding_id = $1 AND upstream_request_id = $2 AND bridge_schema_version = 1
        FOR UPDATE`, [value.bindingId, value.upstreamRequestId]))[0]);
      return existing ? { inserted: false, operation: existing } : null;
    });
  }

  async findOwnedOperation(operationId, ownerIdentityId) {
    return operation(rows(await this.#database.query(`
      SELECT * FROM platform.agent_operation_confirmations
      WHERE id = $1 AND owner_identity_id = $2 AND bridge_schema_version = 1`, [operationId, ownerIdentityId]))[0]);
  }

  async findOperation(operationId) {
    return operation(rows(await this.#database.query(`
      SELECT * FROM platform.agent_operation_confirmations
      WHERE id = $1 AND bridge_schema_version = 1`, [operationId]))[0]);
  }

  async updateOperation(value, expectedRevision) {
    const result = rows(await this.#database.query(`
      UPDATE platform.agent_operation_confirmations
      SET status = $3, lifecycle_state = $4, upstream_reply_state = $5,
          execution_boundary = $6, decision_kind = $7, decided_at = $8,
          decided_by_identity_id = $9, authentication_event_id = $10,
          authentication_proof_digest = $11, authenticated_at = $12,
          reconciliation_outcome = $13, reconciliation_reason_code = $14,
          result_digest = $15, revision = $16, updated_at = $17
      WHERE id = $1 AND revision = $2 AND bridge_schema_version = 1${RETURNING}`, [
      value.id, expectedRevision, value.status, value.lifecycleState, value.upstreamReplyState,
      value.executionBoundary, value.decisionKind, value.decidedAt,
      value.decisionActorIdentityId, value.authenticationEventId,
      value.authenticationProofDigest ? Buffer.from(value.authenticationProofDigest.slice(7), "hex") : null,
      value.authenticatedAt, value.reconciliationOutcome, value.reconciliationReasonCode,
      value.resultDigest ? Buffer.from(value.resultDigest.slice(7), "hex") : null,
      value.revision, value.updatedAt,
    ]));
    if (result.length === 0) {
      const exists = rows(await this.#database.query(
        "SELECT 1 FROM platform.agent_operation_confirmations WHERE id = $1 AND bridge_schema_version = 1",
        [value.id],
      )).length > 0;
      if (exists) throw new PlatformError("agent_operation_revision_conflict", "Agent operation changed concurrently", { status: 409, retryable: true });
      return null;
    }
    return operation(result[0]);
  }

  async claimExpired({ now, limit }) {
    return this.#database.transaction(async (transaction) => rows(await transaction.query(`
      WITH candidates AS (
        SELECT id FROM platform.agent_operation_confirmations
        WHERE bridge_schema_version = 1 AND lifecycle_state = 'pending' AND expires_at <= $1
        ORDER BY expires_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
      )
      UPDATE platform.agent_operation_confirmations c
      SET status = 'expired', lifecycle_state = 'timed_out', decision_kind = 'timeout',
          decided_at = $1, revision = c.revision + 1, updated_at = $1
      FROM candidates WHERE c.id = candidates.id RETURNING c.*`, [now, limit])).map(operation));
  }

  async markBindingUncertain({ bindingId, reasonCode, now }) {
    return rows(await this.#database.query(`
      UPDATE platform.agent_operation_confirmations
      SET lifecycle_state = CASE WHEN decision_kind IN ('approve','policy_allow') THEN 'reconcile_required' ELSE 'interrupted' END,
          execution_boundary = CASE WHEN decision_kind IN ('approve','policy_allow') AND execution_boundary = 'none' THEN 'unknown' ELSE execution_boundary END,
          upstream_reply_state = CASE WHEN upstream_reply_state = 'accepted' THEN 'accepted' ELSE 'unknown' END,
          reconciliation_reason_code = CASE WHEN decision_kind IN ('approve','policy_allow') THEN $2 ELSE NULL END,
          revision = revision + 1, updated_at = $3
      WHERE bridge_schema_version = 1 AND binding_id = $1
        AND lifecycle_state IN ('dispatching','approved','executing')
        AND decision_kind IN ('approve','policy_allow','deny','policy_deny')${RETURNING}`, [bindingId, reasonCode, now])).map(operation);
  }
}
