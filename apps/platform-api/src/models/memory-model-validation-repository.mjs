import { randomUUID } from "node:crypto";

function copy(value) { return value === null ? null : structuredClone(value); }
function raise(code, message) { const error = new Error(message); error.code = code; throw error; }

export class MemoryModelValidationRepository {
  #runs = new Map();
  #operations = new Map();
  #fingerprints = new Map();
  #clock;
  #idFactory;

  constructor({ clock = () => new Date(), idFactory = randomUUID } = {}) {
    this.#clock = clock; this.#idFactory = idFactory;
  }
  #now() { return this.#clock().toISOString(); }

  async createRun({ plan, fingerprint, operationKey, requestedBy }) {
    const previousId = this.#operations.get(operationKey);
    if (previousId) {
      const previous = this.#runs.get(previousId);
      if (previous.fingerprint !== fingerprint) raise("model_validation_conflict", "validation operation key has different immutable facts");
      return { run: copy(previous), created: false };
    }
    const existingId = this.#fingerprints.get(fingerprint);
    if (existingId) {
      this.#operations.set(operationKey, existingId);
      return { run: copy(this.#runs.get(existingId)), created: false };
    }
    const now = this.#now();
    const run = {
      runId: this.#idFactory(), plan: copy(plan), fingerprint, state: "validating",
      requestedBy, operationKey, currentOrdinal: 0, createdAt: now, updatedAt: now,
      stages: plan.stages.map((stage, ordinal) => ({
        ordinal, stage: stage.stage, specification: copy(stage),
        state: ordinal === 0 ? "queued" : "pending", claim: null, result: null,
        createdAt: now, updatedAt: now,
      })),
    };
    this.#runs.set(run.runId, run); this.#operations.set(operationKey, run.runId);
    this.#fingerprints.set(fingerprint, run.runId);
    return { run: copy(run), created: true };
  }

  async getRun(runId) { return copy(this.#runs.get(runId) ?? null); }

  async claimNextStage({ runId, workerId, claimToken, expiresAt }) {
    const run = this.#runs.get(runId);
    if (!run) raise("model_validation_not_found", "model validation run was not found");
    if (run.state !== "validating") raise("model_validation_not_claimable", "model validation run is terminal");
    const stage = run.stages[run.currentOrdinal];
    if (!stage || stage.state !== "queued") raise("model_validation_not_claimable", "model validation stage is not claimable");
    stage.state = "running"; stage.claim = { workerId, claimToken, expiresAt }; stage.updatedAt = this.#now();
    run.updatedAt = stage.updatedAt;
    return { run: copy(run), stage: copy(stage) };
  }

  async verifyStageClaim({ runId, ordinal, workerId, claimToken }) {
    const run = this.#runs.get(runId); const stage = run?.stages[ordinal];
    return Boolean(stage?.state === "running" && stage.claim?.workerId === workerId
      && stage.claim?.claimToken === claimToken && stage.claim.expiresAt > this.#now());
  }

  async completeStage({ runId, ordinal, workerId, claimToken, result }) {
    const run = this.#runs.get(runId);
    if (!run) raise("model_validation_not_found", "model validation run was not found");
    if (!(await this.verifyStageClaim({ runId, ordinal, workerId, claimToken }))) raise("model_validation_fenced", "model validation completion is fenced");
    if (ordinal !== run.currentOrdinal) raise("model_validation_sequence_conflict", "model validation stage is out of sequence");
    const stage = run.stages[ordinal];
    stage.state = result.outcome;
    stage.result = copy(result);
    stage.claim = null;
    stage.updatedAt = this.#now();
    run.updatedAt = stage.updatedAt;
    if (result.outcome === "passed") {
      if (ordinal === run.stages.length - 1) run.state = "certified";
      else {
        run.currentOrdinal += 1;
        run.stages[run.currentOrdinal].state = "queued";
        run.stages[run.currentOrdinal].updatedAt = stage.updatedAt;
      }
    } else {
      run.state = "failed";
      for (const blocked of run.stages.slice(ordinal + 1)) {
        blocked.state = "blocked";
        blocked.updatedAt = stage.updatedAt;
      }
    }
    return { run: copy(run), stage: copy(stage) };
  }
}
