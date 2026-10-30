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

function conversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerIdentityId: row.owner_identity_id,
    title: row.title,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

function message(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    role: row.role,
    content: row.content,
    requestedMode: row.requested_mode,
    effectiveMode: row.effective_mode,
    status: row.status,
    artifacts: json(row.artifacts),
    sources: json(row.sources),
    toolCalls: json(row.tool_calls),
    routing: json(row.routing),
    usage: json(row.usage),
    createdAt: date(row.created_at),
    completedAt: date(row.completed_at),
  };
}

function run(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerIdentityId: row.owner_identity_id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    requestedMode: row.requested_mode,
    effectiveMode: row.effective_mode,
    status: row.status,
    routing: json(row.routing),
    pendingConfirmationId: row.pending_confirmation_id,
    error: json(row.terminal_error),
    createdAt: date(row.created_at),
    startedAt: date(row.started_at),
    completedAt: date(row.completed_at),
  };
}

function event(row) {
  if (!row) return null;
  return {
    id: row.event_id,
    sequence: Number(row.sequence_id),
    conversationId: row.conversation_id,
    runId: row.run_id,
    type: row.event_type,
    data: json(row.event_data),
    createdAt: date(row.created_at),
  };
}

async function findRun(executor, clause, values, lock = false) {
  const result = await executor.query(`
    SELECT * FROM platform.assistant_runs
    WHERE ${clause}${lock ? " FOR UPDATE" : ""}`, values);
  return run(rows(result)[0]);
}

async function insertEvent(executor, value) {
  const result = await executor.query(`
    INSERT INTO platform.assistant_events (
      event_id, conversation_id, run_id, event_type, event_data, created_at
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    RETURNING *`, [
    value.id,
    value.conversationId,
    value.runId,
    value.type,
    JSON.stringify(value.data),
    value.createdAt,
  ]);
  return event(rows(result)[0]);
}

export class PostgresAssistantRepository {
  #database;

  constructor({ database }) {
    if (!database?.query || !database?.transaction) {
      throw new TypeError("PostgreSQL database adapter with query and transaction is required");
    }
    this.#database = database;
  }

  async insertConversation(value) {
    const result = await this.#database.query(`
      INSERT INTO platform.assistant_conversations (
        id, owner_identity_id, title, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $4)
      RETURNING *`, [value.id, value.ownerIdentityId, value.title, value.createdAt]);
    return conversation(rows(result)[0]);
  }

  async findOwnedConversation(ownerIdentityId, conversationId) {
    const result = await this.#database.query(`
      SELECT * FROM platform.assistant_conversations
      WHERE owner_identity_id = $1 AND id = $2`, [ownerIdentityId, conversationId]);
    return conversation(rows(result)[0]);
  }

  async listOwnedConversations(ownerIdentityId) {
    const result = await this.#database.query(`
      SELECT * FROM platform.assistant_conversations
      WHERE owner_identity_id = $1
      ORDER BY updated_at DESC, id`, [ownerIdentityId]);
    return rows(result).map(conversation);
  }

  async updateConversation(value) {
    const result = await this.#database.query(`
      UPDATE platform.assistant_conversations
      SET title = $2, updated_at = $3
      WHERE id = $1
      RETURNING *`, [value.id, value.title, value.updatedAt]);
    return conversation(rows(result)[0]);
  }

  async insertSubmission({ userMessage, assistantMessage, run: value, idempotencyKey, requestDigest, events }) {
    return this.#database.transaction(async (transaction) => {
      await transaction.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`assistant-conversation:${value.conversationId}`],
      );
      const existing = await findRun(
        transaction,
        "owner_identity_id = $1 AND conversation_id = $2 AND idempotency_key = $3",
        [value.ownerIdentityId, value.conversationId, idempotencyKey],
        true,
      );
      if (existing) {
        const digestResult = await transaction.query(
          "SELECT encode(request_digest, 'hex') AS request_digest FROM platform.assistant_runs WHERE id = $1",
          [existing.id],
        );
        return {
          inserted: false,
          requestDigest: `sha256:${rows(digestResult)[0].request_digest}`,
          run: existing,
        };
      }
      const present = rows(await transaction.query(
        "SELECT 1 FROM platform.assistant_conversations WHERE id = $1 AND owner_identity_id = $2 FOR UPDATE",
        [value.conversationId, value.ownerIdentityId],
      ));
      if (present.length === 0) return null;
      const ordinal = Number(rows(await transaction.query(`
        SELECT COALESCE(max(message_ordinal), 0) + 1 AS next_ordinal
        FROM platform.assistant_messages WHERE conversation_id = $1`, [value.conversationId]))[0].next_ordinal);
      await transaction.query(`
        INSERT INTO platform.assistant_runs (
          id, conversation_id, owner_identity_id, user_message_id, assistant_message_id,
          requested_mode, effective_mode, status, routing, idempotency_key,
          request_digest, pending_confirmation_id, terminal_error, created_at,
          started_at, completed_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10,
          $11, $12, $13::jsonb, $14, $15, $16
        )`, [
        value.id,
        value.conversationId,
        value.ownerIdentityId,
        value.userMessageId,
        value.assistantMessageId,
        value.requestedMode,
        value.effectiveMode,
        value.status,
        JSON.stringify(value.routing),
        idempotencyKey,
        Buffer.from(requestDigest.slice(7), "hex"),
        value.pendingConfirmationId,
        value.error ? JSON.stringify(value.error) : null,
        value.createdAt,
        value.startedAt,
        value.completedAt,
      ]);
      for (const [index, item] of [userMessage, assistantMessage].entries()) {
        await transaction.query(`
          INSERT INTO platform.assistant_messages (
            id, conversation_id, run_id, message_ordinal, role, content,
            requested_mode, effective_mode, status, artifacts, sources, tool_calls,
            routing, usage, created_at, completed_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
            $12::jsonb, $13::jsonb, $14::jsonb, $15, $16
          )`, [
          item.id,
          item.conversationId,
          item.runId,
          ordinal + index,
          item.role,
          item.content,
          item.requestedMode,
          item.effectiveMode,
          item.status,
          JSON.stringify(item.artifacts),
          JSON.stringify(item.sources),
          JSON.stringify(item.toolCalls),
          item.routing ? JSON.stringify(item.routing) : null,
          item.usage ? JSON.stringify(item.usage) : null,
          item.createdAt,
          item.completedAt,
        ]);
      }
      for (const item of events) await insertEvent(transaction, item);
      return { inserted: true, requestDigest, run: structuredClone(value) };
    });
  }

  async listMessages(conversationId) {
    const result = await this.#database.query(`
      SELECT * FROM platform.assistant_messages
      WHERE conversation_id = $1 ORDER BY message_ordinal`, [conversationId]);
    return rows(result).map(message);
  }

  async findMessage(conversationId, messageId) {
    const result = await this.#database.query(`
      SELECT * FROM platform.assistant_messages
      WHERE conversation_id = $1 AND id = $2`, [conversationId, messageId]);
    return message(rows(result)[0]);
  }

  async updateMessage(value) {
    const result = await this.#database.query(`
      UPDATE platform.assistant_messages
      SET content = $3, status = $4, artifacts = $5::jsonb, sources = $6::jsonb,
          tool_calls = $7::jsonb, routing = $8::jsonb, usage = $9::jsonb, completed_at = $10
      WHERE conversation_id = $1 AND id = $2
      RETURNING *`, [
      value.conversationId,
      value.id,
      value.content,
      value.status,
      JSON.stringify(value.artifacts),
      JSON.stringify(value.sources),
      JSON.stringify(value.toolCalls),
      value.routing ? JSON.stringify(value.routing) : null,
      value.usage ? JSON.stringify(value.usage) : null,
      value.completedAt,
    ]);
    return message(rows(result)[0]);
  }

  async findRun(runId) {
    return findRun(this.#database, "id = $1", [runId]);
  }

  async findOwnedRun(ownerIdentityId, runId) {
    return findRun(this.#database, "owner_identity_id = $1 AND id = $2", [ownerIdentityId, runId]);
  }

  async updateRun(value) {
    const result = await this.#database.query(`
      UPDATE platform.assistant_runs
      SET status = $2, routing = $3::jsonb, pending_confirmation_id = $4,
          terminal_error = $5::jsonb, started_at = $6, completed_at = $7
      WHERE id = $1
      RETURNING *`, [
      value.id,
      value.status,
      JSON.stringify(value.routing),
      value.pendingConfirmationId,
      value.error ? JSON.stringify(value.error) : null,
      value.startedAt,
      value.completedAt,
    ]);
    return run(rows(result)[0]);
  }

  async appendEvent(value) {
    return insertEvent(this.#database, value);
  }

  async listEvents(conversationId, afterSequence = 0) {
    const result = await this.#database.query(`
      SELECT * FROM platform.assistant_events
      WHERE conversation_id = $1 AND sequence_id > $2
      ORDER BY sequence_id`, [conversationId, afterSequence]);
    return rows(result).map(event);
  }

  async waitForEvents(_conversationId, _afterSequence, { signal, timeoutMs = 1000 } = {}) {
    if (signal?.aborted) return;
    await new Promise((resolve) => {
      const timer = setTimeout(finish, Math.min(timeoutMs, 1000));
      timer.unref?.();
      function finish() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      }
      signal?.addEventListener("abort", finish, { once: true });
    });
  }
}
