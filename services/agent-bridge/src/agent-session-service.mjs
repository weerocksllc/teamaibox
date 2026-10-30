import { createHash, randomUUID } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_KEY = /^[a-z][a-z0-9_.-]{2,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const TERMINAL_PROMPT_STATES = new Set(["completed", "failed", "cancelled", "incomplete"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function copy(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function requireUuid(value, name) {
  if (typeof value !== "string" || !UUID.test(value)) throw new PlatformError("agent_identity_invalid", `${name} is invalid`, { status: 400 });
  return value;
}

function requireKey(value, name) {
  if (typeof value !== "string" || !SAFE_KEY.test(value)) throw new PlatformError("agent_key_invalid", `${name} is invalid`, { status: 400 });
  return value;
}

function requireUpstreamId(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(value)) {
    throw new PlatformError("agent_upstream_identity_invalid", `${name} is invalid`, { status: 400 });
  }
  return value;
}

function publicBinding(binding) {
  return Object.freeze({
    id: binding.id,
    ownerIdentityId: binding.ownerIdentityId,
    platformConversationId: binding.platformConversationId,
    workspaceKey: binding.workspaceKey,
    sandboxKey: binding.sandboxKey,
    adapterKey: binding.adapterKey,
    upstreamVersion: binding.upstreamVersion,
    upstreamArtifactDigest: binding.upstreamArtifactDigest,
    opencodeSessionId: binding.opencodeSessionId,
    state: binding.state,
    crashGeneration: binding.crashGeneration,
    eventCursor: binding.eventTailSequence,
    terminal: copy(binding.terminal),
    createdAt: binding.createdAt.toISOString(),
    updatedAt: binding.updatedAt.toISOString(),
    reconciledAt: binding.reconciledAt?.toISOString() ?? null,
  });
}

function publicPrompt(prompt) {
  return Object.freeze({
    id: prompt.id,
    bindingId: prompt.bindingId,
    platformRunId: prompt.platformRunId,
    opencodeMessageId: prompt.opencodeMessageId,
    status: prompt.status,
    acceptanceBoundary: prompt.acceptanceBoundary,
    terminal: copy(prompt.terminal),
    revision: prompt.revision,
    createdAt: prompt.createdAt.toISOString(),
    submittedAt: prompt.submittedAt?.toISOString() ?? null,
    acceptedAt: prompt.acceptedAt?.toISOString() ?? null,
    completedAt: prompt.completedAt?.toISOString() ?? null,
    updatedAt: prompt.updatedAt.toISOString(),
  });
}

function publicEvent(event) {
  return Object.freeze({
    id: event.id,
    bindingId: event.bindingId,
    promptId: event.promptId,
    sequence: event.sequence,
    type: event.eventType,
    data: Object.freeze(copy(event.eventData)),
    createdAt: event.createdAt.toISOString(),
  });
}

export class AgentSessionService {
  #repository;
  #clock;
  #audit;

  constructor({ repository, clock = () => new Date(), audit = async () => {} }) {
    const methods = [
      "insertBinding", "findOwnedBinding", "findBinding", "updateBinding", "insertPrompt", "findPrompt",
      "updatePrompt", "appendEvent", "listEvents", "beginCrashReconciliation", "resolveCrashReconciliation",
    ];
    if (!repository || methods.some((method) => typeof repository[method] !== "function")) throw new TypeError("Agent session repository is incomplete");
    if (typeof clock !== "function" || typeof audit !== "function") throw new TypeError("Agent session dependencies are invalid");
    this.#repository = repository;
    this.#clock = clock;
    this.#audit = audit;
  }

  async bindConversation({
    ownerIdentityId, platformConversationId, workspaceKey, sandboxKey,
    adapterKey, upstreamVersion, upstreamArtifactDigest, opencodeSessionId,
  }) {
    requireUuid(ownerIdentityId, "Agent owner identity");
    requireUuid(platformConversationId, "Platform conversation identity");
    requireKey(workspaceKey, "Agent workspace key");
    requireKey(sandboxKey, "Agent sandbox key");
    requireKey(adapterKey, "OpenCode adapter key");
    if (typeof upstreamVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(upstreamVersion) || !SHA256.test(upstreamArtifactDigest)) {
      throw new PlatformError("agent_upstream_version_invalid", "Pinned OpenCode version is invalid", { status: 400 });
    }
    requireUpstreamId(opencodeSessionId, "OpenCode session identity");
    const now = this.#clock();
    const value = {
      id: randomUUID(), ownerIdentityId, platformConversationId, workspaceKey, sandboxKey,
      adapterKey, upstreamVersion, upstreamArtifactDigest, opencodeSessionId,
      state: "active", crashGeneration: 0, eventTailSequence: 0, terminal: null,
      createdAt: now, updatedAt: now, reconciledAt: null,
    };
    const result = await this.#repository.insertBinding(value);
    const immutableKeys = ["workspaceKey", "sandboxKey", "adapterKey", "upstreamVersion", "upstreamArtifactDigest", "opencodeSessionId"];
    if (!result.inserted && immutableKeys.some((key) => result.binding[key] !== value[key])) {
      throw new PlatformError("agent_binding_conflict", "Conversation is already bound to different OpenCode facts", { status: 409 });
    }
    if (result.inserted) {
      await this.#audit({ action: "agent.session_bound", ownerIdentityId, platformConversationId, bindingId: value.id, adapterKey, occurredAt: now.toISOString() });
    }
    return publicBinding(result.binding);
  }

  async getBinding(ownerIdentityId, platformConversationId) {
    const binding = await this.#ownedBinding(ownerIdentityId, platformConversationId);
    return publicBinding(binding);
  }

  async admitPrompt(ownerIdentityId, platformConversationId, {
    platformRunId, idempotencyKey, model, agent = null, parts,
  }) {
    const binding = await this.#ownedBinding(ownerIdentityId, platformConversationId);
    if (binding.state !== "active") throw new PlatformError("agent_binding_unavailable", "Agent session is not active", { status: 409, retryable: binding.state === "reconciling" });
    requireUuid(platformRunId, "Platform Agent run identity");
    if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new PlatformError("agent_idempotency_invalid", "Agent prompt idempotency key is invalid", { status: 400 });
    }
    if (!model || typeof model.providerId !== "string" || typeof model.modelId !== "string" || !Array.isArray(parts) || parts.length === 0) {
      throw new PlatformError("agent_prompt_invalid", "Agent prompt declaration is invalid", { status: 400 });
    }
    const requestDigest = digest({ platformRunId, model, agent, parts });
    const now = this.#clock();
    const value = {
      id: randomUUID(), bindingId: binding.id, platformRunId, idempotencyKey, requestDigest,
      opencodeMessageId: `msg_${randomUUID().replaceAll("-", "")}`,
      status: "admitted", acceptanceBoundary: "none", terminal: null, revision: 1,
      createdAt: now, submittedAt: null, acceptedAt: null, completedAt: null, updatedAt: now,
    };
    const result = await this.#repository.insertPrompt(value);
    if (!result.inserted && result.prompt.requestDigest !== requestDigest) {
      throw new PlatformError("agent_idempotency_conflict", "Agent idempotency key was reused with different prompt facts", { status: 409 });
    }
    if (!result.inserted && result.prompt.platformRunId !== platformRunId) {
      throw new PlatformError("agent_run_conflict", "Platform Agent run is already mapped to another prompt", { status: 409 });
    }
    if (result.inserted) {
      await this.#audit({ action: "agent.prompt_admitted", ownerIdentityId, platformConversationId, bindingId: binding.id, promptId: value.id, occurredAt: now.toISOString() });
    }
    return publicPrompt(result.prompt);
  }

  async markSubmitting(promptId) {
    return this.#transition(promptId, new Set(["admitted"]), (prompt, now) => ({
      ...prompt, status: "submitting", acceptanceBoundary: "unknown", submittedAt: now,
    }));
  }

  async markAccepted(promptId) {
    return this.#transition(promptId, new Set(["submitting", "reconcile_required"]), (prompt, now) => ({
      ...prompt, status: "accepted", acceptanceBoundary: "accepted", acceptedAt: prompt.acceptedAt ?? now,
    }));
  }

  async markRunning(promptId) {
    return this.#transition(promptId, new Set(["accepted"]), (prompt) => ({ ...prompt, status: "running" }));
  }

  async markSubmissionUncertain(promptId, reasonCode = "transport_outcome_unknown") {
    requireKey(reasonCode, "Agent uncertainty reason");
    const value = await this.#transition(promptId, new Set(["submitting"]), (prompt) => ({ ...prompt, status: "reconcile_required" }));
    await this.#audit({ action: "agent.prompt_uncertain", promptId, reasonCode, occurredAt: this.#clock().toISOString() });
    return value;
  }

  async completePrompt(promptId, { status, code, retryable = false, details = null }) {
    if (!TERMINAL_PROMPT_STATES.has(status) || typeof code !== "string" || !SAFE_KEY.test(code)) {
      throw new PlatformError("agent_terminal_invalid", "Agent terminal outcome is invalid", { status: 400 });
    }
    return this.#transition(promptId, new Set(["accepted", "running", "reconcile_required"]), (prompt, now) => ({
      ...prompt, status, terminal: { code, retryable: Boolean(retryable), details: copy(details) }, completedAt: now,
    }));
  }

  async appendEvent(bindingId, { promptId = null, connectionId, connectionOrdinal, upstreamEventId = null, type, data }) {
    requireUuid(bindingId, "Agent binding identity");
    if (promptId !== null) requireUuid(promptId, "Agent prompt identity");
    requireUuid(connectionId, "Agent event connection identity");
    if (!Number.isSafeInteger(connectionOrdinal) || connectionOrdinal <= 0
      || typeof type !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,255}$/.test(type)
      || !data || typeof data !== "object" || Array.isArray(data)
      || Buffer.byteLength(JSON.stringify(data)) > 1024 * 1024
      || (upstreamEventId !== null && (typeof upstreamEventId !== "string" || upstreamEventId.length > 512))) {
      throw new PlatformError("agent_event_invalid", "Agent event is invalid", { status: 400 });
    }
    const result = await this.#repository.appendEvent({
      id: randomUUID(), bindingId, promptId, connectionId, connectionOrdinal,
      upstreamEventId, eventType: type, eventData: copy(data), createdAt: this.#clock(),
    });
    if (!result) throw new PlatformError("agent_binding_not_found", "Agent session mapping does not exist", { status: 404 });
    return Object.freeze({ inserted: result.inserted, event: publicEvent(result.event) });
  }

  async replayEvents(ownerIdentityId, platformConversationId, { after = 0, limit = 200 } = {}) {
    const binding = await this.#ownedBinding(ownerIdentityId, platformConversationId);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new PlatformError("agent_cursor_invalid", "Agent event cursor is invalid", { status: 400 });
    }
    const events = await this.#repository.listEvents(binding.id, after, limit);
    return Object.freeze({
      bindingId: binding.id,
      events: Object.freeze(events.map(publicEvent)),
      cursor: events.at(-1)?.sequence ?? after,
      hasMore: events.length === limit,
    });
  }

  async beginCrashReconciliation(bindingId, reasonCode) {
    requireUuid(bindingId, "Agent binding identity");
    requireKey(reasonCode, "Agent crash reason");
    const result = await this.#repository.beginCrashReconciliation({
      reconciliationId: randomUUID(), bindingId, reasonCode, now: this.#clock(),
    });
    if (!result) throw new PlatformError("agent_binding_not_found", "Agent session mapping does not exist", { status: 404 });
    await this.#audit({ action: "agent.crash_reconciliation_started", bindingId, crashGeneration: result.binding.crashGeneration, reasonCode, occurredAt: result.reconciliation.createdAt.toISOString() });
    return Object.freeze({
      binding: publicBinding(result.binding),
      reconciliationId: result.reconciliation.id,
      prompts: Object.freeze(result.prompts.map(publicPrompt)),
    });
  }

  async resolveCrashReconciliation(bindingId, { upstreamSessionExists, acceptedMessageIds }) {
    requireUuid(bindingId, "Agent binding identity");
    if (typeof upstreamSessionExists !== "boolean" || !Array.isArray(acceptedMessageIds)
      || acceptedMessageIds.some((value) => typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(value))) {
      throw new PlatformError("agent_reconciliation_evidence_invalid", "Agent reconciliation evidence is invalid", { status: 400 });
    }
    const result = await this.#repository.resolveCrashReconciliation({
      bindingId, upstreamSessionExists, acceptedMessageIds: [...new Set(acceptedMessageIds)], now: this.#clock(),
    });
    if (!result) throw new PlatformError("agent_reconciliation_not_found", "Open Agent crash reconciliation does not exist", { status: 404 });
    await this.#audit({ action: "agent.crash_reconciliation_resolved", bindingId, crashGeneration: result.binding.crashGeneration, upstreamSessionExists, summary: result.summary, occurredAt: result.reconciliation.resolvedAt.toISOString() });
    return Object.freeze({
      binding: publicBinding(result.binding), summary: Object.freeze(result.summary),
      prompts: Object.freeze(result.prompts.map(publicPrompt)),
    });
  }

  async #ownedBinding(ownerIdentityId, platformConversationId) {
    requireUuid(ownerIdentityId, "Agent owner identity");
    requireUuid(platformConversationId, "Platform conversation identity");
    const binding = await this.#repository.findOwnedBinding(ownerIdentityId, platformConversationId);
    if (!binding) throw new PlatformError("agent_binding_not_found", "Agent session mapping does not exist", { status: 404 });
    return binding;
  }

  async #transition(promptId, expectedStates, mutate) {
    requireUuid(promptId, "Agent prompt identity");
    const prompt = await this.#repository.findPrompt(promptId);
    if (!prompt) throw new PlatformError("agent_prompt_not_found", "Agent prompt does not exist", { status: 404 });
    if (!expectedStates.has(prompt.status)) {
      throw new PlatformError("agent_prompt_state_conflict", "Agent prompt state transition is invalid", { status: 409 });
    }
    const now = this.#clock();
    const changed = mutate(copy(prompt), now);
    changed.revision = prompt.revision + 1;
    changed.updatedAt = now;
    const updated = await this.#repository.updatePrompt(changed, prompt.revision);
    if (!updated) throw new PlatformError("agent_prompt_not_found", "Agent prompt does not exist", { status: 404 });
    return publicPrompt(updated);
  }
}

export const agentPromptDigest = digest;
