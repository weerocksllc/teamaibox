function copy(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

export class MemoryAssistantRepository {
  #conversations = new Map();
  #messages = new Map();
  #runs = new Map();
  #events = new Map();
  #idempotency = new Map();
  #waiters = new Map();
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

  #idempotencyKey(ownerIdentityId, conversationId, key) {
    return `${ownerIdentityId}\u0000${conversationId}\u0000${key}`;
  }

  async insertConversation(conversation) {
    return this.#exclusive(async () => {
      if (this.#conversations.has(conversation.id)) throw new Error("assistant conversation already exists");
      this.#conversations.set(conversation.id, copy(conversation));
      this.#messages.set(conversation.id, []);
      this.#events.set(conversation.id, []);
      return copy(conversation);
    });
  }

  async findOwnedConversation(ownerIdentityId, conversationId) {
    const conversation = this.#conversations.get(conversationId);
    return copy(conversation?.ownerIdentityId === ownerIdentityId ? conversation : null);
  }

  async listOwnedConversations(ownerIdentityId) {
    return [...this.#conversations.values()]
      .filter((conversation) => conversation.ownerIdentityId === ownerIdentityId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(copy);
  }

  async updateConversation(conversation) {
    if (!this.#conversations.has(conversation.id)) return null;
    this.#conversations.set(conversation.id, copy(conversation));
    return copy(conversation);
  }

  async insertSubmission({ userMessage, assistantMessage, run, idempotencyKey, requestDigest, events }) {
    return this.#exclusive(async () => {
      const compound = this.#idempotencyKey(run.ownerIdentityId, run.conversationId, idempotencyKey);
      const existing = this.#idempotency.get(compound);
      if (existing) {
        return {
          inserted: false,
          requestDigest: existing.requestDigest,
          run: copy(this.#runs.get(existing.runId)),
        };
      }
      const messages = this.#messages.get(run.conversationId);
      if (!messages) return null;
      messages.push(copy(userMessage), copy(assistantMessage));
      this.#runs.set(run.id, copy(run));
      this.#idempotency.set(compound, { requestDigest, runId: run.id });
      for (const event of events) this.#appendEvent(event);
      return { inserted: true, requestDigest, run: copy(run) };
    });
  }

  async listMessages(conversationId) {
    return copy(this.#messages.get(conversationId) ?? []);
  }

  async findMessage(conversationId, messageId) {
    return copy((this.#messages.get(conversationId) ?? []).find((message) => message.id === messageId) ?? null);
  }

  async updateMessage(message) {
    const messages = this.#messages.get(message.conversationId);
    const index = messages?.findIndex((candidate) => candidate.id === message.id) ?? -1;
    if (index < 0) return null;
    messages[index] = copy(message);
    return copy(message);
  }

  async findRun(runId) {
    return copy(this.#runs.get(runId) ?? null);
  }

  async findOwnedRun(ownerIdentityId, runId) {
    const run = this.#runs.get(runId);
    return copy(run?.ownerIdentityId === ownerIdentityId ? run : null);
  }

  async updateRun(run) {
    if (!this.#runs.has(run.id)) return null;
    this.#runs.set(run.id, copy(run));
    return copy(run);
  }

  async appendEvent(event) {
    return this.#exclusive(async () => copy(this.#appendEvent(event)));
  }

  #appendEvent(event) {
    const events = this.#events.get(event.conversationId);
    if (!events) throw new Error("assistant conversation event stream does not exist");
    const record = { ...copy(event), sequence: events.length + 1 };
    events.push(record);
    const waiters = this.#waiters.get(event.conversationId);
    if (waiters) {
      this.#waiters.delete(event.conversationId);
      for (const resolve of waiters) resolve();
    }
    return record;
  }

  async listEvents(conversationId, afterSequence = 0) {
    return copy((this.#events.get(conversationId) ?? []).filter((event) => event.sequence > afterSequence));
  }

  async waitForEvents(conversationId, afterSequence, { signal, timeoutMs = 15_000 } = {}) {
    if ((this.#events.get(conversationId) ?? []).some((event) => event.sequence > afterSequence)) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        const waiters = this.#waiters.get(conversationId);
        waiters?.delete(finish);
        if (waiters?.size === 0) this.#waiters.delete(conversationId);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      const waiters = this.#waiters.get(conversationId) ?? new Set();
      waiters.add(finish);
      this.#waiters.set(conversationId, waiters);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
  }
}
