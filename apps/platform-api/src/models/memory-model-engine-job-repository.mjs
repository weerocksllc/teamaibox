import { randomUUID } from "node:crypto";

function copy(value) { return value === null ? null : structuredClone(value); }
function error(code, message) { const value = new Error(message); value.code = code; throw value; }

export class MemoryModelEngineJobRepository {
  #builds = new Map();
  #buildOperations = new Map();
  #buildFingerprints = new Map();
  #deployments = new Map();
  #deploymentOperations = new Map();
  #deploymentFingerprints = new Map();
  #clock;
  #idFactory;

  constructor({ clock = () => new Date(), idFactory = randomUUID } = {}) {
    this.#clock = clock;
    this.#idFactory = idFactory;
  }

  #now() { return this.#clock().toISOString(); }

  async enqueueBuild({ specification, fingerprint, operationKey, requestedBy }) {
    const previousId = this.#buildOperations.get(operationKey);
    if (previousId) {
      const previous = this.#builds.get(previousId);
      if (previous.fingerprint !== fingerprint) error("model_engine_job_conflict", "build operation key has different immutable facts");
      return { job: copy(previous), created: false };
    }
    const existingId = this.#buildFingerprints.get(fingerprint);
    if (existingId) {
      const existing = this.#builds.get(existingId);
      this.#buildOperations.set(operationKey, existingId);
      return { job: copy(existing), created: false };
    }
    const now = this.#now();
    const job = {
      jobId: this.#idFactory(), jobKind: "engine-build", specification: copy(specification),
      fingerprint, state: "queued", requestedBy, operationKey, claim: null,
      result: null, errorCode: null, createdAt: now, updatedAt: now,
    };
    this.#builds.set(job.jobId, job);
    this.#buildOperations.set(operationKey, job.jobId);
    this.#buildFingerprints.set(fingerprint, job.jobId);
    return { job: copy(job), created: true };
  }

  async getBuild(jobId) { return copy(this.#builds.get(jobId) ?? null); }

  async verifyBuildClaim({ jobId, workerId, claimToken }) {
    const job = this.#builds.get(jobId);
    return Boolean(job?.state === "running" && job.claim?.workerId === workerId
      && job.claim?.claimToken === claimToken && job.claim.expiresAt > this.#now());
  }

  async claimBuild({ jobId, workerId, claimToken, expiresAt }) {
    const job = this.#builds.get(jobId);
    if (!job) error("model_engine_job_not_found", "model engine build job was not found");
    if (job.state === "running" && job.claim?.workerId === workerId && job.claim?.claimToken === claimToken) return copy(job);
    if (job.state !== "queued") error("model_engine_job_not_claimable", "model engine build job is not claimable");
    job.state = "running";
    job.claim = { workerId, claimToken, expiresAt };
    job.updatedAt = this.#now();
    return copy(job);
  }

  async completeBuild({ jobId, workerId, claimToken, result }) {
    const job = this.#builds.get(jobId);
    if (!job) error("model_engine_job_not_found", "model engine build job was not found");
    if (job.state === "succeeded") {
      if (JSON.stringify(job.result) !== JSON.stringify(result)) error("model_engine_result_conflict", "completed build result is immutable");
      return copy(job);
    }
    if (!(await this.verifyBuildClaim({ jobId, workerId, claimToken }))) {
      error("model_engine_job_fenced", "model engine build completion is fenced");
    }
    job.state = "succeeded";
    job.result = copy(result);
    job.claim = null;
    job.updatedAt = this.#now();
    return copy(job);
  }

  async failBuild({ jobId, workerId, claimToken, errorCode }) {
    const job = this.#builds.get(jobId);
    if (!job) error("model_engine_job_not_found", "model engine build job was not found");
    if (!(await this.verifyBuildClaim({ jobId, workerId, claimToken }))) error("model_engine_job_fenced", "model engine build failure is fenced");
    job.state = "failed";
    job.errorCode = errorCode;
    job.claim = null;
    job.updatedAt = this.#now();
    return copy(job);
  }

  async enqueueDeployment({ specification, fingerprint, operationKey, requestedBy }) {
    const previousId = this.#deploymentOperations.get(operationKey);
    if (previousId) {
      const previous = this.#deployments.get(previousId);
      if (previous.fingerprint !== fingerprint) error("model_engine_job_conflict", "deployment operation key has different immutable facts");
      return { job: copy(previous), created: false };
    }
    const existingId = this.#deploymentFingerprints.get(fingerprint);
    if (existingId) {
      const existing = this.#deployments.get(existingId);
      this.#deploymentOperations.set(operationKey, existingId);
      return { job: copy(existing), created: false };
    }
    const now = this.#now();
    const job = {
      jobId: this.#idFactory(), jobKind: "engine-deployment", specification: copy(specification),
      fingerprint, state: "queued", requestedBy, operationKey, claim: null,
      result: null, errorCode: null, createdAt: now, updatedAt: now,
    };
    this.#deployments.set(job.jobId, job);
    this.#deploymentOperations.set(operationKey, job.jobId);
    this.#deploymentFingerprints.set(fingerprint, job.jobId);
    return { job: copy(job), created: true };
  }

  async getDeployment(jobId) { return copy(this.#deployments.get(jobId) ?? null); }

  async verifyDeploymentClaim({ jobId, workerId, claimToken }) {
    const job = this.#deployments.get(jobId);
    return Boolean(job?.state === "running" && job.claim?.workerId === workerId
      && job.claim?.claimToken === claimToken && job.claim.expiresAt > this.#now());
  }

  async claimDeployment({ jobId, workerId, claimToken, expiresAt }) {
    const job = this.#deployments.get(jobId);
    if (!job) error("model_engine_job_not_found", "model engine deployment job was not found");
    if (job.state !== "queued") error("model_engine_job_not_claimable", "model engine deployment job is not claimable");
    job.state = "running";
    job.claim = { workerId, claimToken, expiresAt };
    job.updatedAt = this.#now();
    return copy(job);
  }

  async completeDeployment({ jobId, workerId, claimToken, result }) {
    const job = this.#deployments.get(jobId);
    if (!job) error("model_engine_job_not_found", "model engine deployment job was not found");
    if (!(await this.verifyDeploymentClaim({ jobId, workerId, claimToken }))) error("model_engine_job_fenced", "model engine deployment completion is fenced");
    job.state = "succeeded";
    job.result = copy(result);
    job.claim = null;
    job.updatedAt = this.#now();
    return copy(job);
  }

  async failDeployment({ jobId, workerId, claimToken, errorCode }) {
    const job = this.#deployments.get(jobId);
    if (!job) error("model_engine_job_not_found", "model engine deployment job was not found");
    if (!(await this.verifyDeploymentClaim({ jobId, workerId, claimToken }))) error("model_engine_job_fenced", "model engine deployment failure is fenced");
    job.state = "failed";
    job.errorCode = errorCode;
    job.claim = null;
    job.updatedAt = this.#now();
    return copy(job);
  }
}
