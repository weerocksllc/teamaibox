import { createHash } from "node:crypto";
import { PlatformError } from "../../../packages/observability/src/index.mjs";

function rows(result) { if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid"); return result.rows; }
function date(value) { return value == null ? null : new Date(value); }
function json(value) { return value == null ? null : typeof value === "string" ? JSON.parse(value) : structuredClone(value); }
function digest(value) { return value == null ? null : `sha256:${Buffer.from(value).toString("hex")}`; }
function digestBytes(value) { return value == null ? null : Buffer.from(value.slice(7), "hex"); }
function chain(previous, fact) { return `sha256:${createHash("sha256").update(`${previous ?? ""}\0${fact.sequence}\0${fact.sha256}\0${fact.sizeBytes}`).digest("hex")}`; }
function conflict(code, message) { throw new PlatformError(code, message, { status: 409 }); }

function mapped(row) {
  if (!row) return null;
  return {
    attemptId: row.attempt_id, attemptNumber: Number(row.attempt_number), jobId: row.job_id,
    ownerIdentityId: row.owner_identity_id, providerId: row.provider_id,
    modelProfileId: row.model_profile_id ?? null, providerModel: row.provider_model,
    requestDigest: digest(row.request_digest), idempotencyKey: row.provider_idempotency_key,
    replayContract: json(row.replay_contract), lifecycleState: row.lifecycle_state,
    acceptanceState: row.acceptance_state, providerRequestId: row.provider_request_id,
    cancellationState: row.cancellation_state, cancellationOutcome: row.cancellation_outcome,
    cancelRequestedAt: date(row.cancel_requested_at), lastOutputSequence: Number(row.last_output_sequence),
    observedOutputBytes: Number(row.observed_output_bytes), outputChainDigest: digest(row.output_chain_digest),
    result: row.result_object_id ? { objectId: row.result_object_id, objectVersion: Number(row.result_object_version), sha256: digest(row.result_sha256), sizeBytes: Number(row.result_size_bytes) } : null,
    errorCode: row.error_code, retryAction: row.retry_action, retryClassification: row.retry_classification,
    reconciliationReason: row.reconciliation_reason, reconciled: row.reconciled === true,
    startedAt: date(row.started_at), acceptedAt: date(row.accepted_at), finishedAt: date(row.finished_at), revision: Number(row.revision),
  };
}
function mappedEvent(row) { return { attemptId: row.attempt_id, sequence: Number(row.sequence_id), eventKind: row.event_kind, acceptanceState: row.acceptance_state, outputSequence: row.output_sequence == null ? null : Number(row.output_sequence), sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes), sha256: digest(row.sha256), errorCode: row.error_code, retryAction: row.retry_action, cancellationOutcome: row.cancellation_outcome, occurredAt: date(row.occurred_at) }; }

const SELECT = `
SELECT external.*,attempt.attempt_number,attempt.model_profile_id
FROM compute.external_attempt_dispatches external
JOIN compute.attempts attempt ON attempt.id=external.attempt_id`;

async function selected(executor, attemptId, lock = false) {
  return mapped(rows(await executor.query(`${SELECT} WHERE external.attempt_id=$1${lock ? " FOR UPDATE OF external,attempt" : ""}`, [attemptId]))[0]);
}
async function append(executor, attempt, eventKind, occurredAt, facts = {}) {
  await executor.query(`
    INSERT INTO compute.external_attempt_events (
      attempt_id,event_kind,acceptance_state,output_sequence,size_bytes,sha256,error_code,retry_action,cancellation_outcome,occurred_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
    attempt.attemptId, eventKind, attempt.acceptanceState, facts.outputSequence ?? null,
    facts.sizeBytes ?? null, digestBytes(facts.sha256), facts.errorCode ?? null,
    facts.retryAction ?? null, facts.cancellationOutcome ?? null, occurredAt,
  ]);
}

export class PostgresExternalAttemptRepository {
  #database;
  constructor({ database }) { if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL database adapter with query and transaction is required"); this.#database = database; }

  async begin(value) {
    return this.#database.transaction(async (transaction) => {
      const boundary = rows(await transaction.query(`
        SELECT job.id,job.owner_identity_id,job.status,job.cancel_requested_at,
               job.requested_model_profile_id,
               provider.provider_kind,provider.lifecycle_state,provider.contract_state
        FROM compute.jobs job CROSS JOIN compute.providers provider
        WHERE job.id=$1 AND provider.id=$2
        FOR UPDATE OF job,provider`, [value.jobId, value.providerId]))[0];
      if (!boundary) throw new PlatformError("external_attempt_not_found", "Job or external provider was not found", { status: 404 });
      if (boundary.owner_identity_id !== value.ownerIdentityId || !new Set(["queued", "admitted", "preparing"]).has(boundary.status)
          || boundary.cancel_requested_at || boundary.provider_kind !== "external_openai"
          || (boundary.requested_model_profile_id && boundary.requested_model_profile_id !== value.modelProfileId)
          || boundary.lifecycle_state !== "healthy" || boundary.contract_state !== "passed") {
        conflict("external_attempt_boundary_invalid", "Job or provider is not eligible for external dispatch");
      }
      const active = rows(await transaction.query(`SELECT attempt_id FROM compute.external_attempt_dispatches WHERE job_id=$1 AND lifecycle_state IN ('dispatching','accepted','streaming','reconcile_required') FOR UPDATE`, [value.jobId]))[0];
      if (active) conflict("external_attempt_active", "Job already has an active external attempt");
      const attemptNumber = Number(rows(await transaction.query(`SELECT coalesce(max(attempt_number),0)+1 AS value FROM compute.attempts WHERE job_id=$1`, [value.jobId]))[0].value);
      const fence = Number(rows(await transaction.query(`SELECT nextval('compute.external_dispatch_fence_sequence') AS value`))[0].value);
      await transaction.query(`
        INSERT INTO compute.attempts (id,job_id,attempt_number,status,provider_id,model_profile_id,dispatch_fence,acceptance_state,dispatched_at,created_at)
        VALUES ($1,$2,$3,'dispatched',$4,$5,$6,'not_accepted',$7,$7)`, [value.attemptId, value.jobId, attemptNumber, value.providerId, value.modelProfileId, fence, value.startedAt]);
      const inserted = rows(await transaction.query(`
        INSERT INTO compute.external_attempt_dispatches (
          attempt_id,job_id,owner_identity_id,provider_id,provider_model,request_digest,
          provider_idempotency_key,replay_contract,lifecycle_state,acceptance_state,started_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'dispatching','not_accepted',$9)
        RETURNING *`, [value.attemptId, value.jobId, value.ownerIdentityId, value.providerId,
        value.providerModel, digestBytes(value.requestDigest), value.idempotencyKey,
        JSON.stringify(value.replayContract), value.startedAt]))[0];
      await transaction.query(`UPDATE compute.jobs SET status='running',route='external_provider',current_attempt_id=$2,
        requested_model_profile_id=COALESCE(requested_model_profile_id,$4),waiting_reason=NULL,updated_at=$3 WHERE id=$1`,
      [value.jobId, value.attemptId, value.startedAt, value.modelProfileId]);
      const result = mapped({ ...inserted, attempt_number: attemptNumber, model_profile_id: value.modelProfileId });
      await append(transaction, result, "dispatch_started", value.startedAt);
      return result;
    });
  }

  async get(attemptId) {
    const value = await selected(this.#database, attemptId);
    if (!value) return null;
    const events = rows(await this.#database.query(`SELECT * FROM compute.external_attempt_events WHERE attempt_id=$1 ORDER BY sequence_id`, [attemptId])).map(mappedEvent);
    return { ...value, events };
  }

  async markAccepted(attemptId, { providerRequestId, acceptedAt }) { return this.#database.transaction(async (transaction) => {
    const current = await selected(transaction, attemptId, true); if (!current) throw new PlatformError("external_attempt_not_found", "External attempt was not found", { status: 404 });
    if (current.acceptanceState !== "not_accepted") { if (current.providerRequestId === providerRequestId) return current; conflict("external_acceptance_conflict", "External attempt acceptance facts changed"); }
    const row = rows(await transaction.query(`UPDATE compute.external_attempt_dispatches SET lifecycle_state='accepted',acceptance_state='accepted_no_output',provider_request_id=$2,accepted_at=$3 WHERE attempt_id=$1 RETURNING *`, [attemptId, providerRequestId, acceptedAt]))[0];
    await transaction.query(`UPDATE compute.attempts SET status='accepted',acceptance_state='accepted_no_output',accepted_at=$2 WHERE id=$1`, [attemptId, acceptedAt]);
    const result = mapped({ ...row, attempt_number: current.attemptNumber, model_profile_id: current.modelProfileId }); await append(transaction, result, "accepted", acceptedAt); return result;
  }); }

  async observeOutput(attemptId, fact) { return this.#database.transaction(async (transaction) => {
    const current = await selected(transaction, attemptId, true); if (!current) throw new PlatformError("external_attempt_not_found", "External attempt was not found", { status: 404 });
    if (!new Set(["accepted_no_output", "output_observed"]).has(current.acceptanceState) || fact.sequence !== current.lastOutputSequence + 1) conflict("external_output_sequence_conflict", "External output sequence is invalid");
    const outputChain = chain(current.outputChainDigest, fact);
    const row = rows(await transaction.query(`UPDATE compute.external_attempt_dispatches SET lifecycle_state='streaming',acceptance_state='output_observed',last_output_sequence=$2,observed_output_bytes=observed_output_bytes+$3,output_chain_digest=$4 WHERE attempt_id=$1 RETURNING *`, [attemptId, fact.sequence, fact.sizeBytes, digestBytes(outputChain)]))[0];
    await transaction.query(`UPDATE compute.attempts SET status='running',acceptance_state='output_observed',started_at=coalesce(started_at,$2) WHERE id=$1`, [attemptId, fact.observedAt]);
    const result = mapped({ ...row, attempt_number: current.attemptNumber, model_profile_id: current.modelProfileId }); await append(transaction, result, "output_observed", fact.observedAt, { outputSequence: fact.sequence, sizeBytes: fact.sizeBytes, sha256: fact.sha256 }); return result;
  }); }

  async markUncertain(attemptId, { providerRequestId, observedAt, reason }) { return this.#database.transaction(async (transaction) => {
    const current = await selected(transaction, attemptId, true); if (!current) throw new PlatformError("external_attempt_not_found", "External attempt was not found", { status: 404 });
    if (providerRequestId && current.providerRequestId && providerRequestId !== current.providerRequestId) conflict("external_acceptance_conflict", "Provider request identifier changed");
    const acceptedAt = current.acceptedAt ?? observedAt;
    const row = rows(await transaction.query(`UPDATE compute.external_attempt_dispatches SET lifecycle_state='reconcile_required',acceptance_state='side_effect_uncertain',provider_request_id=coalesce(provider_request_id,$2),accepted_at=coalesce(accepted_at,$3),reconciliation_reason=$4,retry_action='reconcile',retry_classification='manual_reconcile' WHERE attempt_id=$1 RETURNING *`, [attemptId, providerRequestId, acceptedAt, reason]))[0];
    await transaction.query(`UPDATE compute.attempts SET status='incomplete',acceptance_state='side_effect_uncertain',accepted_at=coalesce(accepted_at,$2),finished_at=$2,retryable=false,error_code=$3 WHERE id=$1`, [attemptId, observedAt, reason]);
    const result = mapped({ ...row, attempt_number: current.attemptNumber, model_profile_id: current.modelProfileId }); await append(transaction, result, "side_effect_uncertain", observedAt, { errorCode: reason }); return result;
  }); }

  async succeed(attemptId, { result, finishedAt, reconciled = false }) { return this.#database.transaction(async (transaction) => {
    const current = await selected(transaction, attemptId, true); if (!current) throw new PlatformError("external_attempt_not_found", "External attempt was not found", { status: 404 });
    if (current.lifecycleState === "succeeded") return current;
    const row = rows(await transaction.query(`UPDATE compute.external_attempt_dispatches SET lifecycle_state='succeeded',result_object_id=$2,result_object_version=$3,result_sha256=$4,result_size_bytes=$5,retry_action='none',retry_classification='terminal',reconciled=$6,reconciliation_reason=NULL,finished_at=$7 WHERE attempt_id=$1 RETURNING *`, [attemptId, result.objectId, result.objectVersion, digestBytes(result.sha256), result.sizeBytes, reconciled, finishedAt]))[0];
    await transaction.query(`UPDATE compute.attempts SET status='succeeded',retryable=false,error_code=NULL,finished_at=$2 WHERE id=$1`, [attemptId, finishedAt]);
    await transaction.query(`UPDATE compute.jobs SET status='succeeded',current_attempt_id=NULL,retry_classification='terminal',result_artifact=jsonb_build_object('objectId',$2::text,'objectVersion',$3,'sha256',$4::text,'sizeBytes',$5),terminal_error=NULL,terminal_at=$6,updated_at=$6 WHERE id=$1`, [current.jobId, result.objectId, result.objectVersion, result.sha256, result.sizeBytes, finishedAt]);
    const completed = mapped({ ...row, attempt_number: current.attemptNumber, model_profile_id: current.modelProfileId }); await append(transaction, completed, reconciled ? "reconciled_succeeded" : "succeeded", finishedAt, { sha256: result.sha256, sizeBytes: result.sizeBytes }); return completed;
  }); }

  async fail(attemptId, { errorCode, decision, finishedAt, reconciled = false }) { return this.#database.transaction(async (transaction) => {
    const current = await selected(transaction, attemptId, true); if (!current) throw new PlatformError("external_attempt_not_found", "External attempt was not found", { status: 404 });
    const lifecycle = decision.action === "reconcile" ? "reconcile_required" : decision.action === "manual_reconcile" ? "incomplete" : "failed";
    const terminalAt = lifecycle === "reconcile_required" ? null : finishedAt;
    const row = rows(await transaction.query(`UPDATE compute.external_attempt_dispatches SET lifecycle_state=$2,error_code=$3,retry_action=$4,retry_classification=$5,reconciliation_reason=CASE WHEN $2='reconcile_required' THEN $3 ELSE reconciliation_reason END,reconciled=$6,finished_at=$7 WHERE attempt_id=$1 RETURNING *`, [attemptId, lifecycle, errorCode, decision.action, decision.retryClassification, reconciled, terminalAt]))[0];
    const retryable = new Set(["failover", "retry_same_provider"]).has(decision.action);
    await transaction.query(`UPDATE compute.attempts SET status=$2,retryable=$3,error_code=$4,finished_at=$5 WHERE id=$1`, [attemptId, lifecycle === "reconcile_required" || lifecycle === "incomplete" ? "incomplete" : "failed", retryable, errorCode, finishedAt]);
    const jobStatus = retryable ? "queued" : decision.retryClassification === "manual_reconcile" ? "incomplete" : "failed";
    await transaction.query(`UPDATE compute.jobs SET status=$2,current_attempt_id=NULL,waiting_reason=$3,retry_classification=$4,terminal_error=CASE WHEN $2='queued' THEN NULL ELSE jsonb_build_object('code',$5::text,'message','External provider attempt did not complete safely','retryable',$6::boolean,'guidanceKey',CASE WHEN $4='manual_reconcile' THEN 'tasks.compute.manual_reconcile' ELSE 'tasks.compute.failed' END) END,terminal_at=CASE WHEN $2='queued' THEN NULL ELSE $7::timestamptz END,updated_at=$7::timestamptz WHERE id=$1`, [current.jobId, jobStatus, retryable ? decision.action : null, decision.retryClassification, errorCode, retryable, finishedAt]);
    const failed = mapped({ ...row, attempt_number: current.attemptNumber, model_profile_id: current.modelProfileId }); await append(transaction, failed, lifecycle, finishedAt, { errorCode, retryAction: decision.action }); return failed;
  }); }

  async requestCancellation(attemptId, { requestedAt }) { return this.#database.transaction(async (transaction) => {
    const current = await selected(transaction, attemptId, true); if (!current) throw new PlatformError("external_attempt_not_found", "External attempt was not found", { status: 404 });
    if (current.cancelRequestedAt) return current;
    const row = rows(await transaction.query(`UPDATE compute.external_attempt_dispatches SET cancellation_state='requested',cancel_requested_at=$2 WHERE attempt_id=$1 RETURNING *`, [attemptId, requestedAt]))[0];
    await transaction.query(`UPDATE compute.jobs SET cancel_requested_at=coalesce(cancel_requested_at,$2),updated_at=$2 WHERE id=$1`, [current.jobId, requestedAt]);
    const result = mapped({ ...row, attempt_number: current.attemptNumber, model_profile_id: current.modelProfileId }); await append(transaction, result, "cancellation_requested", requestedAt); return result;
  }); }

  async setCancellation(attemptId, { state, outcome, observedAt }) { return this.#database.transaction(async (transaction) => {
    const current = await selected(transaction, attemptId, true); if (!current) throw new PlatformError("external_attempt_not_found", "External attempt was not found", { status: 404 });
    const lifecycle = state === "confirmed" ? "cancelled" : current.lifecycleState;
    const row = rows(await transaction.query(`UPDATE compute.external_attempt_dispatches SET cancellation_state=$2,cancellation_outcome=$3,lifecycle_state=$4,retry_action=CASE WHEN $2='confirmed' THEN 'none' ELSE retry_action END,retry_classification=CASE WHEN $2='confirmed' THEN 'terminal' ELSE retry_classification END,finished_at=CASE WHEN $2='confirmed' THEN $5 ELSE finished_at END WHERE attempt_id=$1 RETURNING *`, [attemptId, state, outcome, lifecycle, observedAt]))[0];
    if (state === "confirmed") { await transaction.query(`UPDATE compute.attempts SET status='cancelled',retryable=false,finished_at=$2 WHERE id=$1`, [attemptId, observedAt]); await transaction.query(`UPDATE compute.jobs SET status='cancelled',current_attempt_id=NULL,retry_classification='terminal',terminal_at=$2,updated_at=$2 WHERE id=$1`, [current.jobId, observedAt]); }
    const result = mapped({ ...row, attempt_number: current.attemptNumber, model_profile_id: current.modelProfileId }); await append(transaction, result, `cancellation_${state}`, observedAt, { cancellationOutcome: outcome }); return result;
  }); }

  async requireReconciliation(attemptId, { reason, observedAt, cancellationState }) { return this.#database.transaction(async (transaction) => {
    const current = await selected(transaction, attemptId, true); if (!current) throw new PlatformError("external_attempt_not_found", "External attempt was not found", { status: 404 });
    const row = rows(await transaction.query(`UPDATE compute.external_attempt_dispatches SET lifecycle_state='reconcile_required',retry_action='reconcile',retry_classification='manual_reconcile',reconciliation_reason=$2,cancellation_state=$3,finished_at=NULL WHERE attempt_id=$1 RETURNING *`, [attemptId, reason, cancellationState]))[0];
    await transaction.query(`UPDATE compute.attempts SET status='incomplete',retryable=false,error_code=$2,finished_at=$3 WHERE id=$1`, [attemptId, reason, observedAt]);
    await transaction.query(`UPDATE compute.jobs SET status='incomplete',current_attempt_id=NULL,retry_classification='manual_reconcile',terminal_error=jsonb_build_object('code',$2::text,'message','External provider state requires reconciliation','retryable',false,'guidanceKey','tasks.compute.manual_reconcile'),terminal_at=$3,updated_at=$3 WHERE id=$1`, [current.jobId, reason, observedAt]);
    const result = mapped({ ...row, attempt_number: current.attemptNumber, model_profile_id: current.modelProfileId }); await append(transaction, result, "reconcile_required", observedAt, { errorCode: reason }); return result;
  }); }

  async history(jobId) {
    const attempts = rows(await this.#database.query(`${SELECT} WHERE external.job_id=$1 ORDER BY attempt.attempt_number`, [jobId])).map(mapped);
    if (!attempts.length) return [];
    const events = rows(await this.#database.query(`SELECT * FROM compute.external_attempt_events WHERE attempt_id=ANY($1::uuid[]) ORDER BY attempt_id,sequence_id`, [attempts.map((item) => item.attemptId)])).map(mappedEvent);
    return attempts.map((attempt) => ({ ...attempt, events: events.filter((event) => event.attemptId === attempt.attemptId) }));
  }
}
