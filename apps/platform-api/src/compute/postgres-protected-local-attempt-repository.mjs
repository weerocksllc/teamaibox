import { PlatformError } from "../../../../packages/observability/src/index.mjs";
import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$/;
const ROUTES = new Set(["local", "managed_node"]);
const ELIGIBLE = new Set(["queued", "admitted", "preparing"]);
const ACTIVE_ATTEMPTS = ["pending", "dispatched", "accepted", "running"];
// Resident weights are already charged to the protected set. Only this
// execution's Worker slot is exclusive; do not reserve the whole node again.
const RESIDENT_EXECUTION_RESERVATION = Object.freeze({ cpuMillis: 0, unifiedMemoryBytes: 0,
  acceleratorUnits: 0, codecSessions: 0, storageBytes: 0, networkBitsPerSecond: 0 });

function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid");
  return result.rows;
}

function conflict(code, message) {
  throw new PlatformError(code, message, { status: 409 });
}

function identity(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export class PostgresProtectedLocalAttemptRepository {
  #database;
  #setId;
  #nodeId;

  constructor({ database, setId, nodeId }) {
    if (!database?.query || !database?.transaction) {
      throw new TypeError("PostgreSQL database adapter with query and transaction is required");
    }
    if (!SET_ID.test(setId ?? "") || !UUID.test(nodeId ?? "")) {
      throw new TypeError("Protected local attempt set identity is invalid");
    }
    this.#database = database;
    this.#setId = setId;
    this.#nodeId = nodeId.toLowerCase();
  }

  async begin({ attemptId, jobId, ownerIdentityId, modelProfileId, workerId, route, startedAt,
    executionTimeoutMilliseconds = 1_800_000 }) {
    if (![attemptId, jobId, ownerIdentityId, modelProfileId, workerId].every((value) => UUID.test(value ?? ""))
        || !ROUTES.has(route) || !(startedAt instanceof Date) || !Number.isFinite(startedAt.getTime())
        || !Number.isSafeInteger(executionTimeoutMilliseconds)
        || executionTimeoutMilliseconds < 1_000 || executionTimeoutMilliseconds > 3_600_000) {
      throw new TypeError("Protected local attempt input is invalid");
    }
    return this.#database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `protected-office-worker:${workerId.toLowerCase()}`,
      ]);
      const boundary = rows(await transaction.query(`
        SELECT job.id,job.owner_identity_id,job.status,job.cancel_requested_at,
               job.current_attempt_id,job.requested_model_profile_id,
               protected_set.node_id,protected_set.recovery_state,
               protected_set.desired_state_revision,protected_set.observed_state_revision,
               protected_set.healthy_identities
        FROM compute.jobs job
        CROSS JOIN compute.protected_office_sets protected_set
        WHERE job.id=$1 AND protected_set.set_id=$2
        FOR UPDATE OF job,protected_set`, [jobId.toLowerCase(), this.#setId]))[0];
      if (!boundary) {
        throw new PlatformError("protected_local_attempt_not_found", "Job or protected office set was not found", { status: 404 });
      }
      if (boundary.owner_identity_id !== ownerIdentityId.toLowerCase()
          || !ELIGIBLE.has(boundary.status) || boundary.cancel_requested_at || boundary.current_attempt_id
          // OpenAI-style callers may name the model without an internal
          // profile UUID. The bridge has resolved the configured local route;
          // below we still require its exact healthy resident identity. Never
          // replace a different profile that the caller explicitly selected.
          || (boundary.requested_model_profile_id !== null
            && boundary.requested_model_profile_id !== modelProfileId.toLowerCase())
          || boundary.node_id !== this.#nodeId || boundary.recovery_state !== "healthy"
          || Number(boundary.observed_state_revision) < 1
          || Number(boundary.observed_state_revision) !== Number(boundary.desired_state_revision)) {
        conflict("protected_local_attempt_boundary_invalid", "Job or protected office set is not eligible for local dispatch");
      }
      let identities = boundary.healthy_identities;
      if (typeof identities === "string") {
        try { identities = JSON.parse(identities); } catch { identities = null; }
      }
      const worker = Array.isArray(identities) ? identities.map(identity).find((item) =>
        item?.workerId === workerId.toLowerCase()) : null;
      if (!worker || worker.modelProfileId !== modelProfileId.toLowerCase()
          || worker.healthy !== true || worker.state !== "running") {
        conflict("protected_local_worker_identity_invalid", "Protected local worker identity is not healthy and exact");
      }
      const node = rows(await transaction.query(`
        SELECT generation,lifecycle_state FROM compute.nodes WHERE id=$1 FOR UPDATE`, [this.#nodeId]))[0];
      if (node?.lifecycle_state !== "ready" || !Number.isSafeInteger(Number(node.generation))
          || Number(node.generation) < 1) {
        conflict("protected_local_node_not_ready", "Protected execution node is not ready");
      }
      const active = rows(await transaction.query(`
        SELECT id,job_id FROM compute.attempts
        WHERE worker_instance_key=$1 AND status=ANY($2::text[])
        ORDER BY created_at,id LIMIT 1 FOR UPDATE`, [workerId.toLowerCase(), ACTIVE_ATTEMPTS]))[0];
      if (active) {
        await transaction.query(`
          UPDATE compute.jobs
          SET status='queued',route='unassigned',waiting_reason='protected_worker_busy',
              progress_sequence=progress_sequence+1,
              progress_message_key='tasks.compute.waiting',updated_at=$2
          WHERE id=$1 AND current_attempt_id IS NULL`, [jobId.toLowerCase(), startedAt]);
        return Object.freeze({ admitted: false, reason: "protected_worker_busy",
          activeAttemptId: active.id, activeJobId: active.job_id });
      }
      const attemptNumber = Number(rows(await transaction.query(`
        SELECT coalesce(max(attempt_number),0)+1 AS value
        FROM compute.attempts WHERE job_id=$1`, [jobId.toLowerCase()]))[0]?.value);
      const fence = Number(rows(await transaction.query(`
        INSERT INTO compute.node_lease_fences (node_id,next_fencing_token) VALUES ($1,2)
        ON CONFLICT (node_id) DO UPDATE
        SET next_fencing_token=compute.node_lease_fences.next_fencing_token+1,updated_at=clock_timestamp()
        RETURNING next_fencing_token-1 AS fencing_token`, [this.#nodeId]))[0]?.fencing_token);
      if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || !Number.isSafeInteger(fence) || fence < 1) {
        throw new PlatformError("protected_local_attempt_fence_invalid", "Protected local attempt fence is invalid", { status: 500 });
      }
      await transaction.query(`
        INSERT INTO compute.attempts (
          id,job_id,attempt_number,status,node_id,model_profile_id,worker_instance_key,
          dispatch_fence,acceptance_state,dispatched_at,accepted_at,started_at,created_at
        ) VALUES ($1,$2,$3,'running',$4,$5,$6,$7,'accepted_no_output',$8,$8,$8,$8)`, [
        attemptId.toLowerCase(), jobId.toLowerCase(), attemptNumber, this.#nodeId,
        modelProfileId.toLowerCase(), workerId.toLowerCase(), fence, startedAt,
      ]);
      await transaction.query(`
        INSERT INTO compute.lease_sets (
          id,acquisition_key,node_id,node_generation,job_id,attempt_id,model_profile_id,
          lease_token,fencing_token,reservation,acquired_at,heartbeat_at,expires_at,
          node_exclusive,dispatch_state,dispatch_id,dispatched_at,accepted_at
        ) VALUES ($1,$2,$3,$4,$5,$2,$6,$7,$8,$9::jsonb,$10,$10,$11,
                  false,'accepted',$2,$10,$10)`, [
        // The execution deadline is enforced by the bridge. A short grace
        // permits terminal persistence; a crashed bridge still expires.
        attemptId.toLowerCase(), attemptId.toLowerCase(), this.#nodeId, Number(node.generation),
        jobId.toLowerCase(), modelProfileId.toLowerCase(), randomUUID(), fence,
        JSON.stringify(RESIDENT_EXECUTION_RESERVATION), startedAt,
        new Date(startedAt.getTime() + executionTimeoutMilliseconds + 60_000),
      ]);
      await transaction.query(`
        INSERT INTO compute.leases (
          resource_kind,resource_key,job_id,attempt_id,lease_token,fencing_token,reservation,
          acquired_at,expires_at,heartbeat_at,lease_set_id,node_id,amount
        ) VALUES ('worker',$1,$2,$3,$4,$5,'{"resourceKey":"protectedWorker","amount":1}'::jsonb,
                  $6,$7,$6,$3,$8,1)`, [
        workerId.toLowerCase(), jobId.toLowerCase(), attemptId.toLowerCase(), randomUUID(), fence,
        startedAt, new Date(startedAt.getTime() + executionTimeoutMilliseconds + 60_000), this.#nodeId,
      ]);
      await transaction.query(`
        UPDATE compute.jobs
        SET status='running',route=$3,current_attempt_id=$2,waiting_reason=NULL,
            requested_model_profile_id=COALESCE(requested_model_profile_id,$5),
            progress_sequence=progress_sequence+1,
            progress_message_key='tasks.state.running',updated_at=$4
        WHERE id=$1`, [jobId.toLowerCase(), attemptId.toLowerCase(), route, startedAt, modelProfileId.toLowerCase()]);
      return Object.freeze({ admitted: true, attemptId: attemptId.toLowerCase(), attemptNumber,
        jobId: jobId.toLowerCase(), nodeId: this.#nodeId, modelProfileId: modelProfileId.toLowerCase(),
        workerId: workerId.toLowerCase(), dispatchFence: fence, route });
    });
  }
}
