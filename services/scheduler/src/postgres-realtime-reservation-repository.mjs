import { PlatformError } from "../../../packages/observability/src/index.mjs";

const ACTIVE_STATES = new Set(["admitted", "connected"]);

function rows(result) {
  return Array.isArray(result) ? result : result?.rows ?? [];
}

function json(value) {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function date(value) {
  return value === null || value === undefined ? null : new Date(value);
}

function mapped(row) {
  if (!row) return null;
  return {
    sessionId: row.id,
    admissionKey: row.admission_key,
    ownerIdentityId: row.owner_identity_id,
    correlationId: row.correlation_id,
    capability: row.capability_key,
    requestedModel: row.requested_model,
    modelProfileId: row.model_profile_id,
    nodeId: row.node_id,
    nodeGeneration: Number(row.node_generation),
    route: row.route,
    state: row.state,
    priorityClass: row.priority_class,
    schedulerPriority: Number(row.scheduler_priority),
    latencyBudgetMilliseconds: Number(row.latency_budget_milliseconds),
    resources: json(row.reservation),
    codecDirections: json(row.codec_directions),
    leaseToken: row.lease_token,
    fencingToken: Number(row.fencing_token),
    connectionId: row.connection_id,
    admittedAt: date(row.admitted_at),
    connectionDeadlineAt: date(row.connection_deadline_at),
    expiresAt: date(row.expires_at),
    connectedAt: date(row.connected_at),
    heartbeatAt: date(row.heartbeat_at),
    releasedAt: date(row.released_at),
    releaseReason: row.release_reason,
    updatedAt: date(row.updated_at),
  };
}

function conflict(code, message) {
  return new PlatformError(code, message, { status: 409, retryable: true });
}

async function expireDue(transaction, at) {
  return rows(await transaction.query(`
    UPDATE compute.realtime_sessions
    SET state = 'expired', released_at = $1,
        release_reason = CASE
          WHEN expires_at <= $1 THEN 'session_expired'
          ELSE 'connection_timeout'
        END
    WHERE state IN ('admitted','connected')
      AND (expires_at <= $1 OR (state = 'admitted' AND connection_deadline_at <= $1))
    RETURNING id, state, release_reason`, [at]));
}

async function ownedForUpdate(transaction, ownerIdentityId, sessionId) {
  const session = rows(await transaction.query(`
    SELECT * FROM compute.realtime_sessions
    WHERE id = $1 AND owner_identity_id = $2
    FOR UPDATE`, [sessionId, ownerIdentityId]))[0];
  if (!session) {
    throw new PlatformError("realtime_session_not_found", "Realtime session was not found", { status: 404 });
  }
  return session;
}

async function currentNode(transaction, session) {
  return rows(await transaction.query(`
    SELECT lifecycle_state, generation
    FROM compute.nodes WHERE id = $1 FOR SHARE`, [session.node_id]))[0];
}

async function closeSession(transaction, session, state, reason, at) {
  return rows(await transaction.query(`
    UPDATE compute.realtime_sessions
    SET state = $3, released_at = $4, release_reason = $5
    WHERE id = $1 AND owner_identity_id = $2
    RETURNING *`, [session.id, session.owner_identity_id, state, at, reason]))[0];
}

export class PostgresRealtimeReservationRepository {
  #database;

  constructor({ database }) {
    if (!database?.query || !database?.transaction) {
      throw new TypeError("PostgreSQL database adapter with query and transaction is required");
    }
    this.#database = database;
  }

  async acquireRealtimeReservation(input) {
    return this.#database.transaction(async (transaction) => {
      const previous = rows(await transaction.query(`
        SELECT * FROM compute.realtime_sessions
        WHERE admission_key = $1 FOR UPDATE`, [input.admissionKey]))[0];
      if (previous) {
        if (previous.owner_identity_id !== input.ownerIdentityId
            || previous.capability_key !== input.capability
            || previous.requested_model !== input.requestedModel) {
          throw conflict("realtime_admission_key_conflict", "Realtime admission key was reused with different facts");
        }
        return mapped(previous);
      }

      const node = rows(await transaction.query(`
        SELECT id, generation, lifecycle_state, capacity
        FROM compute.nodes WHERE id = $1 FOR UPDATE`, [input.nodeId]))[0];
      if (!node || node.lifecycle_state !== "ready") throw conflict("node_not_ready", "Compute node is not ready");
      if (Number(node.generation) !== input.nodeGeneration) {
        throw conflict("stale_node_generation", "Compute node generation changed");
      }
      await expireDue(transaction, input.admittedAt);
      await transaction.query(`
        UPDATE compute.node_exclusive_intents
        SET state = 'expired', finished_at = $2, finish_reason = 'intent_expired'
        WHERE node_id = $1 AND state = 'pending' AND deadline_at <= $2`, [input.nodeId, input.admittedAt]);
      const intent = rows(await transaction.query(`
        SELECT id FROM compute.node_exclusive_intents
        WHERE node_id = $1 AND state IN ('pending','acquired')
        FOR UPDATE`, [input.nodeId]))[0];
      if (intent) throw conflict("node_exclusive_pending", "Node is reserved for exclusive work");
      const exclusiveLease = rows(await transaction.query(`
        SELECT id FROM compute.lease_sets
        WHERE node_id = $1 AND state = 'active' AND node_exclusive = true AND expires_at > $2
        FOR UPDATE`, [input.nodeId, input.admittedAt]))[0];
      if (exclusiveLease) throw conflict("node_exclusive_active", "Node has an active exclusive lease");

      const fence = rows(await transaction.query(`
        INSERT INTO compute.node_lease_fences (node_id, next_fencing_token)
        VALUES ($1, 2)
        ON CONFLICT (node_id) DO UPDATE
        SET next_fencing_token = compute.node_lease_fences.next_fencing_token + 1,
            updated_at = clock_timestamp()
        RETURNING next_fencing_token - 1 AS fencing_token`, [input.nodeId]))[0];
      const inserted = rows(await transaction.query(`
        INSERT INTO compute.realtime_sessions (
          id, admission_key, owner_identity_id, correlation_id, capability_key,
          requested_model, model_profile_id, node_id, node_generation, route,
          latency_budget_milliseconds, reservation, codec_directions,
          lease_token, fencing_token, admitted_at, connection_deadline_at,
          expires_at, heartbeat_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,
          $14,$15,$16,$17,$18,$16
        ) RETURNING *`, [
        input.sessionId, input.admissionKey, input.ownerIdentityId, input.correlationId,
        input.capability, input.requestedModel, input.modelProfileId, input.nodeId,
        input.nodeGeneration, input.route, input.latencyBudgetMilliseconds,
        JSON.stringify(input.resources), JSON.stringify(input.codecDirections), input.leaseToken,
        Number(fence.fencing_token), input.admittedAt, input.connectionDeadlineAt, input.expiresAt,
      ]))[0];
      return mapped(inserted);
    });
  }

  async connectRealtimeSession({ ownerIdentityId, sessionId, connectionId, connectedAt }) {
    return this.#database.transaction(async (transaction) => {
      await expireDue(transaction, connectedAt);
      const session = await ownedForUpdate(transaction, ownerIdentityId, sessionId);
      if (!ACTIVE_STATES.has(session.state)) {
        throw conflict("realtime_session_expired", "Realtime session is no longer active");
      }
      if (session.state === "connected") {
        if (session.connection_id !== connectionId) {
          throw conflict("realtime_session_already_connected", "Realtime session already has an active connection");
        }
        return mapped(session);
      }
      if (date(session.connection_deadline_at) <= connectedAt || date(session.expires_at) <= connectedAt) {
        await closeSession(transaction, session, "expired", "connection_timeout", connectedAt);
        throw conflict("realtime_session_expired", "Realtime connection deadline has expired");
      }
      const node = await currentNode(transaction, session);
      if (!node || node.lifecycle_state !== "ready" || Number(node.generation) !== Number(session.node_generation)) {
        await closeSession(transaction, session, "revoked", "node_fence_changed", connectedAt);
        throw conflict("stale_node_generation", "Node fence changed before realtime connection");
      }
      const updated = rows(await transaction.query(`
        UPDATE compute.realtime_sessions
        SET state = 'connected', connection_id = $3, connected_at = $4, heartbeat_at = $4
        WHERE id = $1 AND owner_identity_id = $2
        RETURNING *`, [sessionId, ownerIdentityId, connectionId, connectedAt]))[0];
      return mapped(updated);
    });
  }

  async heartbeatRealtimeSession({ ownerIdentityId, sessionId, connectionId, heartbeatAt }) {
    return this.#database.transaction(async (transaction) => {
      await expireDue(transaction, heartbeatAt);
      const session = await ownedForUpdate(transaction, ownerIdentityId, sessionId);
      if (session.state !== "connected" || session.connection_id !== connectionId) {
        throw conflict("realtime_connection_stale", "Realtime connection no longer owns the reservation");
      }
      const node = await currentNode(transaction, session);
      if (!node || node.lifecycle_state !== "ready" || Number(node.generation) !== Number(session.node_generation)) {
        await closeSession(transaction, session, "revoked", "node_fence_changed", heartbeatAt);
        throw conflict("stale_node_generation", "Node fence changed during realtime session");
      }
      const updated = rows(await transaction.query(`
        UPDATE compute.realtime_sessions SET heartbeat_at = $4
        WHERE id = $1 AND owner_identity_id = $2 AND connection_id = $3
        RETURNING *`, [sessionId, ownerIdentityId, connectionId, heartbeatAt]))[0];
      return mapped(updated);
    });
  }

  async releaseRealtimeSession({ ownerIdentityId, sessionId, connectionId, reason, releasedAt }) {
    return this.#database.transaction(async (transaction) => {
      const session = await ownedForUpdate(transaction, ownerIdentityId, sessionId);
      if (!ACTIVE_STATES.has(session.state)) return mapped(session);
      if (session.connection_id !== null && session.connection_id !== connectionId) {
        throw conflict("realtime_connection_stale", "Realtime connection no longer owns the reservation");
      }
      return mapped(await closeSession(transaction, session, "released", reason, releasedAt));
    });
  }

  async reconcileRealtimeSessions({ reconciledAt }) {
    return this.#database.transaction(async (transaction) => {
      const outcomes = await expireDue(transaction, reconciledAt);
      const revoked = rows(await transaction.query(`
        UPDATE compute.realtime_sessions AS session
        SET state = 'revoked', released_at = $1, release_reason = 'node_fence_changed'
        FROM compute.nodes AS node
        WHERE session.node_id = node.id
          AND session.state IN ('admitted','connected')
          AND (node.lifecycle_state <> 'ready' OR node.generation <> session.node_generation)
        RETURNING session.id, session.state, session.release_reason`, [reconciledAt]));
      return [...outcomes, ...revoked].map((row) => ({
        sessionId: row.id, state: row.state, reason: row.release_reason,
      }));
    });
  }

  async listActiveRealtimeSessions({ observedAt }) {
    return this.#database.transaction(async (transaction) => {
      await expireDue(transaction, observedAt);
      return rows(await transaction.query(`
        SELECT * FROM compute.realtime_sessions
        WHERE state IN ('admitted','connected') AND expires_at > $1
        ORDER BY admitted_at, id`, [observedAt])).map(mapped);
    });
  }
}
