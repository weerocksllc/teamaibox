function rows(result) { return Array.isArray(result?.rows) ? result.rows : []; }
function digestBytes(value) { return Buffer.from(value.slice(7), "hex"); }
function digest(value) { return value == null ? null : `sha256:${Buffer.from(value).toString("hex")}`; }
function mapped(row) {
  if (!row) return null;
  return {
    planId: row.plan_id, requestId: row.request_id, actorIdentityId: row.actor_identity_id,
    mode: row.mode, volumeUuid: row.volume_uuid, headerRevisionBefore: digest(row.header_revision_before),
    automaticSlotId: row.automatic_slot_id, recoverySlotId: row.recovery_slot_id, selectedSlotId: row.selected_slot_id,
    recoveryVerificationId: row.recovery_verification_id,
    recoveryEvidenceDigest: digest(row.recovery_evidence_digest), selectedVerificationId: row.selected_verification_id,
    selectedEvidenceDigest: digest(row.selected_evidence_digest), drainEvidenceDigest: digest(row.drain_evidence_digest),
    simulationEvidenceDigest: digest(row.simulation_evidence_digest), state: row.state, revision: row.revision,
    preparedAt: new Date(row.prepared_at), expiresAt: new Date(row.expires_at),
    headerBackupId: row.header_backup_id, headerBackupDigest: digest(row.header_backup_digest),
    committedAt: row.committed_at == null ? null : new Date(row.committed_at),
    headerRevisionAfter: digest(row.header_revision_after), enabledAt: row.enabled_at == null ? null : new Date(row.enabled_at),
    rollbackPassed: row.rollback_passed, failureCode: row.failure_code, failedAt: row.failed_at == null ? null : new Date(row.failed_at),
  };
}
function same(previous, value) {
  return previous.actorIdentityId === value.actorIdentityId && previous.mode === value.mode
    && previous.recoveryVerificationId === value.recoveryVerificationId
    && previous.selectedVerificationId === value.selectedVerificationId;
}

export class PostgresUnlockTransitionRepository {
  #database;
  constructor({ database }) { if (!database?.query || !database?.transaction) throw new TypeError("unlock transition database must support transactions"); this.#database = database; }
  async createPrepared(value) {
    return this.#database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`unlock-transition:${value.requestId}`]);
      const previous = mapped(rows(await transaction.query("SELECT * FROM security.unlock_protection_transitions WHERE request_id=$1 FOR UPDATE", [value.requestId]))[0]);
      if (previous) {
        if (!same(previous, value)) throw Object.assign(new Error("unlock transition idempotency conflict"), { code: "unlock_transition_conflict" });
        return previous;
      }
      const result = mapped(rows(await transaction.query(`INSERT INTO security.unlock_protection_transitions (
        plan_id,request_id,actor_identity_id,mode,volume_uuid,header_revision_before,
        automatic_slot_id,recovery_slot_id,selected_slot_id,backup_evidence_digest,
        recovery_verification_id,recovery_evidence_digest,selected_verification_id,selected_evidence_digest,
        drain_evidence_digest,simulation_evidence_digest,state,revision,prepared_at,expires_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'prepared',1,$17,$18) RETURNING *`, [
        value.planId, value.requestId, value.actorIdentityId, value.mode, value.volumeUuid, digestBytes(value.headerRevisionBefore),
        value.automaticSlotId, value.recoverySlotId, value.selectedSlotId, null,
        value.recoveryVerificationId, digestBytes(value.recoveryEvidenceDigest), value.selectedVerificationId, digestBytes(value.selectedEvidenceDigest),
        digestBytes(value.drainEvidenceDigest), digestBytes(value.simulationEvidenceDigest), value.preparedAt, value.expiresAt,
      ]))[0]);
      await transaction.query("INSERT INTO security.unlock_protection_transition_events (plan_id,event_kind,revision,occurred_at,facts) VALUES ($1,'prepared',1,$2,$3::jsonb)", [value.planId, value.preparedAt, JSON.stringify({ mode: value.mode })]);
      return result;
    });
  }
  async get(planId) { return mapped(rows(await this.#database.query("SELECT * FROM security.unlock_protection_transitions WHERE plan_id=$1", [planId]))[0]); }
  async latest() {
    return mapped(rows(await this.#database.query("SELECT * FROM security.unlock_protection_transitions ORDER BY prepared_at DESC,plan_id DESC LIMIT 1"))[0]);
  }
  async listRecent(limit = 8) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError("unlock transition list limit is invalid");
    return rows(await this.#database.query("SELECT * FROM security.unlock_protection_transitions ORDER BY prepared_at DESC,plan_id DESC LIMIT $1", [limit])).map(mapped);
  }
  async beginCommit({ planId, expectedRevision, headerBackupId, headerBackupDigest, committedAt }) {
    return this.#database.transaction(async (transaction) => {
      const result = mapped(rows(await transaction.query(`UPDATE security.unlock_protection_transitions SET state='committing',revision=revision+1,header_backup_id=$3,header_backup_digest=$4,committed_at=$5 WHERE plan_id=$1 AND state='prepared' AND revision=$2 RETURNING *`, [planId, expectedRevision, headerBackupId, digestBytes(headerBackupDigest), committedAt]))[0]);
      if (!result) throw Object.assign(new Error("unlock transition is stale"), { code: "unlock_transition_stale" });
      await transaction.query("INSERT INTO security.unlock_protection_transition_events (plan_id,event_kind,revision,occurred_at,facts) VALUES ($1,'committing',$2,$3,$4::jsonb)", [planId, result.revision, committedAt, JSON.stringify({ headerBackupDigest })]);
      return result;
    });
  }
  async complete({ planId, expectedRevision, headerRevisionAfter, enabledAt }) {
    return this.#database.transaction(async (transaction) => {
      const result = mapped(rows(await transaction.query(`UPDATE security.unlock_protection_transitions SET state='enabled',revision=revision+1,header_revision_after=$3,enabled_at=$4 WHERE plan_id=$1 AND state='committing' AND revision=$2 RETURNING *`, [planId, expectedRevision, digestBytes(headerRevisionAfter), enabledAt]))[0]);
      if (!result) throw Object.assign(new Error("unlock transition is stale"), { code: "unlock_transition_stale" });
      await transaction.query("INSERT INTO security.unlock_protection_transition_events (plan_id,event_kind,revision,occurred_at,facts) VALUES ($1,'enabled',$2,$3,'{}'::jsonb)", [planId, result.revision, enabledAt]);
      return result;
    });
  }
  async finishFailure({ planId, expectedRevision, rollbackPassed, failureCode, failedAt }) {
    return this.#database.transaction(async (transaction) => {
      const state = rollbackPassed ? "rolled_back" : "manual_recovery_required";
      const result = mapped(rows(await transaction.query(`UPDATE security.unlock_protection_transitions SET state=$3,revision=revision+1,rollback_passed=$4,failure_code=$5,failed_at=$6 WHERE plan_id=$1 AND state='committing' AND revision=$2 RETURNING *`, [planId, expectedRevision, state, rollbackPassed, failureCode, failedAt]))[0]);
      if (!result) throw Object.assign(new Error("unlock transition is stale"), { code: "unlock_transition_stale" });
      await transaction.query("INSERT INTO security.unlock_protection_transition_events (plan_id,event_kind,revision,occurred_at,facts) VALUES ($1,$2,$3,$4,$5::jsonb)", [planId, state, result.revision, failedAt, JSON.stringify({ failureCode })]);
      return result;
    });
  }
}
