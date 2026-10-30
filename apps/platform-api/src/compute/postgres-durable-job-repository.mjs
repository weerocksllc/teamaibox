import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired", "incomplete"]);
const PRE_DISPATCH = new Set(["queued", "admitted", "preparing"]);
const JOB_SELECT = `
SELECT job.*, capability.capability_key
FROM compute.jobs job
JOIN compute.capabilities capability ON capability.id = job.capability_id`;

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

function digest(value) {
  if (value === null || value === undefined) return null;
  return `sha256:${Buffer.from(value).toString("hex")}`;
}

function digestHex(value) {
  if (typeof value !== "string") return null;
  const selected = value.startsWith("sha256:") ? value.slice(7) : value;
  return /^[a-f0-9]{64}$/.test(selected) ? selected : null;
}

function mapped(row) {
  if (!row) return null;
  return {
    jobId: row.id,
    responseId: row.response_id,
    ownerIdentityId: row.owner_identity_id,
    capabilityId: row.capability_id,
    capabilityKey: row.capability_key,
    operation: row.operation,
    requestedModel: row.requested_model,
    requestedModelProfileId: row.requested_model_profile_id,
    status: row.status,
    priority: Number(row.priority),
    route: row.route,
    replayCount: Number(row.replay_count ?? 0),
    idempotency: row.idempotency_key ? { scope: row.idempotency_scope, key: row.idempotency_key } : null,
    requestDigest: digest(row.request_digest),
    requestSizeBytes: row.request_size_bytes === null ? null : Number(row.request_size_bytes),
    requestArtifact: json(row.request_artifact),
    resultArtifact: json(row.result_artifact),
    resultSchema: row.result_schema,
    dataClass: row.data_class,
    progress: {
      revision: Number(row.progress_revision),
      sequence: Number(row.progress_sequence),
      value: Number(row.progress_value),
      messageKey: row.progress_message_key,
    },
    waitingReason: row.waiting_reason,
    currentAttemptId: row.current_attempt_id ?? null,
    retryClassification: row.retry_classification,
    error: json(row.terminal_error),
    correlationId: row.correlation_key ?? String(row.correlation_id),
    deadlineAt: date(row.deadline_at),
    cancelRequestedAt: date(row.cancel_requested_at),
    terminalAt: date(row.terminal_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

function publicState(status) {
  if (["admitted", "preparing"].includes(status)) return "preparing";
  if (status === "succeeded") return "completed";
  if (["expired", "incomplete"].includes(status)) return "failed";
  return status;
}

async function selectJob(executor, clause, values, lock = false) {
  const result = await executor.query(`${JOB_SELECT} WHERE ${clause}${lock ? " FOR UPDATE OF job" : ""}`, values);
  return mapped(rows(result)[0]);
}

async function appendEvent(executor, job, eventKind, {
  eventId = null,
  messageKey = job.progress.messageKey,
  payload = {},
  error = null,
} = {}) {
  await executor.query(`
    INSERT INTO compute.job_events (
      event_id, job_id, event_kind, public_state, progress, progress_revision,
      message_key, error_code, guidance_key, retryable, retry_action, payload
    ) VALUES (
      COALESCE($1::uuid, uuidv7()), $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12::jsonb
    )`, [
    eventId,
    job.jobId,
    eventKind,
    publicState(job.status),
    job.progress.value * 100,
    job.progress.revision,
    messageKey,
    error?.code ?? null,
    error?.guidanceKey ?? null,
    error?.retryable ?? null,
    error?.retryAction ?? null,
    JSON.stringify(payload),
  ]);
}

async function finalizeCurrentAttempt(executor, attemptId, {
  status, acceptanceState = null, retryable = false, errorCode = null, finishedAt, releaseReason,
  resultArtifact = null,
}) {
  if (!attemptId) return;
  const externalLifecycle = status === "succeeded" ? "succeeded"
    : status === "cancelled" ? "cancelled" : status === "incomplete" ? "incomplete" : "failed";
  const externalEvent = status === "succeeded" ? "succeeded"
    : status === "cancelled" ? "cancellation_confirmed" : status === "incomplete" ? "incomplete" : "failed";
  const resultDigest = digestHex(resultArtifact?.integrity?.digest);
  const resultObjectId = resultArtifact?.object?.objectId ?? null;
  const resultObjectVersion = resultArtifact?.object?.objectVersion ?? null;
  const resultSizeBytes = resultArtifact?.sizeBytes ?? null;
  const externalCurrent = rows(await executor.query(`
    SELECT attempt_id FROM compute.external_attempt_dispatches
    WHERE attempt_id=$1 AND lifecycle_state IN ('dispatching','accepted','streaming','reconcile_required')
    FOR UPDATE`, [attemptId]));
  if (externalCurrent.length === 1 && status === "succeeded"
      && (!resultObjectId || !Number.isSafeInteger(resultObjectVersion)
        || resultObjectVersion < 1 || !resultDigest || !Number.isSafeInteger(resultSizeBytes) || resultSizeBytes < 1)) {
    throw new PlatformError("invalid_external_result_artifact", "External attempt result artifact is invalid", { status: 500 });
  }
  const external = externalCurrent.length === 1 ? rows(await executor.query(`
    UPDATE compute.external_attempt_dispatches
    SET lifecycle_state=$2,
        result_object_id=CASE WHEN $2='succeeded' THEN $3::uuid ELSE NULL END,
        result_object_version=CASE WHEN $2='succeeded' THEN $4::integer ELSE NULL END,
        result_sha256=CASE WHEN $2='succeeded' THEN decode($5::text,'hex') ELSE NULL END,
        result_size_bytes=CASE WHEN $2='succeeded' THEN $6::bigint ELSE NULL END,
        error_code=CASE WHEN $2 IN ('failed','incomplete') THEN $7::text ELSE NULL END,
        retry_action=CASE WHEN $2='succeeded' THEN 'none' WHEN $2='incomplete' THEN 'manual_reconcile' ELSE 'terminal' END,
        retry_classification=CASE WHEN $2='incomplete' THEN 'manual_reconcile' ELSE 'terminal' END,
        cancellation_state=CASE WHEN $2='cancelled' THEN 'confirmed' ELSE cancellation_state END,
        cancellation_outcome=CASE WHEN $2='cancelled' THEN 'local_abort' ELSE cancellation_outcome END,
        cancel_requested_at=CASE WHEN $2='cancelled' THEN COALESCE(cancel_requested_at,$8) ELSE cancel_requested_at END,
        finished_at=$8
    WHERE attempt_id=$1 AND lifecycle_state IN ('dispatching','accepted','streaming','reconcile_required')
    RETURNING attempt_id,acceptance_state`, [
    attemptId, externalLifecycle, resultObjectId, resultObjectVersion, resultDigest,
    resultSizeBytes, errorCode ?? `job_${externalLifecycle}`, finishedAt,
  ])) : [];
  if (external.length === 1) {
    await executor.query(`
      INSERT INTO compute.external_attempt_events (
        attempt_id,event_kind,acceptance_state,error_code,retry_action,cancellation_outcome,occurred_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      attemptId, externalEvent, external[0].acceptance_state,
      new Set(["failed", "incomplete"]).has(externalLifecycle) ? errorCode ?? `job_${externalLifecycle}` : null,
      externalLifecycle === "succeeded" ? "none" : externalLifecycle === "incomplete" ? "manual_reconcile" : "terminal",
      externalLifecycle === "cancelled" ? "local_abort" : null, finishedAt,
    ]);
  }
  await executor.query(`
    UPDATE compute.attempts
    SET status=$2,
        acceptance_state=COALESCE($3::text, acceptance_state),
        retryable=$4, error_code=$5,
        started_at=COALESCE(started_at, accepted_at, dispatched_at, created_at),
        finished_at=$6
    WHERE id=$1 AND status IN ('pending','dispatched','accepted','running')`, [
    attemptId, status, acceptanceState, retryable, errorCode, finishedAt,
  ]);
  const released = rows(await executor.query(`
    UPDATE compute.lease_sets
    SET state='released', released_at=$2, release_reason=$3,
        reconciliation_count=reconciliation_count+1, last_reconciled_at=$2
    WHERE attempt_id=$1 AND state='active'
    RETURNING id`, [attemptId, finishedAt, releaseReason]));
  for (const lease of released) {
    await executor.query(`
      UPDATE compute.leases
      SET state='released', released_at=$2
      WHERE lease_set_id=$1 AND state='active'`, [lease.id, finishedAt]);
    await executor.query(`
      UPDATE compute.node_exclusive_intents
      SET state='completed', finished_at=$2, finish_reason=$3
      WHERE lease_set_id=$1 AND state='acquired'`, [lease.id, finishedAt, releaseReason]);
  }
}

export class PostgresDurableJobRepository {
  #database;

  constructor({ database }) {
    if (!database?.query || !database?.transaction) {
      throw new TypeError("PostgreSQL database adapter with query and transaction is required");
    }
    this.#database = database;
  }

  async findIdempotent({ ownerIdentityId, scope, key }) {
    return selectJob(
      this.#database,
      "job.owner_identity_id = $1 AND job.idempotency_scope = $2 AND job.idempotency_key = $3",
      [ownerIdentityId, scope, key],
    );
  }

  async recordReplay({ jobId, ownerIdentityId }) {
    return this.#database.transaction(async (transaction) => {
      const updated = rows(await transaction.query(`
        UPDATE compute.jobs
        SET replay_count = replay_count + 1
        WHERE id = $1 AND owner_identity_id = $2
        RETURNING id`, [jobId, ownerIdentityId]));
      if (updated.length !== 1) return null;
      return selectJob(transaction, "job.id = $1 AND job.owner_identity_id = $2", [jobId, ownerIdentityId]);
    });
  }

  async listOwnedJobs({ ownerIdentityId, limit = 100 }) {
    const result = await this.#database.query(`${JOB_SELECT}
      WHERE job.owner_identity_id = $1
      ORDER BY job.created_at DESC, job.id DESC
      LIMIT $2`, [ownerIdentityId, limit]);
    return rows(result).map(mapped);
  }

  async listDispatchableJobs({ limit = 32 }) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new TypeError("Dispatchable job limit is invalid");
    const result = await this.#database.query(`${JOB_SELECT}
      WHERE job.status IN ('queued','admitted','preparing')
        AND job.cancel_requested_at IS NULL
        AND (job.deadline_at IS NULL OR job.deadline_at > clock_timestamp())
        AND (
          job.waiting_reason IS DISTINCT FROM 'dispatch_failed'
          OR job.updated_at + make_interval(
            secs => power(2, LEAST(4, COALESCE((
              SELECT count(*)::integer
              FROM compute.attempts retry_attempt
              WHERE retry_attempt.job_id = job.id
            ), 0)))::integer
          ) <= clock_timestamp()
        )
      ORDER BY job.priority DESC, job.created_at, job.id
      LIMIT $1`, [limit]);
    return rows(result).map(mapped);
  }

  async listManagedNodeRecoverableJobs({ limit = 32 }) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new TypeError("Recoverable job limit is invalid");
    const result = await this.#database.query(`${JOB_SELECT}
      WHERE job.status = 'running' AND job.route = 'managed_node'
        AND job.current_attempt_id IS NOT NULL
        AND job.cancel_requested_at IS NULL
        AND (job.deadline_at IS NULL OR job.deadline_at > clock_timestamp())
      ORDER BY job.priority DESC, job.created_at, job.id
      LIMIT $1`, [limit]);
    return rows(result).map(mapped);
  }

  async insertJob(job, { quota }) {
    return this.#database.transaction(async (transaction) => {
      await transaction.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0)), pg_advisory_xact_lock(hashtextextended($2, 0))",
        [`compute-owner:${job.ownerIdentityId}`, `compute-capability:${job.capabilityId}`],
      );
      if (job.idempotency) {
        const existing = await selectJob(
          transaction,
          "job.owner_identity_id = $1 AND job.idempotency_scope = $2 AND job.idempotency_key = $3",
          [job.ownerIdentityId, job.idempotency.scope, job.idempotency.key],
          true,
        );
        if (existing) {
          await transaction.query("UPDATE compute.jobs SET replay_count = replay_count + 1 WHERE id = $1", [existing.jobId]);
          return { inserted: false, job: existing };
        }
      }
      const counts = rows(await transaction.query(`
        SELECT
          count(*) FILTER (WHERE owner_identity_id = $1 AND status NOT IN ('succeeded','failed','cancelled','expired','incomplete')) AS owner_open,
          count(*) FILTER (WHERE owner_identity_id = $1 AND status IN ('running')) AS owner_active,
          count(*) FILTER (WHERE capability_id = $2 AND status NOT IN ('succeeded','failed','cancelled','expired','incomplete')) AS capability_open,
          count(*) FILTER (WHERE owner_identity_id = $1 AND created_at >= $3) AS owner_daily
        FROM compute.jobs`, [
        job.ownerIdentityId,
        job.capabilityId,
        new Date(job.createdAt.getTime() - 24 * 60 * 60 * 1000),
      ]))[0];
      if (Number(counts.owner_open) >= quota.maxQueuedPerOwner
        || Number(counts.owner_active) >= quota.maxActivePerOwner
        || Number(counts.capability_open) >= quota.maxQueuedPerCapability
        || Number(counts.owner_daily) >= quota.maxDailySubmissionsPerOwner) {
        throw new PlatformError("compute_quota_exceeded", "Compute submission quota is exhausted", {
          status: 429,
          retryable: true,
        });
      }
      await transaction.query(`
        INSERT INTO compute.jobs (
          id, owner_identity_id, capability_id, requested_model, operation,
          requested_model_profile_id, response_id, status, priority, route,
          idempotency_scope, idempotency_key, request_digest, request_size_bytes,
          request_artifact, request_metadata, data_class, progress_revision,
          progress_sequence, progress_value, progress_message_key, correlation_key,
          deadline_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, 'queued', $8, 'unassigned',
          $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, 1, 0, 0,
          'tasks.state.queued', $16, $17, $18, $18
        )`, [
        job.jobId,
        job.ownerIdentityId,
        job.capabilityId,
        job.requestedModel,
        job.operation,
        job.requestedModelProfileId,
        job.responseId,
        job.priority,
        job.idempotency?.scope ?? null,
        job.idempotency?.key ?? null,
        Buffer.from(job.requestDigest.slice(7), "hex"),
        job.requestSizeBytes,
        JSON.stringify(job.requestArtifact),
        JSON.stringify({ schemaVersion: 1, requestArtifactId: job.requestArtifact.artifactId }),
        job.dataClass,
        job.correlationId,
        job.deadlineAt,
        job.createdAt,
      ]);
      const stored = await selectJob(transaction, "job.id = $1", [job.jobId], true);
      await appendEvent(transaction, stored, "state", {
        eventId: job.initialEventId,
        messageKey: "tasks.state.queued",
      });
      return { inserted: true, job: stored };
    });
  }

  async findOwnedJob({ ownerIdentityId, jobId = null, responseId = null }) {
    return selectJob(
      this.#database,
      `job.owner_identity_id = $1 AND ${jobId ? "job.id = $2" : "job.response_id = $2"}`,
      [ownerIdentityId, jobId ?? responseId],
    );
  }

  async findJob(jobId) {
    return selectJob(this.#database, "job.id = $1", [jobId]);
  }

  async transition({ jobId, allowedFrom, status, now, messageKey, waitingReason = null, route = null }) {
    return this.#database.transaction(async (transaction) => {
      const current = await selectJob(transaction, "job.id = $1", [jobId], true);
      if (!current) return null;
      if (!allowedFrom.includes(current.status)) {
        throw new PlatformError("invalid_job_transition", "Compute job state transition is invalid", { status: 409 });
      }
      await transaction.query(`
        UPDATE compute.jobs
        SET status = $2, waiting_reason = $3,
            route = COALESCE($4::text, route),
            progress_sequence = progress_sequence + 1,
            progress_message_key = $7,
            terminal_at = CASE WHEN $5::boolean THEN $6::timestamptz ELSE NULL::timestamptz END,
            updated_at = $6::timestamptz
        WHERE id = $1`, [jobId, status, waitingReason, route, TERMINAL.has(status), now, messageKey]);
      if (status === "running" && current.currentAttemptId) {
        await transaction.query(`
          UPDATE compute.attempts
          SET status='running', started_at=COALESCE(started_at,$2)
          WHERE id=$1 AND status IN ('accepted','dispatched')`, [current.currentAttemptId, now]);
      }
      if (TERMINAL.has(status) && current.currentAttemptId) {
        await finalizeCurrentAttempt(transaction, current.currentAttemptId, {
          status: status === "cancelled" ? "cancelled" : status === "incomplete" ? "incomplete" : "failed",
          retryable: false,
          errorCode: status === "cancelled" ? null : `job_${status}`,
          finishedAt: now,
          releaseReason: `job_${status}`,
        });
        await transaction.query("UPDATE compute.jobs SET current_attempt_id=NULL WHERE id=$1", [jobId]);
      }
      const updated = await selectJob(transaction, "job.id = $1", [jobId]);
      await appendEvent(transaction, updated, "state", { messageKey });
      return updated;
    });
  }

  async setWaiting({ jobId, waitingReason, now, eventId }) {
    return this.#database.transaction(async (transaction) => {
      const current = await selectJob(transaction, "job.id = $1", [jobId], true);
      if (!current) return null;
      if (TERMINAL.has(current.status) || current.cancelRequestedAt) {
        return { changed: false, job: current };
      }
      // Another execution path has already claimed the job. A scheduler working
      // from an older queued snapshot must not reset its route or waiting state.
      if (current.status === "preparing") return { changed: false, job: current };
      if (!PRE_DISPATCH.has(current.status) || current.currentAttemptId) {
        throw new PlatformError("invalid_job_transition", "Compute job cannot wait after dispatch", { status: 409 });
      }
      if (current.status === "queued" && current.waitingReason === waitingReason) {
        return { changed: false, job: current };
      }
      await transaction.query(`
        UPDATE compute.jobs
        SET status='queued', route='unassigned', waiting_reason=$2,
            progress_sequence=progress_sequence+1,
            progress_message_key='tasks.compute.waiting', updated_at=$3
        WHERE id=$1`, [jobId, waitingReason, now]);
      const updated = await selectJob(transaction, "job.id = $1", [jobId]);
      await appendEvent(transaction, updated, "waiting", {
        eventId,
        messageKey: "tasks.compute.waiting",
        payload: { waitingReason },
      });
      return { changed: true, job: updated };
    });
  }

  async reportProgress({ jobId, progress, messageKey, payload, now, eventId }) {
    return this.#database.transaction(async (transaction) => {
      const current = await selectJob(transaction, "job.id = $1", [jobId], true);
      if (!current) return null;
      if (!["preparing", "running"].includes(current.status)) {
        throw new PlatformError("job_not_running", "Compute progress is not accepted in this state", { status: 409 });
      }
      if (progress < current.progress.value) {
        throw new PlatformError("invalid_job_progress", "Compute progress must be monotonic", { status: 409 });
      }
      await transaction.query(`
        UPDATE compute.jobs
        SET progress_sequence = progress_sequence + 1, progress_value = $2,
            progress_message_key = $3, updated_at = $4
        WHERE id = $1`, [jobId, progress, messageKey, now]);
      const updated = await selectJob(transaction, "job.id = $1", [jobId]);
      await appendEvent(transaction, updated, "progress", { eventId, messageKey, payload });
      return updated;
    });
  }

  async requestCancellation({ ownerIdentityId, jobId, responseId, now, eventId }) {
    return this.#database.transaction(async (transaction) => {
      const clause = `job.owner_identity_id = $1 AND ${jobId ? "job.id = $2" : "job.response_id = $2"}`;
      const current = await selectJob(transaction, clause, [ownerIdentityId, jobId ?? responseId], true);
      if (!current || TERMINAL.has(current.status) || current.cancelRequestedAt) return current;
      const status = PRE_DISPATCH.has(current.status) ? "cancelled" : current.status;
      await transaction.query(`
        UPDATE compute.jobs
        SET cancel_requested_at = $2, status = $3,
            progress_sequence = progress_sequence + 1,
            progress_message_key = 'tasks.cancellation.requested',
            terminal_at = CASE WHEN $3 = 'cancelled' THEN $2 ELSE terminal_at END,
            updated_at = $2
        WHERE id = $1`, [current.jobId, now, status]);
      if (status === "cancelled" && current.currentAttemptId) {
        await finalizeCurrentAttempt(transaction, current.currentAttemptId, {
          status: "cancelled",
          retryable: false,
          finishedAt: now,
          releaseReason: "job_cancelled",
        });
        await transaction.query("UPDATE compute.jobs SET current_attempt_id=NULL WHERE id=$1", [current.jobId]);
      }
      const updated = await selectJob(transaction, "job.id = $1", [current.jobId]);
      await appendEvent(transaction, updated, "cancellation_requested", {
        eventId,
        messageKey: "tasks.cancellation.requested",
      });
      return updated;
    });
  }

  async complete({ jobId, resultArtifact, resultSchema, now, eventId }) {
    return this.#database.transaction(async (transaction) => {
      const current = await selectJob(transaction, "job.id = $1", [jobId], true);
      if (!current) return null;
      if (current.status !== "running") {
        throw new PlatformError("invalid_job_transition", "Only a running job can complete", { status: 409 });
      }
      await finalizeCurrentAttempt(transaction, current.currentAttemptId, {
        status: "succeeded", acceptanceState: "output_observed", retryable: false,
        finishedAt: now, releaseReason: "job_succeeded", resultArtifact,
      });
      await transaction.query(`
        UPDATE compute.jobs
        SET status = 'succeeded', progress_sequence = progress_sequence + 1,
            progress_value = 1, progress_message_key = 'tasks.state.completed',
            result_artifact = $2::jsonb, result_schema = $3,
            result_metadata = $4::jsonb, retry_classification = 'terminal',
            current_attempt_id = NULL, terminal_at = $5, updated_at = $5
        WHERE id = $1`, [
        jobId,
        JSON.stringify(resultArtifact),
        resultSchema,
        JSON.stringify({ schemaVersion: 1, resultArtifactId: resultArtifact.artifactId, resultSchema }),
        now,
      ]);
      const updated = await selectJob(transaction, "job.id = $1", [jobId]);
      await appendEvent(transaction, updated, "result", { eventId, messageKey: "tasks.state.completed" });
      return updated;
    });
  }

  async fail({ jobId, error, retryClassification, status, now, eventId }) {
    return this.#database.transaction(async (transaction) => {
      const current = await selectJob(transaction, "job.id = $1", [jobId], true);
      if (!current || TERMINAL.has(current.status)) return current;
      await finalizeCurrentAttempt(transaction, current.currentAttemptId, {
        status: status === "incomplete" ? "incomplete" : "failed",
        retryable: retryClassification === "retryable",
        errorCode: error.code,
        finishedAt: now,
        releaseReason: status === "incomplete" ? "job_incomplete" : "job_failed",
      });
      await transaction.query(`
        UPDATE compute.jobs
        SET status = $2, terminal_error = $3::jsonb, retry_classification = $4,
            progress_sequence = progress_sequence + 1, progress_message_key = $6,
            current_attempt_id = NULL, terminal_at = $5, updated_at = $5
        WHERE id = $1`, [jobId, status, JSON.stringify(error), retryClassification, now, error.guidanceKey]);
      const updated = await selectJob(transaction, "job.id = $1", [jobId]);
      await appendEvent(transaction, updated, "retry_guidance", {
        eventId,
        messageKey: error.guidanceKey,
        error,
      });
      return updated;
    });
  }

  async expireDeadlines({ now }) {
    return this.#database.transaction(async (transaction) => {
      const due = rows(await transaction.query(`${JOB_SELECT}
        WHERE job.deadline_at <= $1
          AND job.status NOT IN ('succeeded','failed','cancelled','expired','incomplete')
        FOR UPDATE OF job SKIP LOCKED`, [now])).map(mapped);
      const expired = [];
      for (const current of due) {
        const status = current.status === "running" ? "incomplete" : "expired";
        const retry = status === "incomplete" ? "manual_reconcile" : "terminal";
        const error = {
          code: "deadline_exceeded",
          message: "Compute job deadline expired",
          retryable: false,
          guidanceKey: "tasks.compute.deadline_exceeded",
          retryAction: null,
        };
        await transaction.query(`
          UPDATE compute.jobs
          SET status = $2, cancel_requested_at = COALESCE(cancel_requested_at, $3),
              terminal_error = $4::jsonb, retry_classification = $5,
              progress_sequence = progress_sequence + 1, progress_message_key = $6,
              terminal_at = $3, updated_at = $3
          WHERE id = $1`, [current.jobId, status, now, JSON.stringify(error), retry, error.guidanceKey]);
        const updated = await selectJob(transaction, "job.id = $1", [current.jobId]);
        await appendEvent(transaction, updated, "state", { messageKey: error.guidanceKey });
        expired.push(updated);
      }
      return expired;
    });
  }

  async listEvents({ ownerIdentityId, jobId, afterSequence = 0 }) {
    const owned = await this.findOwnedJob({ ownerIdentityId, jobId });
    if (!owned) return null;
    return rows(await this.#database.query(`
      SELECT sequence_id, event_id, job_id, event_kind, public_state,
             progress, progress_revision, message_key, payload, created_at
      FROM compute.job_events
      WHERE job_id = $1 AND sequence_id > $2
      ORDER BY sequence_id`, [jobId, afterSequence])).map((row) => ({
      sequence: Number(row.sequence_id),
      eventId: row.event_id,
      jobId: row.job_id,
      eventKind: row.event_kind,
      publicState: row.public_state,
      progress: Number(row.progress) / 100,
      progressRevision: Number(row.progress_revision),
      messageKey: row.message_key,
      payload: json(row.payload),
      createdAt: date(row.created_at),
    }));
  }
}
