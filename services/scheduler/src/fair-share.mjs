const DEFAULT_AGING_INTERVAL_MILLISECONDS = 60_000;
const DEFAULT_MAXIMUM_AGING_BOOST = 20;

function finiteNonNegative(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function finitePositive(value, fallback = 1) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function scopeEntry(state, collection, key) {
  if (!key) return null;
  const entries = state?.[collection];
  if (!entries || typeof entries !== "object") return null;
  return entries[key] ?? null;
}

function scopeFacts(scope, scopeId, entry) {
  if (!entry) return null;

  const usage = finiteNonNegative(entry.usage);
  const share = finitePositive(entry.share);
  const activeJobs = finiteNonNegative(entry.activeJobs);
  const concurrencyLimit = Number.isFinite(entry.concurrencyLimit)
    ? finiteNonNegative(entry.concurrencyLimit)
    : null;
  const quotaRemaining = Number.isFinite(entry.quotaRemaining)
    ? entry.quotaRemaining
    : null;

  return {
    scope,
    scopeId,
    usage,
    share,
    normalizedUsage: usage / share,
    activeJobs,
    concurrencyLimit,
    quotaRemaining,
  };
}

/**
 * Calculate hierarchical fair-share state for a queued job.
 *
 * Missing scope records are neutral. A present record is fail-closed for an
 * exhausted quota or concurrency limit. The dominant normalized usage across
 * user, team, and capability scopes drives the score so a flood in any one
 * scope cannot be hidden by another idle scope.
 */
export function calculateQueueFairness(job, state = {}) {
  const facts = [
    scopeFacts("user", job?.ownerIdentityId, scopeEntry(state, "users", job?.ownerIdentityId)),
    scopeFacts("team", job?.teamId, scopeEntry(state, "teams", job?.teamId)),
    scopeFacts("capability", job?.capabilityId, scopeEntry(state, "capabilities", job?.capabilityId)),
  ].filter(Boolean);

  const blocking = [];
  for (const fact of facts) {
    if (fact.concurrencyLimit !== null && fact.activeJobs >= fact.concurrencyLimit) {
      blocking.push({
        code: "scope_concurrency_limit",
        scope: fact.scope,
        scopeId: fact.scopeId,
        activeJobs: fact.activeJobs,
        limit: fact.concurrencyLimit,
      });
    }
    if (fact.quotaRemaining !== null && fact.quotaRemaining <= 0) {
      blocking.push({
        code: "scope_quota_exhausted",
        scope: fact.scope,
        scopeId: fact.scopeId,
        remaining: fact.quotaRemaining,
      });
    }
  }

  const dominantShare = facts.reduce(
    (maximum, fact) => Math.max(maximum, fact.normalizedUsage),
    0,
  );

  return {
    admitted: blocking.length === 0,
    score: blocking.length === 0 ? 1 / (1 + dominantShare) : 0,
    dominantShare,
    scopes: facts,
    blocking,
  };
}

function parseTime(value, name) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${name} must be an ISO-8601 timestamp`);
  }
  return milliseconds;
}

/**
 * Rank durable queued jobs without mutating them.
 *
 * Administrator priority is preserved, bounded wait-time aging prevents an
 * old job from waiting forever, and fair share breaks ties before FIFO. Jobs
 * blocked by explicit quota/concurrency policy are returned separately with a
 * stable reason suitable for the task center.
 */
export function rankQueuedJobs(jobs, state = {}, options = {}) {
  if (!Array.isArray(jobs)) throw new TypeError("jobs must be an array");

  const nowMilliseconds = options.now
    ? parseTime(options.now, "options.now")
    : Date.now();
  const agingIntervalMilliseconds = finitePositive(
    options.agingIntervalMilliseconds,
    DEFAULT_AGING_INTERVAL_MILLISECONDS,
  );
  const maximumAgingBoost = finiteNonNegative(
    options.maximumAgingBoost,
    DEFAULT_MAXIMUM_AGING_BOOST,
  );

  const evaluated = jobs.map((job) => {
    if (!job?.jobId) throw new TypeError("every queued job must have a jobId");
    const submittedMilliseconds = parseTime(job.submittedAt, `job ${job.jobId} submittedAt`);
    const waitMilliseconds = Math.max(0, nowMilliseconds - submittedMilliseconds);
    const agingBoost = Math.min(
      maximumAgingBoost,
      Math.floor(waitMilliseconds / agingIntervalMilliseconds),
    );
    const priority = Math.min(100, Math.max(0, finiteNonNegative(job.priority, 50)));
    const fairness = calculateQueueFairness(job, state);

    return {
      job,
      jobId: job.jobId,
      priority,
      effectivePriority: priority + agingBoost,
      agingBoost,
      waitMilliseconds,
      fairness,
      waitingReason: fairness.admitted ? null : fairness.blocking[0].code,
    };
  });

  const ranked = evaluated
    .filter((entry) => entry.fairness.admitted)
    .sort((left, right) =>
      right.effectivePriority - left.effectivePriority
      || right.fairness.score - left.fairness.score
      || parseTime(left.job.submittedAt, "submittedAt") - parseTime(right.job.submittedAt, "submittedAt")
      || left.jobId.localeCompare(right.jobId),
    );

  const blocked = evaluated
    .filter((entry) => !entry.fairness.admitted)
    .sort((left, right) =>
      parseTime(left.job.submittedAt, "submittedAt") - parseTime(right.job.submittedAt, "submittedAt")
      || left.jobId.localeCompare(right.jobId),
    );

  return { ranked, blocked };
}

