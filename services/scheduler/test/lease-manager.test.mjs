import assert from "node:assert/strict";
import test from "node:test";

import { LeaseManager } from "../src/lease-manager.mjs";
import { MemoryLeaseRepository } from "../src/memory-lease-repository.mjs";

const BASE_TIME = new Date("2026-08-10T01:00:00.000Z");

function reservation(overrides = {}) {
  return {
    cpuMillis: 2_000,
    unifiedMemoryBytes: 8_000,
    acceleratorUnits: 1,
    codecSessions: 0,
    storageBytes: 1_000,
    networkBitsPerSecond: 100,
    ...overrides,
  };
}

function node(overrides = {}) {
  return {
    nodeId: "node-a",
    lifecycleState: "ready",
    generation: 7,
    capacity: reservation({
      cpuMillis: 10_000,
      unifiedMemoryBytes: 32_000,
      acceleratorUnits: 2,
      codecSessions: 2,
      storageBytes: 100_000,
      networkBitsPerSecond: 10_000,
    }),
    ...structuredClone(overrides),
  };
}

function job(jobId, overrides = {}) {
  return {
    jobId,
    status: "queued",
    currentAttemptId: null,
    waitingReason: "no_eligible_target",
    cancelRequestedAt: null,
    ...structuredClone(overrides),
  };
}

function fixture({ nodes = [node()], jobs = [job("job-a")] } = {}) {
  const repository = new MemoryLeaseRepository({ nodes, jobs });
  return { repository, manager: new LeaseManager({ repository }) };
}

function acquisition(overrides = {}) {
  return {
    acquisitionKey: "acquire-a",
    jobId: "job-a",
    nodeId: "node-a",
    nodeGeneration: 7,
    modelProfileId: "profile-a",
    reservation: reservation(),
    ttlMilliseconds: 30_000,
    now: BASE_TIME,
    attemptId: "attempt-a",
    leaseToken: "lease-token-a",
    ...structuredClone(overrides),
  };
}

test("acquisition atomically creates an attempt, admitted job, and fenced resource set", async () => {
  const { repository, manager } = fixture();
  const lease = await manager.acquire(acquisition());
  const snapshot = await repository.snapshot();

  assert.equal(lease.state, "active");
  assert.equal(lease.fencingToken, 1);
  assert.equal(lease.dispatchState, "pending");
  assert.deepEqual(lease.reservation, reservation());
  assert.deepEqual(snapshot.attempts[0], {
    attemptId: "attempt-a",
    jobId: "job-a",
    attemptNumber: 1,
    nodeId: "node-a",
    modelProfileId: "profile-a",
    dispatchFence: 1,
    status: "pending",
    acceptanceState: "not_accepted",
    retryable: null,
    errorCode: null,
    dispatchedAt: null,
    acceptedAt: null,
    finishedAt: null,
    createdAt: BASE_TIME,
  });
  assert.equal(snapshot.jobs[0].status, "admitted");
  assert.equal(snapshot.jobs[0].currentAttemptId, "attempt-a");
  assert.equal(snapshot.jobs[0].waitingReason, null);
});

test("the acquisition key makes retries idempotent but rejects changed facts", async () => {
  const { manager } = fixture();
  const first = await manager.acquire(acquisition());
  const replay = await manager.acquire(acquisition({ attemptId: "attempt-replay", leaseToken: "token-replay" }));

  assert.equal(replay.attemptId, first.attemptId);
  assert.equal(replay.leaseToken, first.leaseToken);
  assert.equal(replay.fencingToken, first.fencingToken);

  await assert.rejects(
    manager.acquire(acquisition({ reservation: reservation({ cpuMillis: 2_001 }) })),
    { code: "acquisition_key_conflict" },
  );
});

test("independent jobs are not blocked by summed declared resource settings", async () => {
  const smallNode = node({
    capacity: reservation({
      cpuMillis: 3_000,
      unifiedMemoryBytes: 12_000,
      acceleratorUnits: 2,
      storageBytes: 2_000,
      networkBitsPerSecond: 200,
    }),
  });
  const { manager, repository } = fixture({
    nodes: [smallNode],
    jobs: [job("job-a"), job("job-b")],
  });

  const outcomes = await Promise.allSettled([
    manager.acquire(acquisition()),
    manager.acquire(acquisition({
      acquisitionKey: "acquire-b",
      jobId: "job-b",
      attemptId: "attempt-b",
      leaseToken: "lease-token-b",
    })),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 2);
  assert.equal((await repository.snapshot()).leaseSets.length, 2);
});

test("independent jobs share additive capacity when the node envelope permits it", async () => {
  const { manager, repository } = fixture({ jobs: [job("job-a"), job("job-b")] });
  const [first, second] = await Promise.all([
    manager.acquire(acquisition({ reservation: reservation({ acceleratorUnits: 1 }) })),
    manager.acquire(acquisition({
      acquisitionKey: "acquire-b",
      jobId: "job-b",
      attemptId: "attempt-b",
      leaseToken: "lease-token-b",
      reservation: reservation({ acceleratorUnits: 1 }),
    })),
  ]);

  assert.deepEqual([first.fencingToken, second.fencingToken], [1, 2]);
  assert.equal((await repository.snapshot()).leaseSets.length, 2);
});

test("heartbeat extends only a live lease with the exact node fence", async () => {
  const { manager } = fixture();
  const lease = await manager.acquire(acquisition());
  const heartbeatAt = new Date(BASE_TIME.getTime() + 10_000);
  const renewed = await manager.heartbeat({
    leaseToken: lease.leaseToken,
    fencingToken: lease.fencingToken,
    ttlMilliseconds: 60_000,
    now: heartbeatAt,
  });

  assert.equal(renewed.heartbeatAt.toISOString(), heartbeatAt.toISOString());
  assert.equal(renewed.expiresAt.toISOString(), new Date(heartbeatAt.getTime() + 60_000).toISOString());
  await assert.rejects(manager.heartbeat({
    leaseToken: lease.leaseToken,
    fencingToken: lease.fencingToken + 1,
    now: heartbeatAt,
  }), { code: "stale_lease_fence" });
});

test("expired leases cannot heartbeat or dispatch and a retry receives a newer fence", async () => {
  const { manager, repository } = fixture();
  const first = await manager.acquire(acquisition({ ttlMilliseconds: 1_000 }));
  const expiredAt = new Date(BASE_TIME.getTime() + 1_001);

  await assert.rejects(manager.heartbeat({
    leaseToken: first.leaseToken,
    fencingToken: first.fencingToken,
    now: expiredAt,
  }), { code: "lease_expired" });
  await assert.rejects(manager.claimDispatch({
    leaseToken: first.leaseToken,
    fencingToken: first.fencingToken,
    dispatchId: "dispatch-old",
    now: expiredAt,
  }), { code: "lease_expired" });

  const retry = await manager.acquire(acquisition({
    acquisitionKey: "acquire-retry",
    attemptId: "attempt-retry",
    leaseToken: "lease-token-retry",
    now: expiredAt,
  }));
  assert.equal(retry.fencingToken, 2);
  const snapshot = await repository.snapshot();
  assert.equal(snapshot.leaseSets.find((item) => item.attemptId === "attempt-a").state, "expired");
  assert.equal(snapshot.jobs[0].currentAttemptId, "attempt-retry");
});

test("dispatch claim and acknowledgement are exactly-once for one dispatch identity", async () => {
  const { manager, repository } = fixture();
  const lease = await manager.acquire(acquisition());
  const claim = {
    leaseToken: lease.leaseToken,
    fencingToken: lease.fencingToken,
    dispatchId: "dispatch-a",
    now: new Date(BASE_TIME.getTime() + 100),
  };
  const first = await manager.claimDispatch(claim);
  const replay = await manager.claimDispatch(claim);

  assert.equal(first.dispatchState, "claimed");
  assert.equal(replay.dispatchId, "dispatch-a");
  await assert.rejects(manager.claimDispatch({ ...claim, dispatchId: "dispatch-b" }), {
    code: "duplicate_dispatch",
  });

  const accepted = await manager.acknowledgeDispatch({ ...claim, now: new Date(BASE_TIME.getTime() + 200) });
  const acceptedReplay = await manager.acknowledgeDispatch({ ...claim, now: new Date(BASE_TIME.getTime() + 201) });
  assert.equal(accepted.dispatchState, "accepted");
  assert.equal(acceptedReplay.acceptedAt.toISOString(), accepted.acceptedAt.toISOString());

  const snapshot = await repository.snapshot();
  assert.equal(snapshot.attempts[0].status, "accepted");
  assert.equal(snapshot.attempts[0].acceptanceState, "accepted_no_output");
  assert.equal(snapshot.jobs[0].status, "preparing");
});

test("node generation change fences old dispatch and reconciliation distinguishes acceptance", async () => {
  const { manager, repository } = fixture({ jobs: [job("job-a"), job("job-b")] });
  const accepted = await manager.acquire(acquisition());
  await manager.claimDispatch({
    leaseToken: accepted.leaseToken,
    fencingToken: accepted.fencingToken,
    dispatchId: "dispatch-a",
    now: new Date(BASE_TIME.getTime() + 100),
  });
  await manager.acknowledgeDispatch({
    leaseToken: accepted.leaseToken,
    fencingToken: accepted.fencingToken,
    dispatchId: "dispatch-a",
    now: new Date(BASE_TIME.getTime() + 200),
  });
  const pending = await manager.acquire(acquisition({
    acquisitionKey: "acquire-b",
    jobId: "job-b",
    attemptId: "attempt-b",
    leaseToken: "lease-token-b",
  }));
  assert.equal(pending.state, "active");

  await repository.updateNode("node-a", { generation: 8 });
  const outcomes = await manager.reconcile({ now: new Date(BASE_TIME.getTime() + 300) });
  assert.equal(outcomes.length, 2);

  const snapshot = await repository.snapshot();
  const acceptedJob = snapshot.jobs.find((item) => item.jobId === "job-a");
  const pendingJob = snapshot.jobs.find((item) => item.jobId === "job-b");
  assert.equal(acceptedJob.status, "incomplete");
  assert.equal(acceptedJob.retryClassification, "manual_reconcile");
  assert.equal(pendingJob.status, "queued");
  assert.equal(pendingJob.waitingReason, "node_fence_changed");
  assert.ok(snapshot.leaseSets.every((item) => item.state === "revoked"));
});

test("release is fenced, idempotent, and makes capacity reusable with a larger token", async () => {
  const { manager } = fixture();
  const first = await manager.acquire(acquisition());
  const released = await manager.release({
    leaseToken: first.leaseToken,
    fencingToken: first.fencingToken,
    reason: "scheduler_release",
    now: new Date(BASE_TIME.getTime() + 500),
  });
  const replay = await manager.release({
    leaseToken: first.leaseToken,
    fencingToken: first.fencingToken,
    reason: "scheduler_release",
    now: new Date(BASE_TIME.getTime() + 600),
  });
  assert.equal(released.state, "released");
  assert.equal(replay.releasedAt.toISOString(), released.releasedAt.toISOString());

  const next = await manager.acquire(acquisition({
    acquisitionKey: "acquire-next",
    attemptId: "attempt-next",
    leaseToken: "lease-token-next",
    now: new Date(BASE_TIME.getTime() + 700),
  }));
  assert.equal(next.fencingToken, 2);
});

test("invalid reservations and unsafe TTL values fail before repository mutation", async () => {
  const { manager, repository } = fixture();
  await assert.rejects(manager.acquire(acquisition({
    reservation: { ...reservation(), unifiedMemoryBytes: -1 },
  })), /reservation\.unifiedMemoryBytes/);
  await assert.rejects(manager.acquire(acquisition({
    reservation: { ...reservation(), codecSessions: 0.5 },
  })), /reservation\.codecSessions/);
  await assert.rejects(manager.acquire(acquisition({
    reservation: reservation({
      cpuMillis: 0,
      unifiedMemoryBytes: 0,
      acceleratorUnits: 0,
      codecSessions: 0,
      storageBytes: 0,
      networkBitsPerSecond: 0,
    }),
  })), /at least one resource/);
  await assert.rejects(manager.acquire(acquisition({ ttlMilliseconds: 999 })), /ttlMilliseconds/);
  assert.equal((await repository.snapshot()).leaseSets.length, 0);
});

test("exclusive intent blocks new admissions, waits for drain, and owns the whole node", async () => {
  const { manager, repository } = fixture({ jobs: [job("job-a"), job("job-b"), job("job-c")] });
  const shared = await manager.acquire(acquisition());
  const intent = await manager.beginExclusiveIntent({
    intentId: "intent-b", jobId: "job-b", nodeId: "node-a",
    ttlMilliseconds: 60_000, now: BASE_TIME,
  });
  assert.equal(intent.state, "pending");

  await assert.rejects(manager.acquire(acquisition({
    acquisitionKey: "acquire-c", jobId: "job-c", attemptId: "attempt-c",
    leaseToken: "lease-token-c",
  })), { code: "node_exclusive_pending" });
  await assert.rejects(manager.acquire(acquisition({
    acquisitionKey: "acquire-b", jobId: "job-b", attemptId: "attempt-b",
    leaseToken: "lease-token-b", nodeExclusive: true,
  })), { code: "exclusive_conflicting_leases" });

  await manager.release({
    leaseToken: shared.leaseToken, fencingToken: shared.fencingToken,
    reason: "exclusive_drain", now: new Date(BASE_TIME.getTime() + 100),
  });
  const exclusive = await manager.acquire(acquisition({
    acquisitionKey: "acquire-b", jobId: "job-b", attemptId: "attempt-b",
    leaseToken: "lease-token-b", nodeExclusive: true,
    now: new Date(BASE_TIME.getTime() + 200),
  }));
  assert.equal(exclusive.nodeExclusive, true);

  await assert.rejects(manager.acquire(acquisition({
    acquisitionKey: "acquire-c-2", jobId: "job-c", attemptId: "attempt-c-2",
    leaseToken: "lease-token-c-2", now: new Date(BASE_TIME.getTime() + 300),
  })), { code: "node_exclusive_pending" });
  await manager.release({
    leaseToken: exclusive.leaseToken, fencingToken: exclusive.fencingToken,
    reason: "exclusive_complete", now: new Date(BASE_TIME.getTime() + 400),
  });
  const normal = await manager.acquire(acquisition({
    acquisitionKey: "acquire-c-3", jobId: "job-c", attemptId: "attempt-c-3",
    leaseToken: "lease-token-c-3", now: new Date(BASE_TIME.getTime() + 500),
  }));
  assert.equal(normal.nodeExclusive, false);
  assert.equal((await repository.snapshot()).exclusiveIntents[0].state, "completed");
});

test("pending exclusive intent is idempotent and can be cancelled before lease acquisition", async () => {
  const { manager, repository } = fixture();
  const input = {
    intentId: "intent-a", jobId: "job-a", nodeId: "node-a",
    ttlMilliseconds: 60_000, now: BASE_TIME,
  };
  const first = await manager.beginExclusiveIntent(input);
  const replay = await manager.beginExclusiveIntent(input);
  assert.equal(replay.intentId, first.intentId);
  const cancelled = await manager.cancelExclusiveIntent({
    intentId: first.intentId, jobId: "job-a", reason: "operator_cancelled",
    now: new Date(BASE_TIME.getTime() + 100),
  });
  assert.equal(cancelled.state, "cancelled");
  assert.equal((await repository.snapshot()).exclusiveIntents[0].finishReason, "operator_cancelled");
});

test("memory pressure is observed without advance capacity rejection", async () => {
  const repository = new MemoryLeaseRepository({ nodes: [node()], jobs: [job("job-a")] });
  const calls = [];
  const manager = new LeaseManager({
    repository,
    memoryGuard: {
      evaluate(snapshot) {
        calls.push(structuredClone(snapshot));
        return {severity:'critical'};
      },
    },
    memorySnapshotProvider: {
      async snapshot({ nodeId }) {
        return { nodeId, workload: { coldLoad: true } };
      },
    },
  });
  await manager.acquire(acquisition());
  assert.equal(calls[0].workload.class, "batch");
  assert.equal(calls[0].workload.requestedBytes, reservation().unifiedMemoryBytes);
  assert.equal((await repository.snapshot()).leaseSets.length, 1);
});
