function clone(value) { return value ? structuredClone(value) : null; }

export class MemoryUnlockTransitionRepository {
  #plans = new Map(); #requests = new Map();
  async createPrepared(value) {
    const previousId = this.#requests.get(value.requestId);
    if (previousId) {
      const previous = this.#plans.get(previousId);
      const same = previous.actorIdentityId === value.actorIdentityId && previous.mode === value.mode && previous.recoveryVerificationId === value.recoveryVerificationId && previous.selectedVerificationId === value.selectedVerificationId;
      if (!same) throw Object.assign(new Error("unlock transition idempotency conflict"), { code: "unlock_transition_conflict" });
      return clone(previous);
    }
    this.#plans.set(value.planId, clone(value)); this.#requests.set(value.requestId, value.planId); return clone(value);
  }
  async get(planId) { return clone(this.#plans.get(planId)); }
  async beginCommit({ planId, expectedRevision, headerBackupId, headerBackupDigest, committedAt }) {
    const value = this.#plans.get(planId);
    if (!value || value.state !== "prepared" || value.revision !== expectedRevision) throw Object.assign(new Error("unlock transition is stale"), { code: "unlock_transition_stale" });
    Object.assign(value, { state: "committing", revision: value.revision + 1, headerBackupId, headerBackupDigest, committedAt });
    return clone(value);
  }
  async complete({ planId, expectedRevision, headerRevisionAfter, enabledAt }) {
    const value = this.#plans.get(planId);
    if (!value || value.state !== "committing" || value.revision !== expectedRevision) throw Object.assign(new Error("unlock transition is stale"), { code: "unlock_transition_stale" });
    Object.assign(value, { state: "enabled", revision: value.revision + 1, headerRevisionAfter, enabledAt });
    return clone(value);
  }
  async finishFailure({ planId, expectedRevision, rollbackPassed, failureCode, failedAt }) {
    const value = this.#plans.get(planId);
    if (!value || value.state !== "committing" || value.revision !== expectedRevision) throw Object.assign(new Error("unlock transition is stale"), { code: "unlock_transition_stale" });
    Object.assign(value, { state: rollbackPassed ? "rolled_back" : "manual_recovery_required", revision: value.revision + 1, rollbackPassed, failureCode, failedAt });
    return clone(value);
  }
}
