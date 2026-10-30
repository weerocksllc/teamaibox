import assert from "node:assert/strict";
import test from "node:test";

import { QueueAdministrationHttpApi } from "../src/queues/queue-administration-http-api.mjs";
import { QueueAdministrationService } from "../src/queues/queue-administration-service.mjs";

const OWNER = "018f0000-0000-7000-8000-000000000001";
const MEMBER = "018f0000-0000-7000-8000-000000000002";
const JOB = "018f0000-0000-7000-8000-000000000010";
const NOW = new Date("2026-08-21T06:00:00Z");

test("administrators can set capacities above former hardcoded ceilings", async () => {
  const value = fixture(), context = {identityId:OWNER,permissions:["queue:manage"]};
  const input = {minimumPriority:0,maximumPriority:100,maxQueuedPerOwner:5000,
    maxActivePerOwner:2000,maxQueuedPerCapability:40000,maxDailySubmissionsPerOwner:2_000_000,
    maxRequestBytes:5*1024**3,maxDeadlineSeconds:86400};
  const updated = await value.service.updatePolicy({context,expectedRevision:1,input});
  for (const [key,item] of Object.entries(input)) assert.equal(updated[key],item);
  await assert.rejects(value.service.updatePolicy({context,expectedRevision:2,input:{...input,maxRequestBytes:Number.MAX_SAFE_INTEGER+1}}), {code:"queue_policy_invalid"});
  await assert.rejects(value.service.updatePolicy({context,expectedRevision:2,input:{...input,maxActivePerOwner:0}}), {code:"queue_policy_invalid"});
});

function policy(overrides = {}) {
  return {
    policyKey: "default", minimumPriority: 0, maximumPriority: 100,
    maxQueuedPerOwner: 64, maxActivePerOwner: 4, maxQueuedPerCapability: 256,
    maxDailySubmissionsPerOwner: 1000, maxRequestBytes: 1_048_576, maxDeadlineMs: 604_800_000,
    revision: 1, updatedBy: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function fixture() {
  let current = policy();
  const audits = [], cancellations = [];
  const repository = {
    async getPolicy() { return current; },
    async submissionPolicy() { return current; },
    async updatePolicy({ expectedRevision, declaration, actorIdentityId, updatedAt }) {
      if (expectedRevision !== current.revision) return null;
      current = policy({ ...declaration, revision: current.revision + 1, updatedBy: actorIdentityId, updatedAt: updatedAt.toISOString() });
      return current;
    },
    async snapshot() {
      return {
        statusCounts: [{ status: "queued", count: 1 }, { status: "succeeded", count: 2 }],
        waitingReasons: [{ reasonCode: "capacity_busy", count: 1 }],
        priorityBands: [{ band: "normal", count: 1 }],
        infrastructure: { activeLeases: 1, realtimeReservations: 2, exclusiveIntents: 1, oldestQueuedAt: NOW.toISOString() },
        jobs: [{ jobId: JOB, status: "queued", canCancel: true }],
        realtimeReservations: [{ reservationId: "018f0000-0000-7000-8000-000000000020" }],
        exclusiveIntents: [{ intentId: "018f0000-0000-7000-8000-000000000030" }],
      };
    },
    async findJob(jobId) { return jobId === JOB ? { jobId, ownerIdentityId: MEMBER, status: "queued", cancellationRequested: false } : null; },
  };
  const jobRepository = {
    async requestCancellation(value) {
      cancellations.push(value);
      return { status: "cancelled", cancelRequestedAt: NOW, terminalAt: NOW, updatedAt: NOW };
    },
  };
  const service = new QueueAdministrationService({ repository, jobRepository, audit: async (event) => audits.push(event), clock: () => NOW });
  return { service, audits, cancellations, get current() { return current; } };
}

test("queue overview returns real aggregate, reservation, and redacted job facts to viewers", async () => {
  const value = fixture();
  const result = await value.service.overview({ context: { identityId: OWNER, permissions: ["queue:view"] }, limit: 100 });
  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.summary, { totalJobs: 3, activeJobs: 1, activeLeases: 1, realtimeReservations: 2, exclusiveIntents: 1, oldestQueuedAt: NOW.toISOString() });
  assert.equal(result.jobs[0].jobId, JOB);
  assert.equal(result.realtimeReservations.length, 1);
  assert.equal(result.exclusiveIntents.length, 1);
  await assert.rejects(value.service.overview({ context: { identityId: MEMBER, permissions: [] } }), (error) => error.code === "queue_permission_required" && error.status === 403);
});

test("queue policy update is revisioned, bounded, auditable, and exposed through the HTTP adapter", async () => {
  const value = fixture();
  const api = new QueueAdministrationHttpApi({ service: value.service });
  const updated = await api.handle({ method: "PUT", pathname: "/api/v1/admin/queues/policy",
    context: { identityId: OWNER, permissions: ["queue:manage"] }, body: { expectedRevision: 1, policy: {
      minimumPriority: 10, maximumPriority: 90, maxQueuedPerOwner: 32, maxActivePerOwner: 3,
      maxQueuedPerCapability: 128, maxDailySubmissionsPerOwner: 500, maxRequestBytes: 2_097_152,
      maxDeadlineSeconds: 86_400,
    } } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.revision, 2);
  assert.equal(updated.body.maxDeadlineSeconds, 86_400);
  assert.equal(value.audits[0].action, "queue.policy_updated");
  await assert.rejects(value.service.updatePolicy({ context: { identityId: OWNER, permissions: ["queue:manage"] }, expectedRevision: 1, input: {
    minimumPriority: 10, maximumPriority: 90, maxQueuedPerOwner: 32, maxActivePerOwner: 3,
    maxQueuedPerCapability: 128, maxDailySubmissionsPerOwner: 500, maxRequestBytes: 2_097_152,
    maxDeadlineSeconds: 86_400,
  } }), (error) => error.code === "queue_policy_revision_conflict" && error.status === 409);
});

test("administrator cancellation requires the exact job phrase and preserves job ownership boundaries", async () => {
  const value = fixture();
  await assert.rejects(value.service.cancelJob({ context: { identityId: OWNER, permissions: ["queue:manage"] }, jobId: JOB, confirmation: "CANCEL" }),
    (error) => error.code === "queue_job_confirmation_required" && error.status === 409);
  const result = await value.service.cancelJob({ context: { identityId: OWNER, permissions: ["queue:manage"] }, jobId: JOB, confirmation: `CANCEL ${JOB}` });
  assert.deepEqual(result, { jobId: JOB, status: "cancelled", cancellationRequested: true, terminalAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
  assert.equal(value.cancellations[0].ownerIdentityId, MEMBER);
  assert.equal(value.audits[0].actorIdentityId, OWNER);
  assert.equal(value.audits[0].jobOwnerIdentityId, MEMBER);
});

test("queue HTTP adapter matches only the bounded administration surface", () => {
  const api = new QueueAdministrationHttpApi({ service: fixture().service });
  assert.equal(api.matches("GET", "/api/v1/admin/queues"), true);
  assert.equal(api.matches("PUT", "/api/v1/admin/queues/policy"), true);
  assert.equal(api.matches("POST", `/api/v1/admin/jobs/${JOB}/cancel`), true);
  assert.equal(api.matches("DELETE", "/api/v1/admin/queues"), false);
});
