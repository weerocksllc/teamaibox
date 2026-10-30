import { createHash, randomUUID } from "node:crypto";
import { posix as path } from "node:path";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UPSTREAM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const KEY = /^[a-z][a-z0-9_.-]{1,127}$/;

function requireUuid(value, code = "agent_operation_identity_invalid") {
  if (typeof value !== "string" || !UUID.test(value)) throw new PlatformError(code, "Agent operation identity is invalid", { status: 400 });
  return value;
}

function publicOperation(value) {
  return Object.freeze({
    id: value.id,
    ownerIdentityId: value.ownerIdentityId,
    bindingId: value.bindingId,
    promptId: value.promptId,
    upstreamRequestId: value.upstreamRequestId,
    action: Object.freeze({
      kind: value.actionKind,
      tool: value.tool,
      summary: value.actionScope.summary,
      scope: Object.freeze(structuredClone(value.actionScope.scope)),
      digest: value.actionDigest,
    }),
    sideEffectClass: value.sideEffectClass,
    policy: Object.freeze({ id: value.policyId, revision: value.policyRevision, disposition: value.policyDisposition }),
    status: value.lifecycleState,
    upstreamReplyState: value.upstreamReplyState,
    executionBoundary: value.executionBoundary,
    reconciliationOutcome: value.reconciliationOutcome,
    reconciliationReasonCode: value.reconciliationReasonCode,
    revision: value.revision,
    createdAt: value.createdAt.toISOString(),
    expiresAt: value.expiresAt.toISOString(),
    decidedAt: value.decidedAt?.toISOString() ?? null,
    updatedAt: value.updatedAt.toISOString(),
  });
}

function authenticatedDecision(value, ownerIdentityId, now) {
  if (!value || value.actorIdentityId !== ownerIdentityId || typeof value.authenticationEventId !== "string" || !UUID.test(value.authenticationEventId)
    || typeof value.proofDigest !== "string" || !SHA256.test(value.proofDigest)
    || !(value.authenticatedAt instanceof Date) || value.authenticatedAt > new Date(now.getTime() + 30_000)
    || value.authenticatedAt < new Date(now.getTime() - 10 * 60_000) || value.assurance !== "local-session") {
    throw new PlatformError("agent_operation_authentication_invalid", "Agent operation decision authentication is invalid", { status: 401 });
  }
  return value;
}

function safeSession(value, expected) {
  const directory = typeof value?.directory === "string" ? value.directory : "";
  if (!value || value.ownerIdentityId !== expected.ownerIdentityId || value.bindingId !== expected.bindingId
    || (expected.promptId && value.promptId !== expected.promptId)
    || !directory.startsWith("/workspace/") || directory.includes("\0") || /[\r\n]/.test(directory)
    || path.normalize(directory) !== directory || directory.split("/").includes("..")
    || typeof value.sessionId !== "string" || !UPSTREAM_ID.test(value.sessionId)) {
    throw new PlatformError("agent_operation_session_invalid", "Agent operation session mapping is invalid", { status: 502 });
  }
  return value;
}

function resultDigest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex")}`;
}

export class AgentOperationConfirmationService {
  #repository;
  #policy;
  #sessions;
  #adapter;
  #authenticator;
  #clock;
  #audit;

  constructor({ repository, policy, sessions, adapter, decisionAuthenticator, clock = () => new Date(), audit = async () => {} }) {
    const methods = ["insertOperation", "findOwnedOperation", "findOperation", "updateOperation", "claimExpired", "markBindingUncertain"];
    if (!repository || methods.some((method) => typeof repository[method] !== "function") || !policy?.evaluate
      || !sessions?.resolveOwned || !sessions?.resolveBinding || !adapter?.replyToolConfirmation || !adapter?.interrupt
      || !decisionAuthenticator?.verify || typeof clock !== "function" || typeof audit !== "function") {
      throw new TypeError("Agent operation confirmation dependencies are incomplete");
    }
    this.#repository = repository;
    this.#policy = policy;
    this.#sessions = sessions;
    this.#adapter = adapter;
    this.#authenticator = decisionAuthenticator;
    this.#clock = clock;
    this.#audit = audit;
  }

  async propose({ ownerIdentityId, bindingId, promptId, upstreamRequestId, action }) {
    requireUuid(ownerIdentityId);
    requireUuid(bindingId);
    requireUuid(promptId);
    if (typeof upstreamRequestId !== "string" || !UPSTREAM_ID.test(upstreamRequestId)) {
      throw new PlatformError("agent_operation_upstream_invalid", "OpenCode confirmation identity is invalid", { status: 400 });
    }
    const session = safeSession(await this.#sessions.resolveOwned({ ownerIdentityId, bindingId, promptId }), { ownerIdentityId, bindingId, promptId });
    const now = this.#clock();
    const evaluated = this.#policy.evaluate(action, now);
    const value = {
      id: randomUUID(), ownerIdentityId, bindingId, promptId, upstreamRequestId,
      actionKind: evaluated.action.kind, tool: evaluated.action.tool,
      titleKey: `agent.operation.${evaluated.action.kind}`,
      actionScope: { summary: evaluated.action.summary, scope: structuredClone(evaluated.action.scope) },
      actionDigest: evaluated.action.digest, sideEffectClass: evaluated.sideEffectClass,
      policyId: evaluated.policyId, policyRevision: evaluated.policyRevision,
      policyDisposition: evaluated.disposition, status: "pending", lifecycleState: "pending",
      upstreamReplyState: "none", executionBoundary: "none", decisionKind: null,
      decisionActorIdentityId: null, authenticationEventId: null, authenticationProofDigest: null,
      authenticatedAt: null, reconciliationOutcome: null, reconciliationReasonCode: null,
      resultDigest: null, revision: 1, createdAt: now, expiresAt: evaluated.expiresAt,
      decidedAt: null, updatedAt: now,
    };
    const inserted = await this.#repository.insertOperation(value);
    if (!inserted) throw new PlatformError("agent_operation_session_invalid", "Agent operation session mapping is invalid", { status: 409 });
    if (!inserted.inserted && inserted.operation.actionDigest !== value.actionDigest) {
      throw new PlatformError("agent_operation_upstream_conflict", "OpenCode reused a confirmation identity with different action scope", { status: 409 });
    }
    if (!inserted.inserted) return publicOperation(inserted.operation);
    await this.#audit({
      action: "agent.operation_proposed", ownerIdentityId, bindingId, promptId,
      operationId: value.id, actionKind: value.actionKind, tool: value.tool,
      actionDigest: value.actionDigest, disposition: value.policyDisposition,
      policyId: value.policyId, policyRevision: value.policyRevision, occurredAt: now.toISOString(),
    });
    if (value.policyDisposition === "confirm") return publicOperation(value);
    const decisionKind = value.policyDisposition === "allow" ? "policy_allow" : "policy_deny";
    return this.#dispatch(value, session, value.policyDisposition === "allow", {
      decisionKind, actorIdentityId: ownerIdentityId, authentication: null,
    });
  }

  async get(ownerIdentityId, operationId) {
    requireUuid(ownerIdentityId);
    requireUuid(operationId);
    const value = await this.#repository.findOwnedOperation(operationId, ownerIdentityId);
    if (!value) throw new PlatformError("agent_operation_not_found", "Agent operation confirmation does not exist", { status: 404 });
    return publicOperation(value);
  }

  async decide(ownerIdentityId, operationId, { decision, assertion }) {
    requireUuid(ownerIdentityId);
    requireUuid(operationId);
    if (!new Set(["approve", "deny"]).has(decision)) throw new PlatformError("agent_operation_decision_invalid", "Agent operation decision is invalid", { status: 400 });
    let value = await this.#repository.findOwnedOperation(operationId, ownerIdentityId);
    if (!value) throw new PlatformError("agent_operation_not_found", "Agent operation confirmation does not exist", { status: 404 });
    if (value.policyDisposition !== "confirm" || value.lifecycleState !== "pending") {
      throw new PlatformError("agent_operation_state_conflict", "Agent operation can no longer be decided", { status: 409 });
    }
    const now = this.#clock();
    if (value.expiresAt <= now) {
      value = await this.#expire(value, now);
      throw new PlatformError("agent_operation_expired", "Agent operation confirmation expired", { status: 409 });
    }
    const authentication = authenticatedDecision(await this.#authenticator.verify({ ownerIdentityId, assertion, actionDigest: value.actionDigest }), ownerIdentityId, now);
    const session = safeSession(await this.#sessions.resolveOwned({ ownerIdentityId, bindingId: value.bindingId, promptId: value.promptId }), {
      ownerIdentityId, bindingId: value.bindingId, promptId: value.promptId,
    });
    return this.#dispatch(value, session, decision === "approve", {
      decisionKind: decision, actorIdentityId: ownerIdentityId, authentication,
    });
  }

  async expirePending({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new PlatformError("agent_operation_expiry_limit_invalid", "Agent expiry sweep limit is invalid", { status: 400 });
    const values = await this.#repository.claimExpired({ now: this.#clock(), limit });
    const results = [];
    for (const value of values) {
      const session = safeSession(await this.#sessions.resolveOwned({ ownerIdentityId: value.ownerIdentityId, bindingId: value.bindingId, promptId: value.promptId }), value);
      results.push(await this.#rejectTerminal(value, session, "expired"));
    }
    return Object.freeze(results);
  }

  async interrupt(ownerIdentityId, operationId, { assertion }) {
    requireUuid(ownerIdentityId);
    requireUuid(operationId);
    const value = await this.#repository.findOwnedOperation(operationId, ownerIdentityId);
    if (!value) throw new PlatformError("agent_operation_not_found", "Agent operation confirmation does not exist", { status: 404 });
    const now = this.#clock();
    const authentication = authenticatedDecision(await this.#authenticator.verify({ ownerIdentityId, assertion, actionDigest: value.actionDigest }), ownerIdentityId, now);
    if (!new Set(["pending", "dispatching", "approved", "executing"]).has(value.lifecycleState)) {
      throw new PlatformError("agent_operation_state_conflict", "Agent operation can no longer be interrupted", { status: 409 });
    }
    const uncertain = new Set(["dispatching", "approved", "executing"]).has(value.lifecycleState)
      && new Set(["approve", "policy_allow"]).has(value.decisionKind);
    const changed = await this.#change(value, {
      status: uncertain ? "approved" : "cancelled",
      lifecycleState: uncertain ? "reconcile_required" : "interrupted",
      decisionKind: value.decisionKind ?? "interrupt",
      decisionActorIdentityId: value.decisionActorIdentityId ?? ownerIdentityId,
      authenticationEventId: value.authenticationEventId ?? authentication.authenticationEventId,
      authenticationProofDigest: value.authenticationProofDigest ?? authentication.proofDigest,
      authenticatedAt: value.authenticatedAt ?? authentication.authenticatedAt,
      decidedAt: value.decidedAt ?? now,
      executionBoundary: uncertain && value.executionBoundary === "none" ? "unknown" : value.executionBoundary,
      reconciliationReasonCode: uncertain ? "user_interrupt_after_approval" : null,
    }, now);
    const session = safeSession(await this.#sessions.resolveOwned({ ownerIdentityId, bindingId: value.bindingId, promptId: value.promptId }), value);
    if (!uncertain) {
      try { await this.#adapter.replyToolConfirmation({ directory: session.directory, requestId: value.upstreamRequestId, reply: "reject", message: "Interrupted by user" }); } catch { /* interrupt remains fail closed */ }
    }
    try { await this.#adapter.interrupt({ directory: session.directory, sessionId: session.sessionId }); } catch { /* durable state is authoritative */ }
    await this.#audit({ action: "agent.operation_interrupted", ownerIdentityId, operationId, uncertain, actionDigest: value.actionDigest, occurredAt: now.toISOString() });
    return publicOperation(changed);
  }

  async markExecutionStarted(operationId) {
    requireUuid(operationId);
    const value = await this.#repository.findOperation(operationId);
    if (!value) throw new PlatformError("agent_operation_not_found", "Agent operation confirmation does not exist", { status: 404 });
    if (value.lifecycleState !== "approved") throw new PlatformError("agent_operation_state_conflict", "Agent operation execution cannot start", { status: 409 });
    return publicOperation(await this.#change(value, { lifecycleState: "executing", executionBoundary: "accepted" }, this.#clock()));
  }

  async markExecutionFinished(operationId, { outcome, result = null }) {
    requireUuid(operationId);
    if (!new Set(["executed", "failed_before_side_effect", "failed_after_side_effect"]).has(outcome)) {
      throw new PlatformError("agent_operation_outcome_invalid", "Agent operation outcome is invalid", { status: 400 });
    }
    const value = await this.#repository.findOperation(operationId);
    if (!value) throw new PlatformError("agent_operation_not_found", "Agent operation confirmation does not exist", { status: 404 });
    if (!new Set(["approved", "executing"]).has(value.lifecycleState)) throw new PlatformError("agent_operation_state_conflict", "Agent operation execution cannot finish", { status: 409 });
    const change = outcome === "executed"
      ? { lifecycleState: "executed", executionBoundary: "accepted", resultDigest: resultDigest(result) }
      : outcome === "failed_before_side_effect"
        ? { lifecycleState: "failed", executionBoundary: "none", resultDigest: resultDigest(result) }
        : { lifecycleState: "reconcile_required", executionBoundary: "accepted", reconciliationReasonCode: "failure_after_side_effect", resultDigest: resultDigest(result) };
    return publicOperation(await this.#change(value, change, this.#clock()));
  }

  async markBindingCrashed(bindingId, reasonCode = "sandbox_crash") {
    requireUuid(bindingId);
    if (typeof reasonCode !== "string" || !KEY.test(reasonCode)) throw new PlatformError("agent_operation_reconciliation_invalid", "Agent operation reconciliation reason is invalid", { status: 400 });
    const now = this.#clock();
    const values = await this.#repository.markBindingUncertain({ bindingId, reasonCode, now });
    const resolved = await this.#sessions.resolveBinding(bindingId);
    const session = safeSession(resolved, { bindingId, ownerIdentityId: values[0]?.ownerIdentityId ?? resolved?.ownerIdentityId });
    try { await this.#adapter.interrupt({ directory: session.directory, sessionId: session.sessionId }); } catch { /* crash already requires reconciliation */ }
    await this.#audit({ action: "agent.operation_reconciliation_required", bindingId, operationIds: values.map((value) => value.id), reasonCode, occurredAt: now.toISOString() });
    return Object.freeze(values.map(publicOperation));
  }

  async reconcile(ownerIdentityId, operationId, { outcome, reasonCode, assertion }) {
    requireUuid(ownerIdentityId);
    requireUuid(operationId);
    if (!new Set(["executed", "not_executed", "abandoned"]).has(outcome) || typeof reasonCode !== "string" || !KEY.test(reasonCode)) {
      throw new PlatformError("agent_operation_reconciliation_invalid", "Agent operation reconciliation is invalid", { status: 400 });
    }
    const value = await this.#repository.findOwnedOperation(operationId, ownerIdentityId);
    if (!value) throw new PlatformError("agent_operation_not_found", "Agent operation confirmation does not exist", { status: 404 });
    if (value.lifecycleState !== "reconcile_required") throw new PlatformError("agent_operation_state_conflict", "Agent operation does not require reconciliation", { status: 409 });
    const now = this.#clock();
    const authentication = authenticatedDecision(await this.#authenticator.verify({ ownerIdentityId, assertion, actionDigest: value.actionDigest }), ownerIdentityId, now);
    const changed = await this.#change(value, {
      lifecycleState: "reconciled", reconciliationOutcome: outcome,
      reconciliationReasonCode: reasonCode,
    }, now);
    await this.#audit({ action: "agent.operation_reconciled", ownerIdentityId, operationId, outcome, reasonCode, actionDigest: value.actionDigest, authenticationEventId: authentication.authenticationEventId, occurredAt: now.toISOString() });
    return publicOperation(changed);
  }

  async #dispatch(value, session, approved, decision) {
    const now = this.#clock();
    const dispatching = await this.#change(value, {
      status: approved ? "approved" : "denied",
      lifecycleState: "dispatching", upstreamReplyState: "dispatching",
      executionBoundary: approved ? "unknown" : "none",
      decisionKind: decision.decisionKind,
      decisionActorIdentityId: decision.actorIdentityId,
      authenticationEventId: decision.authentication?.authenticationEventId ?? null,
      authenticationProofDigest: decision.authentication?.proofDigest ?? null,
      authenticatedAt: decision.authentication?.authenticatedAt ?? null,
      decidedAt: now,
    }, now);
    try {
      const accepted = await this.#adapter.replyToolConfirmation({
        directory: session.directory,
        requestId: value.upstreamRequestId,
        reply: approved ? "once" : "reject",
        message: approved ? "Approved for this exact action only" : "Denied by Team AI Box policy or user",
      });
      if (accepted !== true) throw new Error("upstream_reply_not_accepted");
      const changed = await this.#change(dispatching, {
        lifecycleState: approved ? "approved" : "denied",
        upstreamReplyState: "accepted",
      }, this.#clock());
      await this.#audit({
        action: approved ? "agent.operation_approved" : "agent.operation_denied",
        ownerIdentityId: value.ownerIdentityId, operationId: value.id,
        actionDigest: value.actionDigest, decisionKind: decision.decisionKind,
        authenticationEventId: decision.authentication?.authenticationEventId ?? null,
        occurredAt: this.#clock().toISOString(),
      });
      return publicOperation(changed);
    } catch {
      const latest = await this.#repository.findOperation(value.id);
      if (latest && latest.revision !== dispatching.revision
        && new Set(["reconcile_required", "interrupted", "timed_out", "reconciled"]).has(latest.lifecycleState)) {
        return publicOperation(latest);
      }
      const changed = await this.#change(dispatching, {
        lifecycleState: approved ? "reconcile_required" : "interrupted",
        upstreamReplyState: "unknown",
        executionBoundary: approved ? "unknown" : "none",
        reconciliationReasonCode: approved ? "confirmation_reply_outcome_unknown" : null,
      }, this.#clock());
      try { await this.#adapter.interrupt({ directory: session.directory, sessionId: session.sessionId }); } catch { /* durable fail-closed state remains */ }
      return publicOperation(changed);
    }
  }

  async #expire(value, now) {
    const changed = await this.#change(value, {
      status: "expired", lifecycleState: "timed_out", decisionKind: "timeout", decidedAt: now,
    }, now);
    const session = safeSession(await this.#sessions.resolveOwned({ ownerIdentityId: value.ownerIdentityId, bindingId: value.bindingId, promptId: value.promptId }), value);
    return this.#rejectTerminal(changed, session, "expired");
  }

  async #rejectTerminal(value, session, reason) {
    let upstreamReplyState = "accepted";
    try {
      const accepted = await this.#adapter.replyToolConfirmation({ directory: session.directory, requestId: value.upstreamRequestId, reply: "reject", message: `Confirmation ${reason}` });
      if (accepted !== true) upstreamReplyState = "rejected";
    } catch {
      upstreamReplyState = "unknown";
      try { await this.#adapter.interrupt({ directory: session.directory, sessionId: session.sessionId }); } catch { /* timeout is already durable */ }
    }
    const changed = await this.#change(value, { upstreamReplyState }, this.#clock());
    await this.#audit({ action: "agent.operation_timed_out", ownerIdentityId: value.ownerIdentityId, operationId: value.id, actionDigest: value.actionDigest, occurredAt: this.#clock().toISOString() });
    return publicOperation(changed);
  }

  async #change(value, changes, now) {
    const changed = { ...value, ...changes, revision: value.revision + 1, updatedAt: now };
    const result = await this.#repository.updateOperation(changed, value.revision);
    if (!result) throw new PlatformError("agent_operation_not_found", "Agent operation confirmation does not exist", { status: 404 });
    return result;
  }
}
