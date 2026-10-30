import assert from "node:assert/strict";
import { test } from "node:test";

import { PostgresDurableJobRepository } from "../src/compute/postgres-durable-job-repository.mjs";

const jobId = "11111111-1111-4111-8111-111111111111";
const ownerIdentityId = "22222222-2222-4222-8222-222222222222";
const capabilityId = "33333333-3333-4333-8333-333333333333";

function row(overrides = {}) {
  return {
    id: jobId,
    response_id: "resp_postgres_contract_0001",
    owner_identity_id: ownerIdentityId,
    capability_id: capabilityId,
    capability_key: "chat",
    operation: "responses",
    requested_model: "local/reasoning",
    requested_model_profile_id: null,
    status: "queued",
    priority: 60,
    route: "unassigned",
    replay_count: "0",
    idempotency_scope: "chat:responses",
    idempotency_key: "postgres-contract",
    request_digest: Buffer.alloc(32, 1),
    request_size_bytes: 128,
    request_artifact: { artifactId: "44444444-4444-4444-8444-444444444444" },
    result_artifact: null,
    result_schema: null,
    data_class: "confidential",
    progress_revision: 1,
    progress_sequence: 0,
    progress_value: "0",
    progress_message_key: "tasks.state.queued",
    waiting_reason: null,
    retry_classification: null,
    terminal_error: null,
    correlation_key: "request-postgres-contract",
    correlation_id: "55555555-5555-4555-8555-555555555555",
    deadline_at: "2026-08-10T01:00:00.000Z",
    cancel_requested_at: null,
    terminal_at: null,
    created_at: "2026-08-10T00:00:00.000Z",
    updated_at: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

test("PostgreSQL projection maps durable queue fields without loading request plaintext", async () => {
  const queries = [];
  const database = {
    async query(sql, values) {
      queries.push({ sql, values });
      return { rows: [row()] };
    },
    async transaction(operation) { return operation(this); },
  };
  const repository = new PostgresDurableJobRepository({ database });
  const job = await repository.findIdempotent({
    ownerIdentityId,
    scope: "chat:responses",
    key: "postgres-contract",
  });
  assert.equal(job.jobId, jobId);
  assert.equal(job.requestDigest, `sha256:${"01".repeat(32)}`);
  assert.equal(job.progress.value, 0);
  assert.equal("request" in job, false);
  assert.match(queries[0].sql, /compute\.jobs/);
  assert.equal(queries[0].sql.includes("request_payload"), false);
});

test("PostgreSQL idempotent replay increments the durable audit counter atomically", async () => {
  const queries = [];
  const database = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes("UPDATE compute.jobs")) return { rows: [{ id: jobId }] };
      if (sql.includes("JOIN compute.capabilities")) return { rows: [row({ replay_count: "1" })] };
      return { rows: [] };
    },
    async transaction(operation) { return operation(this); },
  };
  const repository = new PostgresDurableJobRepository({ database });
  const replayed = await repository.recordReplay({ jobId, ownerIdentityId });
  assert.equal(replayed.jobId, jobId);
  assert.equal(replayed.replayCount, 1);
  assert.match(queries[0].sql, /replay_count = replay_count \+ 1/);
  assert.deepEqual(queries[0].values, [jobId, ownerIdentityId]);
});

test("PostgreSQL own-task query is owner-scoped, bounded, and newest first", async () => {
  const queries = [];
  const database = {
    async query(sql, values) { queries.push({ sql, values }); return { rows: [row()] }; },
    async transaction(operation) { return operation(this); },
  };
  const repository = new PostgresDurableJobRepository({ database });
  const result = await repository.listOwnedJobs({ ownerIdentityId, limit: 25 });
  assert.equal(result[0].ownerIdentityId, ownerIdentityId);
  assert.deepEqual(queries[0].values, [ownerIdentityId, 25]);
  assert.match(queries[0].sql, /owner_identity_id = \$1/);
  assert.match(queries[0].sql, /ORDER BY job\.created_at DESC, job\.id DESC/);
  assert.match(queries[0].sql, /LIMIT \$2/);
  assert.equal(queries[0].sql.includes("request_payload"), false);
});

test("PostgreSQL reconciliation query is bounded, ordered, and excludes cancelled or expired work", async () => {
  const calls = [];
  const database = {
    async query(text, values) { calls.push({ text, values }); return { rows: [row()] }; },
    async transaction(operation) { return operation(this); },
  };
  const repository = new PostgresDurableJobRepository({ database });
  const jobs = await repository.listDispatchableJobs({ limit: 17 });
  assert.equal(jobs.length, 1);
  assert.match(calls[0].text, /status IN \('queued','admitted','preparing'\)/);
  assert.doesNotMatch(calls[0].text, /asr_shard_plans|job\.status='running'/);
  assert.match(calls[0].text, /cancel_requested_at IS NULL/);
  assert.match(calls[0].text, /deadline_at > clock_timestamp\(\)/);
  assert.match(calls[0].text, /waiting_reason IS DISTINCT FROM 'dispatch_failed'/);
  assert.match(calls[0].text, /FROM compute\.attempts retry_attempt/);
  assert.match(calls[0].text, /power\(2, LEAST\(4/);
  assert.match(calls[0].text, /priority DESC, job\.created_at, job\.id/);
  assert.deepEqual(calls[0].values, [17]);
});

test("PostgreSQL insertion locks owner/capability, checks quota, and commits job plus first event", async () => {
  const queries = [];
  const database = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (sql.includes("count(*) FILTER")) {
        return { rows: [{ owner_open: 0, owner_active: 0, capability_open: 0, owner_daily: 0 }] };
      }
      if (sql.includes("JOIN compute.capabilities") && sql.includes("idempotency_scope")) return { rows: [] };
      if (sql.includes("JOIN compute.capabilities")) return { rows: [row()] };
      return { rows: [] };
    },
    async transaction(operation) { return operation(this); },
  };
  const repository = new PostgresDurableJobRepository({ database });
  const inserted = await repository.insertJob({
    jobId,
    responseId: "resp_postgres_contract_0001",
    ownerIdentityId,
    capabilityId,
    capabilityKey: "chat",
    operation: "responses",
    requestedModel: "local/reasoning",
    requestedModelProfileId: null,
    priority: 60,
    idempotency: { scope: "chat:responses", key: "postgres-contract" },
    requestDigest: `sha256:${"01".repeat(32)}`,
    requestSizeBytes: 128,
    requestArtifact: { artifactId: "44444444-4444-4444-8444-444444444444" },
    dataClass: "confidential",
    correlationId: "request-postgres-contract",
    deadlineAt: new Date("2026-08-10T01:00:00.000Z"),
    initialEventId: "66666666-6666-4666-8666-666666666666",
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
  }, {
    quota: {
      maxQueuedPerOwner: 64,
      maxActivePerOwner: 4,
      maxQueuedPerCapability: 256,
      maxDailySubmissionsPerOwner: 1000,
    },
  });
  assert.equal(inserted.inserted, true);
  assert.equal(inserted.job.jobId, jobId);
  assert.ok(queries.some(({ sql }) => sql.includes("pg_advisory_xact_lock")));
  assert.ok(queries.some(({ sql }) => sql.includes("INSERT INTO compute.jobs")));
  assert.ok(queries.some(({ sql }) => sql.includes("INSERT INTO compute.job_events")));
  assert.equal(JSON.stringify(queries).includes("confidential launch plan"), false);
});

test("PostgreSQL quota rejection occurs before job insertion", async () => {
  const queries = [];
  const database = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (sql.includes("idempotency_scope")) return { rows: [] };
      if (sql.includes("count(*) FILTER")) {
        return { rows: [{ owner_open: 64, owner_active: 0, capability_open: 64, owner_daily: 64 }] };
      }
      return { rows: [] };
    },
    async transaction(operation) { return operation(this); },
  };
  const repository = new PostgresDurableJobRepository({ database });
  await assert.rejects(repository.insertJob({
    jobId,
    ownerIdentityId,
    capabilityId,
    idempotency: { scope: "chat:responses", key: "postgres-contract" },
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
  }, {
    quota: {
      maxQueuedPerOwner: 64,
      maxActivePerOwner: 4,
      maxQueuedPerCapability: 256,
      maxDailySubmissionsPerOwner: 1000,
    },
  }), (error) => error.code === "compute_quota_exceeded" && error.status === 429);
  assert.equal(queries.some(({ sql }) => sql.includes("INSERT INTO compute.jobs")), false);
});

test("PostgreSQL state transition pins parameter types and persists the selected physical route", async () => {
  const queries = [];
  let selected = 0;
  const database = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes("JOIN compute.capabilities")) {
        selected += 1;
        return { rows: [row(selected > 1 ? { status: "preparing", route: "local", waiting_reason: "worker_preparing" } : {})] };
      }
      return { rows: [] };
    },
    async transaction(operation) { return operation(this); },
  };
  const repository = new PostgresDurableJobRepository({ database });
  const transitioned = await repository.transition({
    jobId,
    allowedFrom: ["queued", "admitted"],
    status: "preparing",
    waitingReason: "worker_preparing",
    route: "local",
    now: new Date("2026-08-10T00:01:00.000Z"),
    messageKey: "tasks.state.preparing",
  });
  assert.equal(transitioned.status, "preparing");
  assert.equal(transitioned.route, "local");
  const update = queries.find(({ sql }) => sql.includes("UPDATE compute.jobs"));
  assert.match(update.sql, /\$4::text/);
  assert.match(update.sql, /\$5::boolean/);
  assert.match(update.sql, /\$6::timestamptz/);
  assert.match(update.sql, /progress_message_key = \$7/);
  assert.equal(update.values[3], "local");
  assert.equal(update.values[6], "tasks.state.preparing");
});

test("PostgreSQL scheduler waiting state is persisted once with an actionable event", async () => {
  const queries = [];
  let selected = 0;
  const database = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes("JOIN compute.capabilities")) {
        selected += 1;
        return { rows: [row(selected > 1
          ? { waiting_reason: "insufficient_resource_capacity", progress_sequence: 1,
            progress_message_key: "tasks.compute.waiting" }
          : {})] };
      }
      return { rows: [] };
    },
    async transaction(operation) { return operation(this); },
  };
  const repository = new PostgresDurableJobRepository({ database });
  const result = await repository.setWaiting({
    jobId,
    waitingReason: "insufficient_resource_capacity",
    now: new Date("2026-08-10T00:01:00.000Z"),
    eventId: "66666666-6666-4666-8666-666666666666",
  });
  assert.equal(result.changed, true);
  assert.equal(result.job.waitingReason, "insufficient_resource_capacity");
  const update = queries.find(({ sql }) => sql.includes("SET status='queued'"));
  assert.deepEqual(update.values.slice(0, 2), [jobId, "insufficient_resource_capacity"]);
  assert.ok(queries.some(({ sql }) => sql.includes("INSERT INTO compute.job_events")));
});

test("PostgreSQL scheduler waiting state cannot reset a preparing route", async () => {
  const queries = [];
  const database = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes("JOIN compute.capabilities")) {
        return { rows: [row({ status: "preparing", route: "external_provider", waiting_reason: "external_provider_preparing" })] };
      }
      return { rows: [] };
    },
    async transaction(operation) { return operation(this); },
  };
  const repository = new PostgresDurableJobRepository({ database });
  const result = await repository.setWaiting({
    jobId, waitingReason: "no_eligible_target", now: new Date("2026-08-10T00:01:00.000Z"),
    eventId: "77777777-7777-4777-8777-777777777777",
  });
  assert.equal(result.changed, false);
  assert.equal(result.job.status, "preparing");
  assert.equal(result.job.route, "external_provider");
  assert.equal(queries.some(({ sql }) => sql.includes("SET status='queued'")), false);
});

test("PostgreSQL terminal success persists the completed progress message", async () => {
  const queries = [];
  let selected = 0;
  const database = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes("JOIN compute.capabilities")) {
        selected += 1;
        return { rows: [row(selected > 1
          ? { status: "succeeded", progress_sequence: 2, progress_value: "1", progress_message_key: "tasks.state.completed" }
          : { status: "running", progress_sequence: 1, progress_message_key: "tasks.state.running" })] };
      }
      return { rows: [] };
    },
    async transaction(operation) { return operation(this); },
  };
  const repository = new PostgresDurableJobRepository({ database });
  const completed = await repository.complete({
    jobId,
    resultArtifact: { artifactId: "44444444-4444-4444-8444-444444444444" },
    resultSchema: "teamaibox.worker-result.v1",
    now: new Date("2026-08-10T00:02:00.000Z"),
    eventId: "66666666-6666-4666-8666-666666666666",
  });
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.progress.messageKey, "tasks.state.completed");
  const update = queries.find(({ sql }) => sql.includes("SET status = 'succeeded'"));
  assert.match(update.sql, /progress_value = 1, progress_message_key = 'tasks\.state\.completed'/);
});

test("PostgreSQL terminal success closes an acquired exclusive intent with its lease", async () => {
  const queries = [];
  let selected = 0;
  const database = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes("JOIN compute.capabilities")) {
        selected += 1;
        return { rows: [row(selected > 1
          ? { status: "succeeded", progress_value: "1", progress_message_key: "tasks.state.completed" }
          : { status: "running", current_attempt_id: "77777777-7777-4777-8777-777777777777" })] };
      }
      if (sql.includes("UPDATE compute.lease_sets") && sql.includes("RETURNING id")) {
        return { rows: [{ id: "88888888-8888-4888-8888-888888888888" }] };
      }
      return { rows: [] };
    },
    async transaction(operation) { return operation(this); },
  };
  const repository = new PostgresDurableJobRepository({ database });
  await repository.complete({
    jobId,
    resultArtifact: { artifactId: "44444444-4444-4444-8444-444444444444" },
    resultSchema: "teamaibox.worker-result.v1",
    now: new Date("2026-08-10T00:02:00.000Z"),
    eventId: "66666666-6666-4666-8666-666666666666",
  });
  const intent = queries.find(({ sql }) => sql.includes("UPDATE compute.node_exclusive_intents"));
  assert.ok(intent);
  assert.match(intent.sql, /state='completed'/);
  assert.deepEqual(intent.values, ["88888888-8888-4888-8888-888888888888",
    new Date("2026-08-10T00:02:00.000Z"), "job_succeeded"]);
});

test("PostgreSQL pre-dispatch cancellation atomically finalizes its attempt and lease", async () => {
  const attemptId = "77777777-7777-4777-8777-777777777777";
  const leaseSetId = "88888888-8888-4888-8888-888888888888";
  const queries = [];
  let selected = 0;
  const database = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes("JOIN compute.capabilities")) {
        selected += 1;
        return { rows: [row(selected > 1
          ? { status: "cancelled", current_attempt_id: null,
            cancel_requested_at: "2026-08-10T00:02:00.000Z", terminal_at: "2026-08-10T00:02:00.000Z" }
          : { status: "admitted", route: "managed_node", current_attempt_id: attemptId })] };
      }
      if (sql.includes("UPDATE compute.lease_sets") && sql.includes("RETURNING id")) {
        return { rows: [{ id: leaseSetId }] };
      }
      return { rows: [] };
    },
    async transaction(operation) { return operation(this); },
  };
  const repository = new PostgresDurableJobRepository({ database });
  const cancelled = await repository.requestCancellation({
    ownerIdentityId,
    jobId,
    responseId: null,
    now: new Date("2026-08-10T00:02:00.000Z"),
    eventId: "66666666-6666-4666-8666-666666666666",
  });

  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.currentAttemptId, null);
  const attempt = queries.find(({ sql }) => sql.includes("UPDATE compute.attempts"));
  assert.ok(attempt);
  assert.deepEqual(attempt.values.slice(0, 2), [attemptId, "cancelled"]);
  const lease = queries.find(({ sql }) => sql.includes("UPDATE compute.lease_sets") && sql.includes("RETURNING id"));
  assert.ok(lease);
  assert.deepEqual(lease.values, [attemptId, new Date("2026-08-10T00:02:00.000Z"), "job_cancelled"]);
  assert.ok(queries.some(({ sql, values }) => sql.includes("UPDATE compute.leases")
    && values[0] === leaseSetId));
  assert.ok(queries.some(({ sql, values }) => sql.includes("UPDATE compute.node_exclusive_intents")
    && values[0] === leaseSetId && values[2] === "job_cancelled"));
  assert.ok(queries.some(({ sql, values }) => sql.includes("SET current_attempt_id=NULL")
    && values[0] === jobId));
});
