import { PlatformError } from "../../../packages/observability/src/index.mjs";

function copy(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function bindingKey(ownerIdentityId, conversationId) {
  return `${ownerIdentityId}\0${conversationId}`;
}

function promptKey(bindingId, idempotencyKey) {
  return `${bindingId}\0${idempotencyKey}`;
}

function eventKey(bindingId, connectionId, connectionOrdinal) {
  return `${bindingId}\0${connectionId}\0${connectionOrdinal}`;
}

export class MemoryAgentSessionRepository {
  #bindings = new Map();
  #bindingsByConversation = new Map();
  #prompts = new Map();
  #promptsByIdempotency = new Map();
  #promptsByRun = new Map();
  #events = new Map();
  #eventDeduplication = new Map();
  #reconciliations = new Map();
  #openReconciliations = new Map();
  #tail = Promise.resolve();

  async #exclusive(operation) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async insertBinding(binding) {
    return this.#exclusive(async () => {
      const key = bindingKey(binding.ownerIdentityId, binding.platformConversationId);
      const existingId = this.#bindingsByConversation.get(key);
      if (existingId) return { inserted: false, binding: copy(this.#bindings.get(existingId)) };
      this.#bindings.set(binding.id, copy(binding));
      this.#bindingsByConversation.set(key, binding.id);
      this.#events.set(binding.id, []);
      return { inserted: true, binding: copy(binding) };
    });
  }

  async findOwnedBinding(ownerIdentityId, conversationId) {
    const id = this.#bindingsByConversation.get(bindingKey(ownerIdentityId, conversationId));
    return copy(id ? this.#bindings.get(id) : null);
  }

  async findBinding(bindingId) {
    return copy(this.#bindings.get(bindingId) ?? null);
  }

  async updateBinding(binding) {
    return this.#exclusive(async () => {
      if (!this.#bindings.has(binding.id)) return null;
      this.#bindings.set(binding.id, copy(binding));
      return copy(binding);
    });
  }

  async insertPrompt(prompt) {
    return this.#exclusive(async () => {
      const idempotency = promptKey(prompt.bindingId, prompt.idempotencyKey);
      const existingId = this.#promptsByIdempotency.get(idempotency);
      if (existingId) return { inserted: false, prompt: copy(this.#prompts.get(existingId)) };
      const existingRun = this.#promptsByRun.get(prompt.platformRunId);
      if (existingRun) return { inserted: false, prompt: copy(this.#prompts.get(existingRun)) };
      this.#prompts.set(prompt.id, copy(prompt));
      this.#promptsByIdempotency.set(idempotency, prompt.id);
      this.#promptsByRun.set(prompt.platformRunId, prompt.id);
      return { inserted: true, prompt: copy(prompt) };
    });
  }

  async findPrompt(promptId) {
    return copy(this.#prompts.get(promptId) ?? null);
  }

  async updatePrompt(prompt, expectedRevision) {
    return this.#exclusive(async () => {
      const current = this.#prompts.get(prompt.id);
      if (!current) return null;
      if (current.revision !== expectedRevision) {
        throw new PlatformError("agent_prompt_revision_conflict", "Agent prompt changed concurrently", { status: 409, retryable: true });
      }
      this.#prompts.set(prompt.id, copy(prompt));
      return copy(prompt);
    });
  }

  async appendEvent(event) {
    return this.#exclusive(async () => {
      const key = eventKey(event.bindingId, event.connectionId, event.connectionOrdinal);
      const existing = this.#eventDeduplication.get(key);
      if (existing) return { inserted: false, event: copy(existing) };
      const binding = this.#bindings.get(event.bindingId);
      if (!binding) return null;
      const record = { ...copy(event), sequence: binding.eventTailSequence + 1 };
      binding.eventTailSequence = record.sequence;
      binding.updatedAt = event.createdAt;
      this.#bindings.set(binding.id, binding);
      this.#events.get(binding.id).push(record);
      this.#eventDeduplication.set(key, record);
      return { inserted: true, event: copy(record) };
    });
  }

  async listEvents(bindingId, afterSequence, limit) {
    return copy((this.#events.get(bindingId) ?? [])
      .filter((event) => event.sequence > afterSequence)
      .slice(0, limit));
  }

  async beginCrashReconciliation({ reconciliationId, bindingId, reasonCode, now }) {
    return this.#exclusive(async () => {
      const binding = this.#bindings.get(bindingId);
      if (!binding) return null;
      const openId = this.#openReconciliations.get(bindingId);
      if (openId) {
        return {
          binding: copy(binding),
          reconciliation: copy(this.#reconciliations.get(openId)),
          prompts: copy([...this.#prompts.values()].filter((prompt) => prompt.bindingId === bindingId)),
        };
      }
      if (binding.state === "terminal") {
        throw new PlatformError("agent_binding_terminal", "Agent session mapping is terminal", { status: 409 });
      }
      binding.state = "reconciling";
      binding.crashGeneration += 1;
      binding.updatedAt = now;
      for (const prompt of this.#prompts.values()) {
        if (prompt.bindingId !== bindingId || new Set(["admitted", "completed", "failed", "cancelled", "incomplete"]).has(prompt.status)) continue;
        prompt.status = "reconcile_required";
        prompt.revision += 1;
        prompt.updatedAt = now;
      }
      const reconciliation = {
        id: reconciliationId,
        bindingId,
        crashGeneration: binding.crashGeneration,
        state: "open",
        reasonCode,
        upstreamSessionExists: null,
        acceptedMessageIds: null,
        outcome: null,
        createdAt: now,
        resolvedAt: null,
      };
      this.#reconciliations.set(reconciliation.id, reconciliation);
      this.#openReconciliations.set(bindingId, reconciliation.id);
      return {
        binding: copy(binding), reconciliation: copy(reconciliation),
        prompts: copy([...this.#prompts.values()].filter((prompt) => prompt.bindingId === bindingId)),
      };
    });
  }

  async resolveCrashReconciliation({ bindingId, upstreamSessionExists, acceptedMessageIds, now }) {
    return this.#exclusive(async () => {
      const binding = this.#bindings.get(bindingId);
      const reconciliationId = this.#openReconciliations.get(bindingId);
      const reconciliation = reconciliationId ? this.#reconciliations.get(reconciliationId) : null;
      if (!binding || !reconciliation) return null;
      const accepted = new Set(acceptedMessageIds);
      const summary = { resumed: 0, readyToSubmit: 0, incomplete: 0 };
      for (const prompt of this.#prompts.values()) {
        if (prompt.bindingId !== bindingId || prompt.status !== "reconcile_required") continue;
        prompt.revision += 1;
        prompt.updatedAt = now;
        if (upstreamSessionExists && accepted.has(prompt.opencodeMessageId)) {
          prompt.status = "accepted";
          prompt.acceptanceBoundary = "accepted";
          prompt.acceptedAt ??= now;
          summary.resumed += 1;
          continue;
        }
        if (upstreamSessionExists && prompt.acceptanceBoundary === "unknown") {
          prompt.status = "admitted";
          prompt.acceptanceBoundary = "none";
          prompt.submittedAt = null;
          summary.readyToSubmit += 1;
          continue;
        }
        prompt.status = "incomplete";
        prompt.terminal = {
          code: upstreamSessionExists ? "accepted_message_missing" : "upstream_session_lost",
          retryable: false,
          requiresHumanReconciliation: prompt.acceptanceBoundary !== "none",
        };
        prompt.completedAt = now;
        summary.incomplete += 1;
      }
      binding.state = upstreamSessionExists ? "active" : "terminal";
      binding.terminal = upstreamSessionExists ? null : {
        code: "upstream_session_lost",
        requiresExplicitReplacement: true,
      };
      binding.reconciledAt = now;
      binding.updatedAt = now;
      reconciliation.state = "resolved";
      reconciliation.upstreamSessionExists = upstreamSessionExists;
      reconciliation.acceptedMessageIds = [...accepted].sort();
      reconciliation.outcome = summary;
      reconciliation.resolvedAt = now;
      this.#openReconciliations.delete(bindingId);
      return {
        binding: copy(binding), reconciliation: copy(reconciliation), summary: copy(summary),
        prompts: copy([...this.#prompts.values()].filter((prompt) => prompt.bindingId === bindingId)),
      };
    });
  }
}
