function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid");
  return result.rows;
}

function count(value) { return Number(value ?? 0); }
function iso(value) { return value == null ? null : new Date(value).toISOString(); }

function policy(row) {
  if (!row) return null;
  return Object.freeze({
    policyKey: row.policy_key,
    minimumPriority: Number(row.minimum_priority),
    maximumPriority: Number(row.maximum_priority),
    maxQueuedPerOwner: Number(row.max_queued_per_owner),
    maxActivePerOwner: Number(row.max_active_per_owner),
    maxQueuedPerCapability: Number(row.max_queued_per_capability),
    maxDailySubmissionsPerOwner: Number(row.max_daily_submissions_per_owner),
    maxRequestBytes: Number(row.max_request_bytes),
    maxDeadlineMs: Number(row.max_deadline_milliseconds),
    revision: Number(row.revision),
    updatedBy: row.updated_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function job(row) {
  return Object.freeze({
    jobId: row.id,
    ownerIdentityId: row.owner_identity_id,
    capabilityKey: row.capability_key,
    operation: row.operation,
    status: row.status,
    priority: Number(row.priority),
    route: row.route,
    waitingReason: row.waiting_reason,
    attemptCount: Number(row.attempt_count),
    currentAttemptStatus: row.current_attempt_status,
    cancellationRequested: row.cancel_requested_at !== null,
    canCancel: ["queued", "admitted", "preparing", "running"].includes(row.status) && row.cancel_requested_at === null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export class PostgresQueueAdministrationRepository {
  #database;
  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL database adapter with query and transaction is required");
    this.#database = database;
  }

  async getPolicy({ lock = false, executor = this.#database } = {}) {
    return policy(rows(await executor.query(`SELECT * FROM compute.queue_admission_policies WHERE policy_key='default'${lock ? " FOR UPDATE" : ""}`))[0]);
  }

  async submissionPolicy() {
    const value = await this.getPolicy();
    if (!value) throw new Error("default queue admission policy is unavailable");
    return Object.freeze({
      minimumPriority: value.minimumPriority,
      maximumPriority: value.maximumPriority,
      maxQueuedPerOwner: value.maxQueuedPerOwner,
      maxActivePerOwner: value.maxActivePerOwner,
      maxQueuedPerCapability: value.maxQueuedPerCapability,
      maxDailySubmissionsPerOwner: value.maxDailySubmissionsPerOwner,
      maxRequestBytes: value.maxRequestBytes,
      maxDeadlineMs: value.maxDeadlineMs,
    });
  }

  async updatePolicy({ expectedRevision, declaration, actorIdentityId, updatedAt }) {
    return this.#database.transaction(async (transaction) => {
      const current = await this.getPolicy({ lock: true, executor: transaction });
      if (!current || current.revision !== expectedRevision) return null;
      const updated = rows(await transaction.query(`
        UPDATE compute.queue_admission_policies
        SET minimum_priority=$2, maximum_priority=$3,
            max_queued_per_owner=$4, max_active_per_owner=$5,
            max_queued_per_capability=$6, max_daily_submissions_per_owner=$7,
            max_request_bytes=$8, max_deadline_milliseconds=$9,
            updated_by=$10, revision=revision+1, updated_at=$11
        WHERE policy_key='default' AND revision=$1
        RETURNING *`, [
        expectedRevision, declaration.minimumPriority, declaration.maximumPriority,
        declaration.maxQueuedPerOwner, declaration.maxActivePerOwner,
        declaration.maxQueuedPerCapability, declaration.maxDailySubmissionsPerOwner,
        declaration.maxRequestBytes, declaration.maxDeadlineMs,
        actorIdentityId, updatedAt,
      ]))[0];
      return policy(updated);
    });
  }

  async snapshot({ limit }) {
    const [statusResult, waitingResult, priorityResult, infrastructureResult, jobsResult, realtimeResult, exclusiveResult] = await Promise.all([
      this.#database.query(`SELECT status,count(*)::bigint AS count FROM compute.jobs GROUP BY status ORDER BY status`),
      this.#database.query(`SELECT waiting_reason,count(*)::bigint AS count FROM compute.jobs WHERE status IN ('queued','admitted','preparing') AND waiting_reason IS NOT NULL GROUP BY waiting_reason ORDER BY count DESC,waiting_reason`),
      this.#database.query(`SELECT CASE WHEN priority>=80 THEN 'urgent' WHEN priority>=50 THEN 'normal' ELSE 'background' END AS band,count(*)::bigint AS count FROM compute.jobs WHERE status IN ('queued','admitted','preparing','running') GROUP BY band ORDER BY band`),
      this.#database.query(`SELECT
        (SELECT count(*) FROM compute.leases WHERE state='active')::bigint AS active_leases,
        (SELECT count(*) FROM compute.realtime_sessions WHERE state IN ('admitted','connected'))::bigint AS realtime_reservations,
        (SELECT count(*) FROM compute.node_exclusive_intents WHERE state IN ('pending','acquired'))::bigint AS exclusive_intents,
        (SELECT min(created_at) FROM compute.jobs WHERE status='queued') AS oldest_queued_at`),
      this.#database.query(`
        SELECT job.id,job.owner_identity_id,capability.capability_key,job.operation,job.status,
               job.priority,job.route,job.waiting_reason,job.cancel_requested_at,job.created_at,job.updated_at,
               count(attempt.id)::bigint AS attempt_count,
               max(attempt.status) FILTER (WHERE attempt.id=job.current_attempt_id) AS current_attempt_status
        FROM compute.jobs job
        JOIN compute.capabilities capability ON capability.id=job.capability_id
        LEFT JOIN compute.attempts attempt ON attempt.job_id=job.id
        GROUP BY job.id,capability.capability_key
        ORDER BY CASE WHEN job.status IN ('queued','admitted','preparing','running') THEN 0 ELSE 1 END,
                 job.priority DESC,job.created_at DESC
        LIMIT $1`, [limit]),
      this.#database.query(`SELECT id,owner_identity_id,capability_key,state,priority_class,scheduler_priority,
        latency_budget_milliseconds,node_id,route,admitted_at,expires_at
        FROM compute.realtime_sessions ORDER BY admitted_at DESC LIMIT 50`),
      this.#database.query(`SELECT intent.id,intent.job_id,intent.node_id,intent.state,intent.requested_at,intent.deadline_at,
        capability.capability_key FROM compute.node_exclusive_intents intent
        JOIN compute.jobs job ON job.id=intent.job_id
        JOIN compute.capabilities capability ON capability.id=job.capability_id
        ORDER BY intent.requested_at DESC LIMIT 50`),
    ]);
    const infrastructure = rows(infrastructureResult)[0] ?? {};
    return Object.freeze({
      statusCounts: Object.freeze(rows(statusResult).map((item) => Object.freeze({ status: item.status, count: count(item.count) }))),
      waitingReasons: Object.freeze(rows(waitingResult).map((item) => Object.freeze({ reasonCode: item.waiting_reason, count: count(item.count) }))),
      priorityBands: Object.freeze(rows(priorityResult).map((item) => Object.freeze({ band: item.band, count: count(item.count) }))),
      infrastructure: Object.freeze({
        activeLeases: count(infrastructure.active_leases),
        realtimeReservations: count(infrastructure.realtime_reservations),
        exclusiveIntents: count(infrastructure.exclusive_intents),
        oldestQueuedAt: iso(infrastructure.oldest_queued_at),
      }),
      jobs: Object.freeze(rows(jobsResult).map(job)),
      realtimeReservations: Object.freeze(rows(realtimeResult).map((item) => Object.freeze({
        reservationId: item.id, ownerIdentityId: item.owner_identity_id, capabilityKey: item.capability_key,
        state: item.state, priorityClass: item.priority_class, schedulerPriority: Number(item.scheduler_priority),
        latencyBudgetMilliseconds: Number(item.latency_budget_milliseconds), nodeId: item.node_id,
        route: item.route, admittedAt: iso(item.admitted_at), expiresAt: iso(item.expires_at),
      }))),
      exclusiveIntents: Object.freeze(rows(exclusiveResult).map((item) => Object.freeze({
        intentId: item.id, jobId: item.job_id, nodeId: item.node_id, capabilityKey: item.capability_key,
        state: item.state, requestedAt: iso(item.requested_at), deadlineAt: iso(item.deadline_at),
      }))),
    });
  }

  async findJob(jobId) {
    const row = rows(await this.#database.query(`SELECT id,owner_identity_id,status,cancel_requested_at FROM compute.jobs WHERE id=$1`, [jobId]))[0];
    return row ? Object.freeze({
      jobId: row.id, ownerIdentityId: row.owner_identity_id, status: row.status,
      cancellationRequested: row.cancel_requested_at !== null,
    }) : null;
  }
}
