import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { leaseResourceKeys } from "./lease-manager.mjs";

const TERMINAL_JOBS = new Set(["succeeded", "failed", "cancelled", "expired", "incomplete"]);
const MAXIMUM_DISPATCH_ATTEMPTS = 5;
const LEASE_SELECT = `
SELECT lease_set.*,
       node.lifecycle_state AS node_lifecycle_state,
       node.generation AS current_node_generation,
       attempt.status AS attempt_status,
       attempt.attempt_number,
       attempt.acceptance_state,
       job.status AS job_status
FROM compute.lease_sets lease_set
JOIN compute.nodes node ON node.id = lease_set.node_id
JOIN compute.attempts attempt ON attempt.id = lease_set.attempt_id
JOIN compute.jobs job ON job.id = lease_set.job_id`;

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

function mapped(row) {
  if (!row) return null;
  return {
    leaseSetId: row.id,
    acquisitionKey: row.acquisition_key,
    nodeId: row.node_id,
    nodeGeneration: Number(row.node_generation),
    jobId: row.job_id,
    attemptId: row.attempt_id,
    modelProfileId: row.model_profile_id,
    leaseToken: row.lease_token,
    fencingToken: Number(row.fencing_token),
    state: row.state,
    dispatchState: row.dispatch_state,
    dispatchId: row.dispatch_id,
    reservation: json(row.reservation),
    acquiredAt: date(row.acquired_at),
    heartbeatAt: date(row.heartbeat_at),
    expiresAt: date(row.expires_at),
    dispatchedAt: date(row.dispatched_at),
    acceptedAt: date(row.accepted_at),
    releasedAt: date(row.released_at),
    releaseReason: row.release_reason,
    reconciliationCount: Number(row.reconciliation_count),
    lastReconciledAt: date(row.last_reconciled_at),
    nodeExclusive: row.node_exclusive === true,
    nodeLifecycleState: row.node_lifecycle_state,
    currentNodeGeneration: row.current_node_generation === undefined
      ? null
      : Number(row.current_node_generation),
    attemptStatus: row.attempt_status,
    attemptNumber: Number(row.attempt_number),
    acceptanceState: row.acceptance_state,
    jobStatus: row.job_status,
  };
}

function conflict(code, message) {
  return new PlatformError(code, message, { status: 409, retryable: true });
}

function sameReservation(left, right) {
  return leaseResourceKeys.every((key) => Number(left?.[key]) === Number(right?.[key]));
}

async function selectLease(executor, clause, values, lock = false) {
  const result = await executor.query(
    `${LEASE_SELECT} WHERE ${clause}${lock ? " FOR UPDATE OF lease_set, attempt, job, node" : ""}`,
    values,
  );
  return mapped(rows(result)[0]);
}

async function appendLeaseEvent(executor, jobId, state, messageKey, payload) {
  const publicState = state === "admitted" ? "preparing" : state === "incomplete" ? "failed" : state;
  await executor.query(`
    INSERT INTO compute.job_events (
      job_id, event_kind, public_state, progress, progress_revision,
      message_key, payload
    )
    SELECT id, 'state', $2, progress_value * 100, progress_revision, $3, $4::jsonb
    FROM compute.jobs WHERE id = $1`, [jobId, publicState, messageKey, JSON.stringify(payload)]);
}

async function closeLeaseSet(transaction, lease, state, reason, at) {
  const dispatchState = lease.acceptanceState === "not_accepted"
    ? "cancelled"
    : "reconcile_required";
  await transaction.query(`
    UPDATE compute.lease_sets
    SET state = $2, dispatch_state = $3, released_at = $4,
        release_reason = $5, reconciliation_count = reconciliation_count + 1,
        last_reconciled_at = $4
    WHERE id = $1 AND state = 'active'`, [
    lease.leaseSetId,
    state,
    dispatchState,
    at,
    reason,
  ]);
  await transaction.query(`
    UPDATE compute.leases
    SET state = $2, released_at = $3
    WHERE lease_set_id = $1 AND state = 'active'`, [lease.leaseSetId, state, at]);
  if (lease.nodeExclusive) {
    await completeClosedExclusiveIntent(transaction, lease.leaseSetId, at, reason);
  }

  if (TERMINAL_JOBS.has(lease.jobStatus)) return;

  if (lease.acceptanceState === "not_accepted") {
    const retryExhausted = lease.attemptNumber >= MAXIMUM_DISPATCH_ATTEMPTS;
    await transaction.query(`
      UPDATE compute.attempts
      SET status = $2, retryable = $3, error_code = $4, finished_at = $5
      WHERE id = $1 AND status IN ('pending','dispatched','accepted','running')`, [
      lease.attemptId,
      retryExhausted ? "failed" : "lost",
      !retryExhausted,
      retryExhausted ? "dispatch_retry_exhausted" : reason,
      at,
    ]);
    if (retryExhausted) {
      await transaction.query(`
        UPDATE compute.jobs
        SET status = 'failed', current_attempt_id = NULL, waiting_reason = NULL,
            retry_classification = 'terminal',
            terminal_error = jsonb_build_object(
              'code', 'managed_dispatch_retry_exhausted',
              'message', 'Managed-node dispatch failed after the bounded retry budget',
              'retryable', false,
              'guidanceKey', 'tasks.compute.dispatch_retry_exhausted'
            ),
            terminal_at = $2, updated_at = $2,
            progress_sequence = progress_sequence + 1,
            progress_message_key = 'tasks.compute.dispatch_retry_exhausted'
        WHERE id = $1 AND status NOT IN ('succeeded','failed','cancelled','expired','incomplete')`, [
        lease.jobId,
        at,
      ]);
      await appendLeaseEvent(transaction, lease.jobId, "failed", "tasks.compute.dispatch_retry_exhausted", {
        reason: "dispatch_retry_exhausted",
        attemptId: lease.attemptId,
        attemptNumber: lease.attemptNumber,
      });
      return;
    }
    await transaction.query(`
      UPDATE compute.jobs
      SET status = 'queued', current_attempt_id = NULL, waiting_reason = $2,
          updated_at = $3, progress_sequence = progress_sequence + 1,
          progress_message_key = 'tasks.compute.requeued'
      WHERE id = $1 AND status NOT IN ('succeeded','failed','cancelled','expired','incomplete')`, [
      lease.jobId,
      reason,
      at,
    ]);
    await appendLeaseEvent(transaction, lease.jobId, "queued", "tasks.compute.requeued", {
      reason,
      attemptId: lease.attemptId,
    });
  } else {
    await transaction.query(`
      UPDATE compute.attempts
      SET status = 'incomplete', retryable = false, error_code = $2, finished_at = $3
      WHERE id = $1 AND status IN ('pending','dispatched','accepted','running')`, [
      lease.attemptId,
      reason,
      at,
    ]);
    await transaction.query(`
      UPDATE compute.jobs
      SET status = 'incomplete', current_attempt_id = NULL, waiting_reason = NULL,
          retry_classification = 'manual_reconcile',
          terminal_error = jsonb_build_object(
            'code', $2::text,
            'message', 'Accepted compute attempt lost its valid resource lease',
            'retryable', false,
            'guidanceKey', 'tasks.compute.manual_reconcile'
          ),
          terminal_at = $3, updated_at = $3
      WHERE id = $1 AND status NOT IN ('succeeded','failed','cancelled','expired','incomplete')`, [
      lease.jobId,
      reason,
      at,
    ]);
    await appendLeaseEvent(transaction, lease.jobId, "incomplete", "tasks.compute.manual_reconcile", {
      reason,
      attemptId: lease.attemptId,
    });
  }
}

async function completeClosedExclusiveIntent(transaction, leaseSetId, at, reason) {
  await transaction.query(`
    UPDATE compute.node_exclusive_intents
    SET state = 'completed', finished_at = $2, finish_reason = $3
    WHERE lease_set_id = $1 AND state = 'acquired'`, [leaseSetId, at, reason]);
}

function throwOutcome(outcome) {
  if (outcome?.error) throw conflict(outcome.error.code, outcome.error.message);
  return outcome?.value ?? outcome;
}

export class PostgresLeaseRepository {
  #database;

  constructor({ database }) {
    if (!database?.query || !database?.transaction) {
      throw new TypeError("PostgreSQL database adapter with query and transaction is required");
    }
    this.#database = database;
  }

  async findActiveByJob(jobId) {
    return selectLease(this.#database, "lease_set.job_id = $1 AND lease_set.state = 'active'", [jobId]);
  }

  async listAttempts(jobId) {
    return rows(await this.#database.query(`
      SELECT attempt.*, lease_set.node_generation
      FROM compute.attempts attempt
      LEFT JOIN compute.lease_sets lease_set ON lease_set.attempt_id = attempt.id
      WHERE attempt.job_id = $1
      ORDER BY attempt.attempt_number, attempt.id`, [jobId])).map((row) => ({
      attemptId: row.id,
      jobId: row.job_id,
      attemptNumber: Number(row.attempt_number),
      nodeId: row.node_id,
      nodeGeneration: row.node_generation == null ? null : Number(row.node_generation),
      modelProfileId: row.model_profile_id,
      dispatchFence: Number(row.dispatch_fence),
      status: row.status,
      acceptanceState: row.acceptance_state,
      retryable: row.retryable,
      errorCode: row.error_code,
      dispatchedAt: date(row.dispatched_at),
      acceptedAt: date(row.accepted_at),
      startedAt: date(row.started_at),
      finishedAt: date(row.finished_at),
      createdAt: date(row.created_at),
    }));
  }

  async beginExclusiveIntent(input) {
    return this.#database.transaction(async (transaction) => {
      await transaction.query(`
        UPDATE compute.node_exclusive_intents
        SET state = 'expired', finished_at = $1, finish_reason = 'intent_expired'
        WHERE state = 'pending' AND deadline_at <= $1`, [input.requestedAt]);
      const previous = rows(await transaction.query(`
        SELECT * FROM compute.node_exclusive_intents
        WHERE id = $1 FOR UPDATE`, [input.intentId]))[0];
      if (previous) {
        if (previous.job_id !== input.jobId || previous.node_id !== input.nodeId) {
          throw conflict("exclusive_intent_identity_conflict", "Exclusive intent ID was reused with different facts");
        }
        return {
          intentId: previous.id, nodeId: previous.node_id, jobId: previous.job_id,
          state: previous.state, leaseSetId: previous.lease_set_id,
          requestedAt: date(previous.requested_at), deadlineAt: date(previous.deadline_at),
          finishedAt: date(previous.finished_at), finishReason: previous.finish_reason,
        };
      }
      const job = rows(await transaction.query(`
        SELECT id, status, cancel_requested_at
        FROM compute.jobs WHERE id = $1 FOR UPDATE`, [input.jobId]))[0];
      if (!job || TERMINAL_JOBS.has(job.status) || job.cancel_requested_at) {
        throw conflict("job_not_exclusive_eligible", "Job cannot begin exclusive preparation");
      }
      const node = rows(await transaction.query(`
        SELECT id, lifecycle_state FROM compute.nodes
        WHERE id = $1 FOR UPDATE`, [input.nodeId]))[0];
      if (!node || node.lifecycle_state !== "ready") throw conflict("node_not_ready", "Compute node is not ready");
      const active = rows(await transaction.query(`
        SELECT id FROM compute.node_exclusive_intents
        WHERE node_id = $1 AND state IN ('pending','acquired')
        FOR UPDATE`, [input.nodeId]))[0];
      if (active) throw conflict("exclusive_intent_conflict", "Node already has active exclusive preparation");
      const inserted = rows(await transaction.query(`
        INSERT INTO compute.node_exclusive_intents (
          id, node_id, job_id, requested_at, deadline_at
        ) VALUES ($1,$2,$3,$4,$5)
        RETURNING *`, [input.intentId, input.nodeId, input.jobId, input.requestedAt, input.deadlineAt]))[0];
      return {
        intentId: inserted.id, nodeId: inserted.node_id, jobId: inserted.job_id,
        state: inserted.state, leaseSetId: inserted.lease_set_id,
        requestedAt: date(inserted.requested_at), deadlineAt: date(inserted.deadline_at),
        finishedAt: date(inserted.finished_at), finishReason: inserted.finish_reason,
      };
    });
  }

  async cancelExclusiveIntent({ intentId, jobId, reason, cancelledAt }) {
    return this.#database.transaction(async (transaction) => {
      const intent = rows(await transaction.query(`
        SELECT * FROM compute.node_exclusive_intents
        WHERE id = $1 AND job_id = $2 FOR UPDATE`, [intentId, jobId]))[0];
      if (!intent) throw conflict("exclusive_intent_not_found", "Exclusive intent was not found for the job");
      if (intent.state === "acquired") throw conflict("exclusive_lease_active", "Acquired exclusive intent must be released through its lease");
      if (intent.state === "pending") {
        const updated = rows(await transaction.query(`
          UPDATE compute.node_exclusive_intents
          SET state = 'cancelled', finished_at = $3, finish_reason = $4
          WHERE id = $1 AND job_id = $2
          RETURNING *`, [intentId, jobId, cancelledAt, reason]))[0];
        intent.state = updated.state;
        intent.finished_at = updated.finished_at;
        intent.finish_reason = updated.finish_reason;
      }
      return {
        intentId: intent.id, nodeId: intent.node_id, jobId: intent.job_id,
        state: intent.state, leaseSetId: intent.lease_set_id,
        requestedAt: date(intent.requested_at), deadlineAt: date(intent.deadline_at),
        finishedAt: date(intent.finished_at), finishReason: intent.finish_reason,
      };
    });
  }

  async acquireLeaseSet(input) {
    return this.#database.transaction(async (transaction) => {
      const existing = await selectLease(
        transaction,
        "lease_set.acquisition_key = $1",
        [input.acquisitionKey],
        true,
      );
      if (existing) {
        if (existing.jobId !== input.jobId
            || existing.nodeId !== input.nodeId
            || existing.modelProfileId !== input.modelProfileId
            || existing.nodeExclusive !== input.nodeExclusive
            || !sameReservation(existing.reservation, input.reservation)) {
          throw conflict("acquisition_key_conflict", "Lease acquisition key was reused with different facts");
        }
        return existing;
      }

      const job = rows(await transaction.query(`
        SELECT id, capability_id, requested_model_profile_id, status,
               cancel_requested_at
        FROM compute.jobs WHERE id = $1 FOR UPDATE`, [input.jobId]))[0];
      if (!job) throw new PlatformError("job_not_found", "Compute job does not exist", { status: 404 });
      if (TERMINAL_JOBS.has(job.status) || job.cancel_requested_at) {
        throw conflict("job_not_leasable", "Compute job is terminal or cancelled");
      }

      const node = rows(await transaction.query(`
        SELECT id, generation, lifecycle_state, trust_kind, labels, capacity, inventory
        FROM compute.nodes WHERE id = $1 FOR UPDATE`, [input.nodeId]))[0];
      if (!node) throw new PlatformError("node_not_found", "Compute node does not exist", { status: 404 });
      if (node.lifecycle_state !== "ready") throw conflict("node_not_ready", "Compute node is not ready");
      if (Number(node.generation) !== input.nodeGeneration) {
        throw conflict("stale_node_generation", "Compute node generation changed");
      }

      const modelProfile = rows(await transaction.query(`
        SELECT id, capability_id, certification_state
        FROM compute.model_profiles WHERE id = $1 FOR SHARE`, [input.modelProfileId]))[0];
      if (!modelProfile
          || modelProfile.certification_state !== "certified"
          || modelProfile.capability_id !== job.capability_id
          || (job.requested_model_profile_id && job.requested_model_profile_id !== modelProfile.id)) {
        throw conflict("model_profile_fence_changed", "Certified model profile no longer matches the job");
      }

      const due = rows(await transaction.query(`${LEASE_SELECT}
        WHERE lease_set.node_id = $1 AND lease_set.state = 'active'
          AND lease_set.expires_at <= $2
        FOR UPDATE OF lease_set, attempt, job, node`, [input.nodeId, input.acquiredAt])).map(mapped);
      for (const lease of due) {
        await closeLeaseSet(transaction, lease, "expired", "lease_expired", input.acquiredAt);
      }

      await transaction.query(`
        UPDATE compute.node_exclusive_intents
        SET state = 'expired', finished_at = $2, finish_reason = 'intent_expired'
        WHERE node_id = $1 AND state = 'pending' AND deadline_at <= $2`, [input.nodeId, input.acquiredAt]);
      const exclusiveIntent = rows(await transaction.query(`
        SELECT * FROM compute.node_exclusive_intents
        WHERE node_id = $1 AND state IN ('pending','acquired')
        FOR UPDATE`, [input.nodeId]))[0];
      const activeNodeLeases = rows(await transaction.query(`
        SELECT id, node_exclusive FROM compute.lease_sets
        WHERE node_id = $1 AND state = 'active' AND expires_at > $2
        FOR UPDATE`, [input.nodeId, input.acquiredAt]));
      const activeRealtimeSessions = rows(await transaction.query(`
        SELECT id FROM compute.realtime_sessions
        WHERE node_id = $1 AND state IN ('admitted','connected') AND expires_at > $2
        FOR UPDATE`, [input.nodeId, input.acquiredAt]));
      const activeCasting = rows(await transaction.query(`
        SELECT id FROM platform.cast_sessions WHERE appliance_node_id=$1 AND terminal_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`, [input.nodeId]));
      const activePhones = rows(await transaction.query(`SELECT id FROM platform.phone_runs WHERE node_id=$1 AND state<>'stopped' UNION ALL SELECT id FROM compute.computer_runs WHERE node_id=$1 AND state='active'`, [input.nodeId]));
      if (input.nodeExclusive) {
        if (!exclusiveIntent || exclusiveIntent.job_id !== input.jobId || exclusiveIntent.state !== "pending") {
          throw conflict("exclusive_intent_required", "Node-exclusive acquisition requires its active preparation intent");
        }
        if (activeNodeLeases.length || activeRealtimeSessions.length || activeCasting.length || activePhones.length) {
          throw conflict("exclusive_conflicting_leases", "Conflicting AI leases must drain before node-exclusive acquisition");
        }
      } else {
        if (exclusiveIntent) throw conflict("node_exclusive_pending", "Node is reserved for pending or active exclusive work");
        if (activeNodeLeases.some((lease) => lease.node_exclusive === true)) {
          throw conflict("node_exclusive_active", "Node has an active exclusive lease");
        }
      }

      const activeForJob = await selectLease(
        transaction,
        "lease_set.job_id = $1 AND lease_set.state = 'active'",
        [input.jobId],
        true,
      );
      if (activeForJob) {
        throw conflict("active_job_lease_exists", "Compute job already has an active lease set");
      }

      const fence = rows(await transaction.query(`
        INSERT INTO compute.node_lease_fences (node_id, next_fencing_token)
        VALUES ($1, 2)
        ON CONFLICT (node_id) DO UPDATE
        SET next_fencing_token = compute.node_lease_fences.next_fencing_token + 1,
            updated_at = clock_timestamp()
        RETURNING next_fencing_token - 1 AS fencing_token`, [input.nodeId]))[0];
      const fencingToken = Number(fence.fencing_token);
      const attemptNumber = Number(rows(await transaction.query(`
        SELECT COALESCE(max(attempt_number), 0) + 1 AS attempt_number
        FROM compute.attempts WHERE job_id = $1`, [input.jobId]))[0].attempt_number);

      await transaction.query(`
        INSERT INTO compute.attempts (
          id, job_id, attempt_number, status, node_id, model_profile_id,
          dispatch_fence, acceptance_state, created_at
        ) VALUES ($1, $2, $3, 'pending', $4, $5, $6, 'not_accepted', $7)`, [
        input.attemptId,
        input.jobId,
        attemptNumber,
        input.nodeId,
        input.modelProfileId,
        fencingToken,
        input.acquiredAt,
      ]);
      const inserted = rows(await transaction.query(`
        INSERT INTO compute.lease_sets (
          acquisition_key, node_id, node_generation, job_id, attempt_id,
          model_profile_id, lease_token, fencing_token, reservation,
          acquired_at, heartbeat_at, expires_at, node_exclusive
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $10, $11, $12)
        RETURNING id`, [
        input.acquisitionKey,
        input.nodeId,
        input.nodeGeneration,
        input.jobId,
        input.attemptId,
        input.modelProfileId,
        input.leaseToken,
        fencingToken,
        JSON.stringify(input.reservation),
        input.acquiredAt,
        input.expiresAt,
        input.nodeExclusive,
      ]))[0];

      if (input.nodeExclusive) {
        await transaction.query(`
          INSERT INTO compute.leases (
            resource_kind, resource_key, job_id, attempt_id, lease_token,
            fencing_token, reservation, acquired_at, expires_at, heartbeat_at,
            lease_set_id, node_id, amount
          ) VALUES (
            'exclusive', $1, $2, $3, uuidv7(), $4,
            '{"resourceKey":"nodeExclusive","amount":1}'::jsonb,
            $5, $6, $5, $7, $8, 1
          )`, [`${input.nodeId}:exclusive`, input.jobId, input.attemptId, fencingToken,
          input.acquiredAt, input.expiresAt, inserted.id, input.nodeId]);
        await transaction.query(`
          UPDATE compute.node_exclusive_intents
          SET state = 'acquired', lease_set_id = $2
          WHERE id = $1 AND state = 'pending'`, [exclusiveIntent.id, inserted.id]);
      }

      const labels = json(node.labels) ?? {};
      const route = labels.localAppliance === true ? "local" : "managed_node";
      await transaction.query(`
        UPDATE compute.jobs
        SET status = 'admitted', route = $2, current_attempt_id = $3,
            waiting_reason = NULL, updated_at = $4
        WHERE id = $1`, [input.jobId, route, input.attemptId, input.acquiredAt]);
      await appendLeaseEvent(transaction, input.jobId, "admitted", "tasks.compute.admitted", {
        attemptId: input.attemptId,
        fencingToken,
      });

      return selectLease(transaction, "lease_set.id = $1", [inserted.id]);
    });
  }

  async heartbeatLeaseSet({ leaseToken, fencingToken, heartbeatAt, expiresAt }) {
    const outcome = await this.#database.transaction(async (transaction) => {
      const lease = await selectLease(transaction, "lease_set.lease_token = $1", [leaseToken], true);
      if (!lease || lease.fencingToken !== fencingToken) {
        return { error: { code: "stale_lease_fence", message: "Lease fencing token is stale or unknown" } };
      }
      if (lease.state !== "active" || lease.expiresAt <= heartbeatAt) {
        if (lease.state === "active") await closeLeaseSet(transaction, lease, "expired", "lease_expired", heartbeatAt);
        return { error: { code: "lease_expired", message: "Lease is no longer active" } };
      }
      if (lease.nodeLifecycleState !== "ready" || lease.currentNodeGeneration !== lease.nodeGeneration) {
        await closeLeaseSet(transaction, lease, "revoked", "node_fence_changed", heartbeatAt);
        return { error: { code: "stale_node_generation", message: "Node fence changed while heartbeating" } };
      }
      await transaction.query(`
        UPDATE compute.lease_sets
        SET heartbeat_at = $2, expires_at = $3
        WHERE id = $1`, [lease.leaseSetId, heartbeatAt, expiresAt]);
      await transaction.query(`
        UPDATE compute.leases
        SET heartbeat_at = $2, expires_at = $3
        WHERE lease_set_id = $1 AND state = 'active'`, [lease.leaseSetId, heartbeatAt, expiresAt]);
      return { value: await selectLease(transaction, "lease_set.id = $1", [lease.leaseSetId]) };
    });
    return throwOutcome(outcome);
  }

  async claimDispatch({ leaseToken, fencingToken, dispatchId, dispatchedAt }) {
    const outcome = await this.#database.transaction(async (transaction) => {
      const lease = await selectLease(transaction, "lease_set.lease_token = $1", [leaseToken], true);
      if (!lease || lease.fencingToken !== fencingToken) {
        return { error: { code: "stale_lease_fence", message: "Lease fencing token is stale or unknown" } };
      }
      if (lease.state !== "active" || lease.expiresAt <= dispatchedAt) {
        if (lease.state === "active") await closeLeaseSet(transaction, lease, "expired", "lease_expired", dispatchedAt);
        return { error: { code: "lease_expired", message: "Dispatch requires an active lease" } };
      }
      if (lease.nodeLifecycleState !== "ready" || lease.currentNodeGeneration !== lease.nodeGeneration) {
        await closeLeaseSet(transaction, lease, "revoked", "node_fence_changed", dispatchedAt);
        return { error: { code: "stale_node_generation", message: "Node fence changed before dispatch" } };
      }
      if (lease.dispatchState !== "pending") {
        if (lease.dispatchId === dispatchId) return { value: lease };
        return { error: { code: "duplicate_dispatch", message: "Lease is already claimed by another dispatch" } };
      }

      const duplicate = rows(await transaction.query(`
        SELECT id FROM compute.lease_sets WHERE dispatch_id = $1 FOR UPDATE`, [dispatchId]))[0];
      if (duplicate) {
        return { error: { code: "duplicate_dispatch", message: "Dispatch identity has already been used" } };
      }
      await transaction.query(`
        UPDATE compute.lease_sets
        SET dispatch_state = 'claimed', dispatch_id = $2, dispatched_at = $3
        WHERE id = $1`, [lease.leaseSetId, dispatchId, dispatchedAt]);
      await transaction.query(`
        UPDATE compute.attempts
        SET status = 'dispatched', dispatched_at = $2
        WHERE id = $1 AND status = 'pending'`, [lease.attemptId, dispatchedAt]);
      await transaction.query(`
        UPDATE compute.jobs
        SET status = 'preparing', updated_at = $2
        WHERE id = $1 AND status = 'admitted'`, [lease.jobId, dispatchedAt]);
      return { value: await selectLease(transaction, "lease_set.id = $1", [lease.leaseSetId]) };
    });
    return throwOutcome(outcome);
  }

  async acknowledgeDispatch({ leaseToken, fencingToken, dispatchId, acceptedAt }) {
    const outcome = await this.#database.transaction(async (transaction) => {
      const lease = await selectLease(transaction, "lease_set.lease_token = $1", [leaseToken], true);
      if (!lease || lease.fencingToken !== fencingToken) {
        return { error: { code: "stale_lease_fence", message: "Lease fencing token is stale or unknown" } };
      }
      if (lease.state !== "active" || lease.expiresAt <= acceptedAt) {
        if (lease.state === "active") await closeLeaseSet(transaction, lease, "expired", "lease_expired", acceptedAt);
        return { error: { code: "lease_expired", message: "Dispatch acknowledgement requires an active lease" } };
      }
      if (lease.dispatchId !== dispatchId || !["claimed", "accepted"].includes(lease.dispatchState)) {
        return { error: { code: "dispatch_identity_mismatch", message: "Dispatch acknowledgement does not match the claim" } };
      }
      if (lease.dispatchState === "accepted") return { value: lease };

      await transaction.query(`
        UPDATE compute.lease_sets
        SET dispatch_state = 'accepted', accepted_at = $2
        WHERE id = $1`, [lease.leaseSetId, acceptedAt]);
      await transaction.query(`
        UPDATE compute.attempts
        SET status = 'accepted', acceptance_state = 'accepted_no_output', accepted_at = $2
        WHERE id = $1 AND status = 'dispatched'`, [lease.attemptId, acceptedAt]);
      return { value: await selectLease(transaction, "lease_set.id = $1", [lease.leaseSetId]) };
    });
    return throwOutcome(outcome);
  }

  async releaseLeaseSet({ leaseToken, fencingToken, reason, releasedAt }) {
    const outcome = await this.#database.transaction(async (transaction) => {
      const lease = await selectLease(transaction, "lease_set.lease_token = $1", [leaseToken], true);
      if (!lease || lease.fencingToken !== fencingToken) {
        return { error: { code: "stale_lease_fence", message: "Lease fencing token is stale or unknown" } };
      }
      if (lease.state !== "active") {
        if (lease.nodeExclusive) {
          await completeClosedExclusiveIntent(
            transaction,
            lease.leaseSetId,
            releasedAt,
            lease.releaseReason ?? reason,
          );
        }
        return { value: lease };
      }
      await closeLeaseSet(transaction, lease, "released", reason, releasedAt);
      return { value: await selectLease(transaction, "lease_set.id = $1", [lease.leaseSetId]) };
    });
    return throwOutcome(outcome);
  }

  async reconcileLeaseSets({ reconciledAt }) {
    return this.#database.transaction(async (transaction) => {
      const active = rows(await transaction.query(`${LEASE_SELECT}
        WHERE lease_set.state = 'active'
        ORDER BY lease_set.acquired_at
        FOR UPDATE OF lease_set, attempt, job, node SKIP LOCKED`)).map(mapped);
      const outcomes = [];
      for (const lease of active) {
        let state = null;
        let reason = null;
        if (TERMINAL_JOBS.has(lease.jobStatus)) {
          state = "released";
          reason = "job_terminal";
        } else if (lease.expiresAt <= reconciledAt) {
          state = "expired";
          reason = "lease_expired";
        } else if (lease.nodeLifecycleState !== "ready"
            || lease.currentNodeGeneration !== lease.nodeGeneration) {
          state = "revoked";
          reason = "node_fence_changed";
        }
        if (state) {
          await closeLeaseSet(transaction, lease, state, reason, reconciledAt);
          outcomes.push({ leaseSetId: lease.leaseSetId, state, reason });
        } else {
          await transaction.query(`
            UPDATE compute.lease_sets
            SET reconciliation_count = reconciliation_count + 1,
                last_reconciled_at = $2
            WHERE id = $1`, [lease.leaseSetId, reconciledAt]);
        }
      }

      const closedExclusiveIntents = rows(await transaction.query(`
        SELECT intent.id AS intent_id, intent.lease_set_id, intent.job_id,
               lease_set.state AS lease_state
        FROM compute.node_exclusive_intents intent
        JOIN compute.lease_sets lease_set ON lease_set.id = intent.lease_set_id
        WHERE intent.state = 'acquired' AND lease_set.state <> 'active'
        ORDER BY intent.requested_at
        FOR UPDATE OF intent, lease_set SKIP LOCKED`));
      for (const intent of closedExclusiveIntents) {
        await completeClosedExclusiveIntent(
          transaction,
          intent.lease_set_id,
          reconciledAt,
          "lease_closed",
        );
        outcomes.push({
          intentId: intent.intent_id,
          leaseSetId: intent.lease_set_id,
          state: "completed",
          reason: "lease_closed",
        });
      }

      const orphaned = rows(await transaction.query(`
        SELECT attempt.id AS attempt_id, attempt.job_id, attempt.acceptance_state,
               job.status AS job_status
        FROM compute.attempts attempt
        JOIN compute.jobs job ON job.id = attempt.job_id
        LEFT JOIN compute.lease_sets lease_set
          ON lease_set.attempt_id = attempt.id AND lease_set.state = 'active'
        WHERE attempt.status IN ('pending','dispatched','accepted','running')
          AND lease_set.id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM compute.external_attempt_dispatches external_attempt
            WHERE external_attempt.attempt_id=attempt.id
              AND external_attempt.lifecycle_state IN ('dispatching','accepted','streaming','reconcile_required')
          )
          AND job.status NOT IN ('succeeded','failed','cancelled','expired','incomplete')
        ORDER BY attempt.created_at
        FOR UPDATE OF attempt, job SKIP LOCKED`));
      for (const attempt of orphaned) {
        const accepted = attempt.acceptance_state !== "not_accepted";
        await transaction.query(`
          UPDATE compute.attempts
          SET status = $2, retryable = $3, error_code = 'lease_missing', finished_at = $4
          WHERE id = $1`, [
          attempt.attempt_id,
          accepted ? "incomplete" : "lost",
          !accepted,
          reconciledAt,
        ]);
        await transaction.query(`
          UPDATE compute.jobs
          SET status = $2, current_attempt_id = NULL,
              waiting_reason = CASE WHEN $2 = 'queued' THEN 'lease_missing' ELSE NULL END,
              retry_classification = CASE WHEN $2 = 'incomplete' THEN 'manual_reconcile' ELSE retry_classification END,
              terminal_at = CASE WHEN $2 = 'incomplete' THEN $3 ELSE terminal_at END,
              updated_at = $3
          WHERE id = $1`, [attempt.job_id, accepted ? "incomplete" : "queued", reconciledAt]);
        outcomes.push({
          attemptId: attempt.attempt_id,
          state: "orphaned",
          reason: "lease_missing",
          jobStatus: accepted ? "incomplete" : "queued",
        });
      }
      return outcomes;
    });
  }
}
