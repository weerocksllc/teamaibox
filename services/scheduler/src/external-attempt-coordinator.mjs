import { createHash, randomUUID } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ERROR_CODE = /^[a-z][a-z0-9_:.-]{1,191}$/;
const ACCEPTANCE = new Set(["not_accepted", "accepted_no_output", "output_observed", "side_effect_uncertain"]);
const TERMINAL = new Set(["succeeded", "failed", "incomplete", "cancelled"]);

function fail(code, message, status = 400, retryable = false) { throw new PlatformError(code, message, { status, retryable }); }
function id(value, label) { if (typeof value !== "string" || !UUID.test(value)) fail("external_attempt_invalid", `${label} is invalid`); return value.toLowerCase(); }
function code(value, fallback = "provider_request_failed") { return typeof value === "string" && ERROR_CODE.test(value) ? value : fallback; }
function text(value, label, maximum = 512) { if (typeof value !== "string" || value.length < 1 || value.length > maximum) fail("external_attempt_invalid", `${label} is invalid`); return value; }

export function normalizeExternalReplayContract(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("external_replay_contract_invalid", "External replay contract is invalid");
  const contract = {
    idempotencyMode: value.idempotencyMode ?? "none",
    replayAfterAcceptance: value.replayAfterAcceptance ?? "prohibited",
    reconcileMode: value.reconcileMode ?? "none",
    cancellationMode: value.cancellationMode ?? "none",
    sideEffectClass: value.sideEffectClass ?? "none",
  };
  if (!new Set(["none", "provider_key"]).has(contract.idempotencyMode)
      || !new Set(["prohibited", "same_provider", "any_provider"]).has(contract.replayAfterAcceptance)
      || !new Set(["none", "status"]).has(contract.reconcileMode)
      || !new Set(["none", "request"]).has(contract.cancellationMode)
      || !new Set(["none", "idempotent", "non_idempotent"]).has(contract.sideEffectClass)
      || (contract.replayAfterAcceptance === "same_provider" && contract.idempotencyMode !== "provider_key")
      || (contract.replayAfterAcceptance === "any_provider" && contract.sideEffectClass !== "none")
      || (contract.sideEffectClass === "non_idempotent" && contract.replayAfterAcceptance !== "prohibited")) {
    fail("external_replay_contract_invalid", "External replay contract contains an unsafe combination");
  }
  return Object.freeze(contract);
}

export function classifyExternalFailure({ acceptanceState, replayContract, retryable = false, definitive = false, providerRequestId = null }) {
  if (!ACCEPTANCE.has(acceptanceState)) throw new TypeError("external acceptance state is invalid");
  const contract = normalizeExternalReplayContract(replayContract);
  if (acceptanceState === "not_accepted") {
    return Object.freeze(retryable
      ? { action: "failover", retryClassification: "retryable", blindReplayAllowed: true }
      : { action: "terminal", retryClassification: "terminal", blindReplayAllowed: false });
  }
  if (acceptanceState === "accepted_no_output" && definitive) {
    return Object.freeze({ action: "terminal", retryClassification: "terminal", blindReplayAllowed: false });
  }
  if (acceptanceState === "accepted_no_output" && retryable) {
    if (contract.replayAfterAcceptance === "any_provider") {
      return Object.freeze({ action: "failover", retryClassification: "retryable", blindReplayAllowed: false });
    }
    if (contract.replayAfterAcceptance === "same_provider") {
      return Object.freeze({ action: "retry_same_provider", retryClassification: "retryable", blindReplayAllowed: false });
    }
  }
  if (contract.reconcileMode === "status" && providerRequestId) {
    return Object.freeze({ action: "reconcile", retryClassification: "manual_reconcile", blindReplayAllowed: false });
  }
  return Object.freeze({ action: "manual_reconcile", retryClassification: "manual_reconcile", blindReplayAllowed: false });
}

function outputFact(value) {
  if (!value || !Number.isSafeInteger(value.sequence) || value.sequence < 1
      || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || !SHA256.test(value.sha256 ?? "")) {
    fail("external_output_fact_invalid", "External output observation is invalid");
  }
  return { sequence: value.sequence, sizeBytes: value.sizeBytes, sha256: value.sha256 };
}

function resultFact(value) {
  if (!value || !UUID.test(value.objectId ?? "") || !Number.isSafeInteger(value.objectVersion)
      || value.objectVersion < 1 || !SHA256.test(value.sha256 ?? "")
      || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1) {
    fail("external_result_invalid", "External result must be a verified protected object version", 409);
  }
  return { objectId: value.objectId.toLowerCase(), objectVersion: value.objectVersion, sha256: value.sha256, sizeBytes: value.sizeBytes };
}

/** Executes one durable external attempt while persisting acceptance before any output is trusted. */
export class ExternalAttemptCoordinator {
  #repository;
  #transport;
  #clock;
  #id;
  #audit;

  constructor({ repository, transport, clock = () => new Date(), idFactory = randomUUID, audit = async () => {} }) {
    const methods = ["begin", "get", "markAccepted", "observeOutput", "markUncertain", "succeed", "fail", "requestCancellation", "setCancellation", "requireReconciliation", "history"];
    if (!repository || methods.some((method) => typeof repository[method] !== "function")
        || typeof transport?.execute !== "function" || typeof clock !== "function"
        || typeof idFactory !== "function" || typeof audit !== "function") {
      throw new TypeError("external attempt coordinator dependencies are incomplete");
    }
    this.#repository = repository; this.#transport = transport; this.#clock = clock; this.#id = idFactory; this.#audit = audit;
  }

  async dispatch({ jobId, ownerIdentityId, providerId, modelProfileId = null, providerModel, requestDigest, request, replayContract }) {
    const contract = normalizeExternalReplayContract(replayContract);
    const attemptId = id(this.#id(), "Attempt");
    const job = id(jobId, "Job"); const owner = id(ownerIdentityId, "Owner"); const provider = id(providerId, "Provider");
    const profile = modelProfileId === null ? null : id(modelProfileId, "Model profile");
    text(providerModel, "Provider model");
    if (!SHA256.test(requestDigest ?? "") || request === undefined) fail("external_attempt_invalid", "External request digest or body is invalid");
    const idempotencyKey = contract.idempotencyMode === "provider_key" ? `taib:${job}:${provider}` : null;
    let attempt = await this.#repository.begin({
      attemptId, jobId: job, ownerIdentityId: owner, providerId: provider, modelProfileId: profile,
      providerModel, requestDigest, idempotencyKey, replayContract: contract, startedAt: this.#clock(),
    });
    const providerFacts = { providerId: provider, model: providerModel };
    try {
      const result = await this.#transport.execute({
        ...providerFacts, request, requestDigest, idempotencyKey,
        onAccepted: async ({ providerRequestId }) => {
          attempt = await this.#repository.markAccepted(attemptId, {
            providerRequestId: text(providerRequestId, "Provider request identifier", Number.MAX_SAFE_INTEGER), acceptedAt: this.#clock(),
          });
        },
        onOutput: async (fact) => {
          if (attempt.acceptanceState === "not_accepted") fail("external_acceptance_missing", "Provider output arrived before durable acceptance", 409);
          attempt = await this.#repository.observeOutput(attemptId, { ...outputFact(fact), observedAt: this.#clock() });
        },
      });
      if (attempt.acceptanceState === "not_accepted") {
        if (!result?.providerRequestId) fail("external_acceptance_missing", "Provider completed without an acceptance identifier", 409);
        attempt = await this.#repository.markAccepted(attemptId, { providerRequestId: text(result.providerRequestId, "Provider request identifier", Number.MAX_SAFE_INTEGER), acceptedAt: this.#clock() });
      }
      if (result?.output && attempt.acceptanceState !== "output_observed") {
        attempt = await this.#repository.observeOutput(attemptId, { ...outputFact(result.output), observedAt: this.#clock() });
      }
      const completed = await this.#repository.succeed(attemptId, { result: resultFact(result?.result), finishedAt: this.#clock() });
      await this.#audit({ action: "compute.external_attempt_succeeded", jobId: job, attemptId, providerId: provider, acceptanceState: completed.acceptanceState });
      return Object.freeze({ attempt: completed, decision: Object.freeze({ action: "complete", retryClassification: "terminal", blindReplayAllowed: false }) });
    } catch (error) {
      attempt = await this.#captureFailureBoundary(attemptId, attempt, error);
      const decision = classifyExternalFailure({
        acceptanceState: attempt.acceptanceState, replayContract: contract,
        retryable: error?.retryable === true, definitive: error?.definitive === true,
        providerRequestId: attempt.providerRequestId,
      });
      const failed = await this.#repository.fail(attemptId, {
        errorCode: code(error?.code), decision, finishedAt: this.#clock(),
      });
      await this.#audit({ action: "compute.external_attempt_failed", jobId: job, attemptId, providerId: provider, acceptanceState: failed.acceptanceState, retryAction: decision.action, errorCode: failed.errorCode });
      return Object.freeze({ attempt: failed, decision });
    }
  }

  async #captureFailureBoundary(attemptId, current, error) {
    if (error?.sideEffectUncertain === true) {
      return this.#repository.markUncertain(attemptId, {
        providerRequestId: typeof error.providerRequestId === "string" ? error.providerRequestId : current.providerRequestId,
        observedAt: this.#clock(), reason: code(error.code, "provider_side_effect_uncertain"),
      });
    }
    if (error?.outputObserved && current.acceptanceState !== "output_observed") {
      const fact = outputFact(error.outputObserved);
      if (current.acceptanceState === "not_accepted") {
        current = await this.#repository.markAccepted(attemptId, {
          providerRequestId: text(error.providerRequestId, "Provider request identifier", Number.MAX_SAFE_INTEGER), acceptedAt: this.#clock(),
        });
      }
      return this.#repository.observeOutput(attemptId, { ...fact, observedAt: this.#clock() });
    }
    if (error?.accepted === true && current.acceptanceState === "not_accepted") {
      return this.#repository.markAccepted(attemptId, {
        providerRequestId: text(error.providerRequestId, "Provider request identifier", Number.MAX_SAFE_INTEGER), acceptedAt: this.#clock(),
      });
    }
    return this.#repository.get(attemptId);
  }

  async cancel({ attemptId }) {
    const selected = id(attemptId, "Attempt");
    let attempt = await this.#repository.requestCancellation(selected, { requestedAt: this.#clock() });
    if (TERMINAL.has(attempt.lifecycleState)) return Object.freeze({ attempt, outcome: "already_terminal" });
    const contract = normalizeExternalReplayContract(attempt.replayContract);
    if (contract.cancellationMode === "none" || typeof this.#transport.cancel !== "function") {
      if (attempt.acceptanceState === "not_accepted") {
        attempt = await this.#repository.setCancellation(selected, { state: "confirmed", outcome: "local_before_acceptance", observedAt: this.#clock() });
        return Object.freeze({ attempt, outcome: "cancelled" });
      }
      attempt = await this.#repository.requireReconciliation(selected, { reason: "provider_cancellation_unsupported", observedAt: this.#clock(), cancellationState: "unsupported" });
      return Object.freeze({ attempt, outcome: "reconcile_required" });
    }
    let outcome;
    try {
      outcome = await this.#transport.cancel({
        providerId: attempt.providerId, providerRequestId: attempt.providerRequestId,
        idempotencyKey: attempt.idempotencyKey,
      });
    } catch (error) {
      outcome = { state: "uncertain", errorCode: code(error?.code, "provider_cancel_failed") };
    }
    if (outcome?.state === "confirmed" || (outcome?.state === "not_found" && attempt.acceptanceState === "not_accepted")) {
      attempt = await this.#repository.setCancellation(selected, { state: "confirmed", outcome: outcome.state, observedAt: this.#clock() });
      return Object.freeze({ attempt, outcome: "cancelled" });
    }
    attempt = await this.#repository.requireReconciliation(selected, {
      reason: outcome?.state === "unsupported" ? "provider_cancellation_unsupported" : "provider_cancellation_uncertain",
      observedAt: this.#clock(), cancellationState: outcome?.state === "unsupported" ? "unsupported" : "uncertain",
    });
    return Object.freeze({ attempt, outcome: "reconcile_required" });
  }

  async dispatchWithFailover({ jobId, ownerIdentityId, targets, requestDigest, maximumAttempts = null }) {
    if (!Array.isArray(targets) || targets.length < 1
        || targets.some((target) => !target || target.request === undefined)) {
      fail("external_failover_plan_invalid", "External failover targets are invalid");
    }
    const limit = maximumAttempts ?? targets.length + 1;
    if (!Number.isSafeInteger(limit) || limit < 1) fail("external_failover_plan_invalid", "External failover attempt limit is invalid");
    const attempts = [];
    let targetIndex = 0;
    while (attempts.length < limit && targetIndex < targets.length) {
      const target = targets[targetIndex];
      const result = await this.dispatch({
        jobId, ownerIdentityId, providerId: target.providerId,
        modelProfileId: target.modelProfileId ?? null, providerModel: target.providerModel,
        requestDigest, request: target.request, replayContract: target.replayContract ?? {},
      });
      attempts.push(result.attempt);
      if (result.decision.action === "complete") return Object.freeze({ completed: true, attempt: result.attempt, attempts: Object.freeze(attempts), exhausted: false });
      if (result.decision.action === "retry_same_provider") continue;
      if (result.decision.action === "failover") { targetIndex += 1; continue; }
      return Object.freeze({ completed: false, attempt: result.attempt, attempts: Object.freeze(attempts), exhausted: false, decision: result.decision });
    }
    return Object.freeze({ completed: false, attempt: attempts.at(-1) ?? null, attempts: Object.freeze(attempts), exhausted: true, decision: attempts.length ? Object.freeze({ action: "exhausted", retryClassification: "terminal", blindReplayAllowed: false }) : null });
  }

  async reconcile({ attemptId }) {
    const selected = id(attemptId, "Attempt");
    let attempt = await this.#repository.get(selected);
    if (!attempt) fail("external_attempt_not_found", "External attempt was not found", 404);
    const contract = normalizeExternalReplayContract(attempt.replayContract);
    if (contract.reconcileMode !== "status" || !attempt.providerRequestId || typeof this.#transport.reconcile !== "function") {
      fail("external_reconciliation_unavailable", "Provider reconciliation is unavailable", 409);
    }
    const result = await this.#transport.reconcile({ providerId: attempt.providerId, providerRequestId: attempt.providerRequestId, idempotencyKey: attempt.idempotencyKey });
    if (result?.state === "running") return Object.freeze({ attempt, outcome: "still_running" });
    if (result?.state === "succeeded") {
      if (result.output && attempt.acceptanceState !== "output_observed") attempt = await this.#repository.observeOutput(selected, { ...outputFact(result.output), observedAt: this.#clock() });
      attempt = await this.#repository.succeed(selected, { result: resultFact(result.result), finishedAt: this.#clock(), reconciled: true });
      return Object.freeze({ attempt, outcome: "succeeded" });
    }
    if (result?.state === "cancelled") {
      attempt = await this.#repository.setCancellation(selected, { state: "confirmed", outcome: "reconciled_cancelled", observedAt: this.#clock() });
      return Object.freeze({ attempt, outcome: "cancelled" });
    }
    if (result?.state === "failed" && result.definitive === true && attempt.acceptanceState === "accepted_no_output") {
      attempt = await this.#repository.fail(selected, { errorCode: code(result.errorCode), decision: { action: "terminal", retryClassification: "terminal", blindReplayAllowed: false }, finishedAt: this.#clock(), reconciled: true });
      return Object.freeze({ attempt, outcome: "failed" });
    }
    attempt = await this.#repository.requireReconciliation(selected, { reason: "provider_reconciliation_inconclusive", observedAt: this.#clock(), cancellationState: attempt.cancellationState });
    return Object.freeze({ attempt, outcome: "reconcile_required" });
  }

  history({ jobId }) { return this.#repository.history(id(jobId, "Job")); }
}
