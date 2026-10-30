import assert from "node:assert/strict";
import test from "node:test";

import { ExternalAttemptCoordinator, classifyExternalFailure, normalizeExternalReplayContract } from "../src/external-attempt-coordinator.mjs";
import { MemoryExternalAttemptRepository } from "../src/memory-external-attempt-repository.mjs";

const JOB = "00000000-0000-4000-8000-000000000101";
const OWNER = "00000000-0000-4000-8000-000000000201";
const PROVIDER = "00000000-0000-4000-8000-000000000301";
const PROFILE = "00000000-0000-4000-8000-000000000401";
const REQUEST_DIGEST = `sha256:${"a".repeat(64)}`;
const RESULT = { objectId: "00000000-0000-4000-8000-000000000501", objectVersion: 1, sha256: `sha256:${"b".repeat(64)}`, sizeBytes: 128 };
const OUTPUT = { sequence: 1, sha256: `sha256:${"c".repeat(64)}`, sizeBytes: 32 };
let nextId = 600;

function input(replayContract = {}) {
  return { jobId: JOB, ownerIdentityId: OWNER, providerId: PROVIDER, modelProfileId: PROFILE, providerModel: "large-model", requestDigest: REQUEST_DIGEST, request: { model: "large-model", input: "protected-reference-only" }, replayContract };
}
function coordinator(transport, repository = new MemoryExternalAttemptRepository()) {
  return { repository, service: new ExternalAttemptCoordinator({ repository, transport, clock: () => new Date("2026-08-11T08:00:00Z"), idFactory: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}` }) };
}
function providerError(code, facts = {}) { return Object.assign(new Error(code), { code, ...facts }); }

test("failover visits every configured target beyond 64 and obeys an explicit attempt budget", async () => {
  const targets = Array.from({ length: 75 }, (_, index) => ({ providerId: `00000000-0000-4000-8000-${String(2000 + index).padStart(12, "0")}`, providerModel: "test", request: {} }));
  for (const maximumAttempts of [null, 70, 75]) {
    let calls = 0;
    const { service } = coordinator({ async execute() {
      calls++;
      if (calls < 75) throw providerError("provider_connect_failed", { retryable: true });
      return { providerRequestId: "accepted-final-target", output: OUTPUT, result: RESULT };
    } });
    const result = await service.dispatchWithFailover({ jobId: JOB, ownerIdentityId: OWNER, requestDigest: REQUEST_DIGEST, targets, maximumAttempts });
    assert.equal(result.completed, maximumAttempts !== 70);
    assert.equal(calls, maximumAttempts === 70 ? 70 : 75);
    assert.equal(result.attempts.length, calls);
  }
});

test("failover remains finite and rejects invalid attempt budgets before invoking providers", async () => {
  let calls = 0;
  const { service } = coordinator({ async execute({ onAccepted }) {
    calls++; await onAccepted({ providerRequestId: "retry" });
    throw providerError("disconnected", { retryable: true });
  } });
  const plan = { jobId: JOB, ownerIdentityId: OWNER, requestDigest: REQUEST_DIGEST,
    targets: [{ providerId: PROVIDER, providerModel: "test", request: {}, replayContract: { idempotencyMode: "provider_key", replayAfterAcceptance: "same_provider" } }] };
  for (const maximumAttempts of [0, -1, 1.5, Infinity, NaN, "75"]) {
    await assert.rejects(service.dispatchWithFailover({ ...plan, maximumAttempts }), { code: "external_failover_plan_invalid" });
  }
  assert.equal(calls, 0);
  assert.equal((await service.dispatchWithFailover(plan)).exhausted, true);
  assert.equal(calls, 2);
});

test("long provider identifiers round-trip through acceptance, recovery and cancellation", async () => {
  const providerRequestId = `request-${"x".repeat(2048)}`;
  let cancelled = false, reconciled = false;
  const value = coordinator({
    async execute({ onAccepted }) {
      await onAccepted({ providerRequestId });
      throw providerError("stream_lost", { retryable: true });
    },
    async reconcile(request) { assert.equal(request.providerRequestId, providerRequestId); reconciled = true; return { state: "running" }; },
    async cancel(request) { assert.equal(request.providerRequestId, providerRequestId); cancelled = true; return { state: "confirmed" }; },
  });
  const result = await value.service.dispatch(input({ reconcileMode: "status", cancellationMode: "request" }));
  assert.equal(result.attempt.providerRequestId, providerRequestId);
  await value.service.reconcile({ attemptId: result.attempt.attemptId });
  assert.equal((await value.service.cancel({ attemptId: result.attempt.attemptId })).outcome, "cancelled");
  assert.equal(reconciled && cancelled, true);
});

test("long acceptance identifiers are retained when supplied by completion or failure", async () => {
  const providerRequestId = `request-${"y".repeat(2048)}`;
  const completed = coordinator({ async execute() { return { providerRequestId, output: OUTPUT, result: RESULT }; } });
  assert.equal((await completed.service.dispatch(input())).attempt.providerRequestId, providerRequestId);
  const failed = coordinator({ async execute() { throw providerError("stream_lost", { providerRequestId, accepted: true, retryable: true }); } });
  assert.equal((await failed.service.dispatch(input({ reconcileMode: "status" }))).attempt.providerRequestId, providerRequestId);
});

test("failure before provider acceptance permits policy failover with the same durable job", async () => {
  let invocation = 0;
  const value = coordinator({ async execute({ idempotencyKey }) {
    invocation += 1;
    assert.equal(idempotencyKey, null);
    if (invocation === 1) throw providerError("provider_connect_failed", { retryable: true });
    return { providerRequestId: "request-2", output: OUTPUT, result: RESULT };
  } });
  const first = await value.service.dispatch(input());
  assert.deepEqual(first.decision, { action: "failover", retryClassification: "retryable", blindReplayAllowed: true });
  const second = await value.service.dispatch(input());
  assert.equal(second.attempt.lifecycleState, "succeeded");
  const history = await value.service.history({ jobId: JOB });
  assert.deepEqual(history.map((item) => [item.attemptNumber, item.lifecycleState, item.acceptanceState]), [
    [1, "failed", "not_accepted"], [2, "succeeded", "output_observed"],
  ]);
});

test("accepted request without output retries only under an explicit provider-key contract", async () => {
  const keys = [];
  const value = coordinator({ async execute({ idempotencyKey, onAccepted }) {
    assert.match(idempotencyKey, /^taib:/);
    keys.push(idempotencyKey);
    await onAccepted({ providerRequestId: "provider-request-1" });
    if (keys.length === 1) throw providerError("provider_disconnect", { retryable: true });
    return { output: OUTPUT, result: RESULT };
  } });
  const result = await value.service.dispatch(input({ idempotencyMode: "provider_key", replayAfterAcceptance: "same_provider" }));
  assert.deepEqual(result.decision, { action: "retry_same_provider", retryClassification: "retryable", blindReplayAllowed: false });
  assert.equal(result.attempt.acceptanceState, "accepted_no_output");
  const retried = await value.service.dispatchWithFailover({
    jobId: JOB, ownerIdentityId: OWNER, requestDigest: REQUEST_DIGEST,
    targets: [{ providerId: PROVIDER, modelProfileId: PROFILE, providerModel: "large-model", request: {}, replayContract: { idempotencyMode: "provider_key", replayAfterAcceptance: "same_provider" } }],
  });
  assert.equal(retried.completed, true);
  assert.equal(keys[0], keys[1]);
});

test("external failover executes the next eligible provider only after pre-acceptance failure", async () => {
  const secondProvider = "00000000-0000-4000-8000-000000000302";
  const calls = [];
  const value = coordinator({ async execute({ providerId }) {
    calls.push(providerId);
    if (providerId === PROVIDER) throw providerError("provider_connect_failed", { retryable: true });
    return { providerRequestId: "second-provider-request", output: OUTPUT, result: RESULT };
  } });
  const result = await value.service.dispatchWithFailover({
    jobId: JOB, ownerIdentityId: OWNER, requestDigest: REQUEST_DIGEST,
    targets: [
      { providerId: PROVIDER, modelProfileId: PROFILE, providerModel: "model-a", request: {} },
      { providerId: secondProvider, modelProfileId: PROFILE, providerModel: "model-b", request: {} },
    ],
  });
  assert.equal(result.completed, true);
  assert.deepEqual(calls, [PROVIDER, secondProvider]);
  assert.deepEqual(result.attempts.map((attempt) => attempt.attemptNumber), [1, 2]);
});

test("partial streamed output always blocks blind replay and requires provider reconciliation", async () => {
  const value = coordinator({ async execute({ onAccepted, onOutput }) {
    await onAccepted({ providerRequestId: "provider-stream-1" });
    await onOutput(OUTPUT);
    throw providerError("provider_stream_disconnected", { retryable: true });
  } });
  const result = await value.service.dispatch(input({ replayAfterAcceptance: "any_provider", reconcileMode: "status", sideEffectClass: "none" }));
  assert.equal(result.decision.action, "reconcile");
  assert.equal(result.decision.blindReplayAllowed, false);
  assert.equal(result.attempt.lifecycleState, "reconcile_required");
  assert.equal(result.attempt.acceptanceState, "output_observed");
  assert.equal(result.attempt.observedOutputBytes, OUTPUT.sizeBytes);
  assert.equal((await value.service.history({ jobId: JOB }))[0].events.some((event) => event.eventKind === "output_observed" && !("content" in event)), true);
});

test("uncertain non-idempotent side effects become incomplete without automatic replay", async () => {
  const value = coordinator({ async execute() { throw providerError("provider_timeout", { retryable: true, accepted: true, sideEffectUncertain: true, providerRequestId: "request-uncertain" }); } });
  const result = await value.service.dispatch(input({ sideEffectClass: "non_idempotent" }));
  assert.equal(result.decision.action, "manual_reconcile");
  assert.equal(result.attempt.lifecycleState, "incomplete");
  assert.equal(result.attempt.acceptanceState, "side_effect_uncertain");
});

test("provider cancellation maps confirmed and unsupported outcomes without inventing success", async () => {
  const repository = new MemoryExternalAttemptRepository();
  const confirmed = coordinator({
    async execute({ onAccepted }) { await onAccepted({ providerRequestId: "cancel-1" }); throw providerError("provider_waiting", { retryable: true }); },
    async cancel() { return { state: "confirmed" }; },
  }, repository);
  const dispatched = await confirmed.service.dispatch(input({ reconcileMode: "status", cancellationMode: "request" }));
  const cancelled = await confirmed.service.cancel({ attemptId: dispatched.attempt.attemptId });
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(cancelled.attempt.lifecycleState, "cancelled");

  const unsupported = coordinator({ async execute({ onAccepted }) { await onAccepted({ providerRequestId: "cancel-2" }); throw providerError("provider_waiting", { retryable: true }); } });
  const pending = await unsupported.service.dispatch(input({ reconcileMode: "status" }));
  const result = await unsupported.service.cancel({ attemptId: pending.attempt.attemptId });
  assert.equal(result.outcome, "reconcile_required");
  assert.equal(result.attempt.cancellationState, "unsupported");
});

test("reconciliation can adopt one verified protected result but inconclusive status stays fenced", async () => {
  let outcome = { state: "running" };
  const value = coordinator({
    async execute({ onAccepted, onOutput }) { await onAccepted({ providerRequestId: "reconcile-1" }); await onOutput(OUTPUT); throw providerError("stream_lost", { retryable: true }); },
    async reconcile() { return outcome; },
  });
  const dispatched = await value.service.dispatch(input({ reconcileMode: "status" }));
  assert.equal((await value.service.reconcile({ attemptId: dispatched.attempt.attemptId })).outcome, "still_running");
  outcome = { state: "succeeded", result: RESULT };
  const completed = await value.service.reconcile({ attemptId: dispatched.attempt.attemptId });
  assert.equal(completed.outcome, "succeeded");
  assert.equal(completed.attempt.result.objectId, RESULT.objectId);
  assert.equal(completed.attempt.reconciled, true);
});

test("unsafe replay contracts and output-before-acceptance fail closed", async () => {
  assert.throws(() => normalizeExternalReplayContract({ idempotencyMode: "none", replayAfterAcceptance: "same_provider" }), { code: "external_replay_contract_invalid" });
  assert.throws(() => normalizeExternalReplayContract({ replayAfterAcceptance: "any_provider", sideEffectClass: "idempotent" }), { code: "external_replay_contract_invalid" });
  assert.deepEqual(classifyExternalFailure({ acceptanceState: "output_observed", replayContract: {}, retryable: true }), { action: "manual_reconcile", retryClassification: "manual_reconcile", blindReplayAllowed: false });
  const value = coordinator({ async execute({ onOutput }) { await onOutput(OUTPUT); } });
  const result = await value.service.dispatch(input());
  assert.equal(result.attempt.lifecycleState, "failed");
  assert.equal(result.attempt.errorCode, "external_acceptance_missing");
});
