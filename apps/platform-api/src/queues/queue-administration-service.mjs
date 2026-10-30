import { randomUUID } from "node:crypto";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POLICY_FIELDS = new Set([
  "minimumPriority", "maximumPriority", "maxQueuedPerOwner", "maxActivePerOwner",
  "maxQueuedPerCapability", "maxDailySubmissionsPerOwner", "maxRequestBytes", "maxDeadlineSeconds",
]);

function fail(code, message, status = 400) { throw new PlatformError(code, message, { status }); }
function actor(context, permission) {
  const identityId = context?.identityId ?? context?.identity?.id;
  if (!UUID.test(identityId ?? "")) fail("queue_authentication_required", "Authentication is required", 401);
  if (!context?.permissions?.includes(permission)) fail("queue_permission_required", `Missing permission: ${permission}`, 403);
  return identityId.toLowerCase();
}
function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("queue_policy_invalid", `${name} is invalid`);
  return value;
}
function declaration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !POLICY_FIELDS.has(key))
    || Object.keys(value).length !== POLICY_FIELDS.size) fail("queue_policy_invalid", "Complete queue policy declaration is required");
  const result = {
    minimumPriority: integer(value.minimumPriority, "minimumPriority", 0, 100),
    maximumPriority: integer(value.maximumPriority, "maximumPriority", 0, 100),
    maxQueuedPerOwner: integer(value.maxQueuedPerOwner, "maxQueuedPerOwner", 1, Number.MAX_SAFE_INTEGER),
    maxActivePerOwner: integer(value.maxActivePerOwner, "maxActivePerOwner", 1, Number.MAX_SAFE_INTEGER),
    maxQueuedPerCapability: integer(value.maxQueuedPerCapability, "maxQueuedPerCapability", 1, Number.MAX_SAFE_INTEGER),
    maxDailySubmissionsPerOwner: integer(value.maxDailySubmissionsPerOwner, "maxDailySubmissionsPerOwner", 1, Number.MAX_SAFE_INTEGER),
    maxRequestBytes: integer(value.maxRequestBytes, "maxRequestBytes", 1, Number.MAX_SAFE_INTEGER),
    maxDeadlineMs: integer(value.maxDeadlineSeconds, "maxDeadlineSeconds", 60, 30 * 24 * 3600) * 1000,
  };
  if (result.minimumPriority > result.maximumPriority) fail("queue_policy_invalid", "minimumPriority cannot exceed maximumPriority");
  return Object.freeze(result);
}
function visiblePolicy(value) {
  return Object.freeze({
    policyKey: value.policyKey,
    minimumPriority: value.minimumPriority,
    maximumPriority: value.maximumPriority,
    maxQueuedPerOwner: value.maxQueuedPerOwner,
    maxActivePerOwner: value.maxActivePerOwner,
    maxQueuedPerCapability: value.maxQueuedPerCapability,
    maxDailySubmissionsPerOwner: value.maxDailySubmissionsPerOwner,
    maxRequestBytes: value.maxRequestBytes,
    maxDeadlineSeconds: Math.floor(value.maxDeadlineMs / 1000),
    revision: value.revision,
    updatedBy: value.updatedBy,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}

export class QueueAdministrationService {
  #repository; #jobs; #audit; #clock;
  constructor({ repository, jobRepository, audit = async () => {}, clock = () => new Date() }) {
    if (!repository || ["getPolicy", "updatePolicy", "snapshot", "findJob", "submissionPolicy"].some((method) => typeof repository[method] !== "function")
      || typeof jobRepository?.requestCancellation !== "function" || typeof audit !== "function" || typeof clock !== "function") {
      throw new TypeError("queue administration dependencies are incomplete");
    }
    this.#repository = repository; this.#jobs = jobRepository; this.#audit = audit; this.#clock = clock;
  }

  async overview({ context, limit = 100 }) {
    actor(context, "queue:view");
    integer(limit, "limit", 1, 200);
    const [policy, snapshot] = await Promise.all([this.#repository.getPolicy(), this.#repository.snapshot({ limit })]);
    if (!policy) fail("queue_policy_unavailable", "Queue policy is unavailable", 503);
    const total = snapshot.statusCounts.reduce((sum, item) => sum + item.count, 0);
    const active = snapshot.statusCounts.filter((item) => ["queued", "admitted", "preparing", "running"].includes(item.status)).reduce((sum, item) => sum + item.count, 0);
    return Object.freeze({ schemaVersion: 1, generatedAt: this.#clock().toISOString(), policy: visiblePolicy(policy),
      summary: Object.freeze({ totalJobs: total, activeJobs: active, activeLeases: snapshot.infrastructure.activeLeases,
        realtimeReservations: snapshot.infrastructure.realtimeReservations, exclusiveIntents: snapshot.infrastructure.exclusiveIntents,
        oldestQueuedAt: snapshot.infrastructure.oldestQueuedAt }),
      statusCounts: snapshot.statusCounts, waitingReasons: snapshot.waitingReasons, priorityBands: snapshot.priorityBands,
      jobs: snapshot.jobs, realtimeReservations: snapshot.realtimeReservations, exclusiveIntents: snapshot.exclusiveIntents });
  }

  async updatePolicy({ context, expectedRevision, input }) {
    const identityId = actor(context, "queue:manage");
    integer(expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER);
    const normalized = declaration(input);
    const updated = await this.#repository.updatePolicy({ expectedRevision, declaration: normalized, actorIdentityId: identityId, updatedAt: this.#clock() });
    if (!updated) fail("queue_policy_revision_conflict", "Queue policy revision changed", 409);
    await this.#audit({ action: "queue.policy_updated", actorIdentityId: identityId, resourceKind: "queue_policy", resourceId: updated.policyKey,
      revision: updated.revision, minimumPriority: updated.minimumPriority, maximumPriority: updated.maximumPriority,
      maxQueuedPerOwner: updated.maxQueuedPerOwner, maxActivePerOwner: updated.maxActivePerOwner,
      maxQueuedPerCapability: updated.maxQueuedPerCapability, maxDailySubmissionsPerOwner: updated.maxDailySubmissionsPerOwner });
    return visiblePolicy(updated);
  }

  async cancelJob({ context, jobId, confirmation }) {
    const identityId = actor(context, "queue:manage");
    if (!UUID.test(jobId ?? "") || confirmation !== `CANCEL ${jobId}`) fail("queue_job_confirmation_required", "Exact job cancellation confirmation is required", 409);
    const current = await this.#repository.findJob(jobId);
    if (!current) fail("queue_job_not_found", "Queue job was not found", 404);
    if (!["queued", "admitted", "preparing", "running"].includes(current.status) || current.cancellationRequested) {
      fail("queue_job_not_cancellable", "Queue job cannot be cancelled in its current state", 409);
    }
    const updated = await this.#jobs.requestCancellation({ ownerIdentityId: current.ownerIdentityId, jobId, responseId: null,
      now: this.#clock(), eventId: randomUUID() });
    if (!updated) fail("queue_job_not_found", "Queue job was not found", 404);
    await this.#audit({ action: "queue.job_cancellation_requested", actorIdentityId: identityId, resourceKind: "compute_job", resourceId: jobId,
      jobId, jobOwnerIdentityId: current.ownerIdentityId, fromState: current.status, toState: updated.status, success: true });
    return Object.freeze({ jobId, status: updated.status, cancellationRequested: updated.cancelRequestedAt !== null,
      terminalAt: updated.terminalAt?.toISOString() ?? null, updatedAt: updated.updatedAt.toISOString() });
  }
}
