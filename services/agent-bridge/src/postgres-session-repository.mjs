import { Buffer } from "node:buffer";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid");
  return result.rows;
}

function date(value) {
  return value === null || value === undefined ? null : new Date(value);
}

function json(value) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? JSON.parse(value) : structuredClone(value);
}

function sha256(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw new TypeError("PostgreSQL SHA-256 value is invalid");
  return `sha256:${Buffer.from(value).toString("hex")}`;
}

function binding(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerIdentityId: row.owner_identity_id,
    platformConversationId: row.platform_conversation_id,
    workspaceKey: row.workspace_key,
    sandboxKey: row.sandbox_key,
    adapterKey: row.adapter_key,
    upstreamVersion: row.upstream_version,
    upstreamArtifactDigest: sha256(row.upstream_artifact_digest),
    opencodeSessionId: row.opencode_session_id,
    state: row.state,
    crashGeneration: Number(row.crash_generation),
    eventTailSequence: Number(row.event_tail_sequence),
    terminal: json(row.terminal),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    reconciledAt: date(row.reconciled_at),
  };
}

function prompt(row) {
  if (!row) return null;
  return {
    id: row.id,
    bindingId: row.binding_id,
    platformRunId: row.platform_run_id,
    idempotencyKey: row.idempotency_key,
    requestDigest: sha256(row.request_digest),
    opencodeMessageId: row.opencode_message_id,
    status: row.status,
    acceptanceBoundary: row.acceptance_boundary,
    terminal: json(row.terminal),
    revision: Number(row.revision),
    createdAt: date(row.created_at),
    submittedAt: date(row.submitted_at),
    acceptedAt: date(row.accepted_at),
    completedAt: date(row.completed_at),
    updatedAt: date(row.updated_at),
  };
}

function event(row) {
  if (!row) return null;
  return {
    id: row.event_id,
    bindingId: row.binding_id,
    promptId: row.prompt_id,
    sequence: Number(row.sequence),
    connectionId: row.connection_id,
    connectionOrdinal: Number(row.connection_ordinal),
    upstreamEventId: row.upstream_event_id,
    eventType: row.event_type,
    eventData: json(row.event_data),
    createdAt: date(row.created_at),
  };
}

function reconciliation(row) {
  if (!row) return null;
  return {
    id: row.id,
    bindingId: row.binding_id,
    crashGeneration: Number(row.crash_generation),
    state: row.state,
    reasonCode: row.reason_code,
    upstreamSessionExists: row.upstream_session_exists,
    acceptedMessageIds: json(row.accepted_message_ids),
    outcome: json(row.outcome),
    createdAt: date(row.created_at),
    resolvedAt: date(row.resolved_at),
  };
}

async function selectBinding(executor, clause, values, lock = false) {
  const result = await executor.query(`SELECT * FROM platform.agent_session_bindings WHERE ${clause}${lock ? " FOR UPDATE" : ""}`, values);
  return binding(rows(result)[0]);
}

async function selectPrompt(executor, promptId, lock = false) {
  const result = await executor.query(`SELECT * FROM platform.agent_prompts WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [promptId]);
  return prompt(rows(result)[0]);
}

async function listPrompts(executor, bindingId, lock = false) {
  const result = await executor.query(`SELECT * FROM platform.agent_prompts WHERE binding_id = $1 ORDER BY created_at, id${lock ? " FOR UPDATE" : ""}`, [bindingId]);
  return rows(result).map(prompt);
}

async function writePrompt(executor, value, expectedRevision) {
  const result = await executor.query(`
    UPDATE platform.agent_prompts
    SET status = $3,
        acceptance_boundary = $4,
        terminal = $5::jsonb,
        revision = $6,
        submitted_at = $7,
        accepted_at = $8,
        completed_at = $9,
        updated_at = $10
    WHERE id = $1 AND revision = $2
    RETURNING *`, [
    value.id,
    expectedRevision,
    value.status,
    value.acceptanceBoundary,
    value.terminal ? JSON.stringify(value.terminal) : null,
    value.revision,
    value.submittedAt,
    value.acceptedAt,
    value.completedAt,
    value.updatedAt,
  ]);
  return prompt(rows(result)[0]);
}

export class PostgresAgentSessionRepository {
  #database;

  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL database adapter with transactions is required");
    this.#database = database;
  }

  async insertBinding(value) {
    return this.#database.transaction(async (transaction) => {
      const inserted = rows(await transaction.query(`
        INSERT INTO platform.agent_session_bindings (
          id, owner_identity_id, platform_conversation_id, workspace_key,
          sandbox_key, adapter_key, upstream_version, upstream_artifact_digest,
          opencode_session_id, state, crash_generation, event_tail_sequence,
          terminal, created_at, updated_at, reconciled_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16
        ) ON CONFLICT (owner_identity_id, platform_conversation_id) DO NOTHING
        RETURNING id`, [
        value.id,
        value.ownerIdentityId,
        value.platformConversationId,
        value.workspaceKey,
        value.sandboxKey,
        value.adapterKey,
        value.upstreamVersion,
        Buffer.from(value.upstreamArtifactDigest.slice(7), "hex"),
        value.opencodeSessionId,
        value.state,
        value.crashGeneration,
        value.eventTailSequence,
        value.terminal ? JSON.stringify(value.terminal) : null,
        value.createdAt,
        value.updatedAt,
        value.reconciledAt,
      ])).length > 0;
      const current = await selectBinding(transaction, "owner_identity_id = $1 AND platform_conversation_id = $2", [value.ownerIdentityId, value.platformConversationId], true);
      return { inserted, binding: current };
    });
  }

  async findOwnedBinding(ownerIdentityId, conversationId) {
    return selectBinding(this.#database, "owner_identity_id = $1 AND platform_conversation_id = $2", [ownerIdentityId, conversationId]);
  }

  async findBinding(bindingId) {
    return selectBinding(this.#database, "id = $1", [bindingId]);
  }

  async updateBinding(value) {
    const result = await this.#database.query(`
      UPDATE platform.agent_session_bindings
      SET state = $2, crash_generation = $3, event_tail_sequence = $4,
          terminal = $5::jsonb, updated_at = $6, reconciled_at = $7
      WHERE id = $1 RETURNING *`, [
      value.id, value.state, value.crashGeneration, value.eventTailSequence,
      value.terminal ? JSON.stringify(value.terminal) : null, value.updatedAt, value.reconciledAt,
    ]);
    return binding(rows(result)[0]);
  }

  async insertPrompt(value) {
    return this.#database.transaction(async (transaction) => {
      await transaction.query("SELECT 1 FROM platform.agent_session_bindings WHERE id = $1 FOR UPDATE", [value.bindingId]);
      const existing = rows(await transaction.query(`
        SELECT * FROM platform.agent_prompts
        WHERE (binding_id = $1 AND idempotency_key = $2) OR platform_run_id = $3
        ORDER BY created_at LIMIT 1 FOR UPDATE`, [value.bindingId, value.idempotencyKey, value.platformRunId])).map(prompt)[0];
      if (existing) return { inserted: false, prompt: existing };
      const result = await transaction.query(`
        INSERT INTO platform.agent_prompts (
          id, binding_id, platform_run_id, idempotency_key, request_digest,
          opencode_message_id, status, acceptance_boundary, terminal, revision,
          created_at, submitted_at, accepted_at, completed_at, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15
        ) RETURNING *`, [
        value.id,
        value.bindingId,
        value.platformRunId,
        value.idempotencyKey,
        Buffer.from(value.requestDigest.slice(7), "hex"),
        value.opencodeMessageId,
        value.status,
        value.acceptanceBoundary,
        value.terminal ? JSON.stringify(value.terminal) : null,
        value.revision,
        value.createdAt,
        value.submittedAt,
        value.acceptedAt,
        value.completedAt,
        value.updatedAt,
      ]);
      return { inserted: true, prompt: prompt(rows(result)[0]) };
    });
  }

  async findPrompt(promptId) {
    return selectPrompt(this.#database, promptId);
  }

  async updatePrompt(value, expectedRevision) {
    return this.#database.transaction(async (transaction) => {
      const current = await selectPrompt(transaction, value.id, true);
      if (!current) return null;
      if (current.revision !== expectedRevision) {
        throw new PlatformError("agent_prompt_revision_conflict", "Agent prompt changed concurrently", { status: 409, retryable: true });
      }
      return writePrompt(transaction, value, expectedRevision);
    });
  }

  async appendEvent(value) {
    return this.#database.transaction(async (transaction) => {
      const current = await selectBinding(transaction, "id = $1", [value.bindingId], true);
      if (!current) return null;
      const duplicate = rows(await transaction.query(`
        SELECT * FROM platform.agent_events
        WHERE binding_id = $1 AND connection_id = $2 AND connection_ordinal = $3`, [
        value.bindingId, value.connectionId, value.connectionOrdinal,
      ])).map(event)[0];
      if (duplicate) return { inserted: false, event: duplicate };
      if (value.promptId !== null) {
        const owned = rows(await transaction.query(
          "SELECT 1 FROM platform.agent_prompts WHERE id = $1 AND binding_id = $2",
          [value.promptId, value.bindingId],
        ));
        if (owned.length === 0) throw new PlatformError("agent_event_prompt_invalid", "Agent event prompt is outside the session mapping", { status: 409 });
      }
      const sequence = current.eventTailSequence + 1;
      const inserted = await transaction.query(`
        INSERT INTO platform.agent_events (
          event_id, binding_id, sequence, prompt_id, connection_id, connection_ordinal,
          upstream_event_id, event_type, event_data, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
        RETURNING *`, [
        value.id, value.bindingId, sequence, value.promptId, value.connectionId,
        value.connectionOrdinal, value.upstreamEventId, value.eventType,
        JSON.stringify(value.eventData), value.createdAt,
      ]);
      await transaction.query(`
        UPDATE platform.agent_session_bindings
        SET event_tail_sequence = $2, updated_at = $3 WHERE id = $1`, [value.bindingId, sequence, value.createdAt]);
      return { inserted: true, event: event(rows(inserted)[0]) };
    });
  }

  async listEvents(bindingId, afterSequence, limit) {
    const result = await this.#database.query(`
      SELECT * FROM platform.agent_events
      WHERE binding_id = $1 AND sequence > $2
      ORDER BY sequence LIMIT $3`, [bindingId, afterSequence, limit]);
    return rows(result).map(event);
  }

  async beginCrashReconciliation({ reconciliationId, bindingId, reasonCode, now }) {
    return this.#database.transaction(async (transaction) => {
      const current = await selectBinding(transaction, "id = $1", [bindingId], true);
      if (!current) return null;
      const open = reconciliation(rows(await transaction.query(`
        SELECT * FROM platform.agent_crash_reconciliations
        WHERE binding_id = $1 AND state = 'open' FOR UPDATE`, [bindingId]))[0]);
      if (open) return { binding: current, reconciliation: open, prompts: await listPrompts(transaction, bindingId) };
      if (current.state === "terminal") throw new PlatformError("agent_binding_terminal", "Agent session mapping is terminal", { status: 409 });
      const nextGeneration = current.crashGeneration + 1;
      await transaction.query(`
        UPDATE platform.agent_session_bindings
        SET state = 'reconciling', crash_generation = $2, updated_at = $3
        WHERE id = $1`, [bindingId, nextGeneration, now]);
      await transaction.query(`
        UPDATE platform.agent_prompts
        SET status = 'reconcile_required', revision = revision + 1, updated_at = $2
        WHERE binding_id = $1
          AND status NOT IN ('admitted', 'completed', 'failed', 'cancelled', 'incomplete')`, [bindingId, now]);
      const created = reconciliation(rows(await transaction.query(`
        INSERT INTO platform.agent_crash_reconciliations (
          id, binding_id, crash_generation, state, reason_code, created_at
        ) VALUES ($1,$2,$3,'open',$4,$5) RETURNING *`, [
        reconciliationId, bindingId, nextGeneration, reasonCode, now,
      ]))[0]);
      return {
        binding: await selectBinding(transaction, "id = $1", [bindingId]),
        reconciliation: created,
        prompts: await listPrompts(transaction, bindingId),
      };
    });
  }

  async resolveCrashReconciliation({ bindingId, upstreamSessionExists, acceptedMessageIds, now }) {
    return this.#database.transaction(async (transaction) => {
      const current = await selectBinding(transaction, "id = $1", [bindingId], true);
      const open = reconciliation(rows(await transaction.query(`
        SELECT * FROM platform.agent_crash_reconciliations
        WHERE binding_id = $1 AND state = 'open' FOR UPDATE`, [bindingId]))[0]);
      if (!current || !open) return null;
      const accepted = new Set(acceptedMessageIds);
      const values = await listPrompts(transaction, bindingId, true);
      const summary = { resumed: 0, readyToSubmit: 0, incomplete: 0 };
      for (const value of values) {
        if (value.status !== "reconcile_required") continue;
        const changed = { ...value, revision: value.revision + 1, updatedAt: now };
        if (upstreamSessionExists && accepted.has(value.opencodeMessageId)) {
          changed.status = "accepted";
          changed.acceptanceBoundary = "accepted";
          changed.acceptedAt ??= now;
          summary.resumed += 1;
        } else if (upstreamSessionExists && value.acceptanceBoundary === "unknown") {
          changed.status = "admitted";
          changed.acceptanceBoundary = "none";
          changed.submittedAt = null;
          summary.readyToSubmit += 1;
        } else {
          changed.status = "incomplete";
          changed.terminal = {
            code: upstreamSessionExists ? "accepted_message_missing" : "upstream_session_lost",
            retryable: false,
            requiresHumanReconciliation: value.acceptanceBoundary !== "none",
          };
          changed.completedAt = now;
          summary.incomplete += 1;
        }
        if (!await writePrompt(transaction, changed, value.revision)) {
          throw new PlatformError("agent_prompt_revision_conflict", "Agent prompt changed during reconciliation", { status: 409, retryable: true });
        }
      }
      const terminal = upstreamSessionExists ? null : { code: "upstream_session_lost", requiresExplicitReplacement: true };
      await transaction.query(`
        UPDATE platform.agent_session_bindings
        SET state = $2, terminal = $3::jsonb, reconciled_at = $4, updated_at = $4
        WHERE id = $1`, [bindingId, upstreamSessionExists ? "active" : "terminal", terminal ? JSON.stringify(terminal) : null, now]);
      const resolved = reconciliation(rows(await transaction.query(`
        UPDATE platform.agent_crash_reconciliations
        SET state = 'resolved', upstream_session_exists = $2,
            accepted_message_ids = $3::jsonb, outcome = $4::jsonb, resolved_at = $5
        WHERE id = $1 RETURNING *`, [
        open.id, upstreamSessionExists, JSON.stringify([...accepted].sort()), JSON.stringify(summary), now,
      ]))[0]);
      return {
        binding: await selectBinding(transaction, "id = $1", [bindingId]),
        reconciliation: resolved,
        summary,
        prompts: await listPrompts(transaction, bindingId),
      };
    });
  }
}
