function copy(value) {
  return value === null ? null : structuredClone(value);
}

export class MemoryTaskCenterRepository {
  #tasks = new Map();
  #events = new Map();
  #confirmations = new Map();
  #sequence = 0;

  async insertTask(task) {
    if (this.#tasks.has(task.id)) throw new Error("task already exists");
    this.#tasks.set(task.id, copy(task));
  }

  async findTask(taskId) {
    return copy(this.#tasks.get(taskId) ?? null);
  }

  async updateTask(task) {
    this.#tasks.set(task.id, copy(task));
  }

  async listTasksByOwner(ownerIdentityId) {
    return [...this.#tasks.values()]
      .filter((task) => task.ownerIdentityId === ownerIdentityId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(copy);
  }

  async appendTaskEvent(taskId, event) {
    const record = { ...copy(event), sequence: ++this.#sequence, taskId };
    const events = this.#events.get(taskId) ?? [];
    events.push(record);
    this.#events.set(taskId, events);
    return copy(record);
  }

  async listTaskEvents(taskId, afterSequence) {
    return (this.#events.get(taskId) ?? [])
      .filter((event) => event.sequence > afterSequence)
      .map(copy);
  }

  async insertAgentConfirmation(confirmation) {
    this.#confirmations.set(confirmation.id, copy(confirmation));
  }

  async findAgentConfirmation(confirmationId) {
    return copy(this.#confirmations.get(confirmationId) ?? null);
  }

  async updateAgentConfirmation(confirmation) {
    this.#confirmations.set(confirmation.id, copy(confirmation));
  }

  async listAgentConfirmationsByOwner(ownerIdentityId) {
    return [...this.#confirmations.values()]
      .filter((confirmation) => confirmation.ownerIdentityId === ownerIdentityId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(copy);
  }

  async expireAgentConfirmations(now) {
    for (const confirmation of this.#confirmations.values()) {
      if (confirmation.status === "pending" && confirmation.expiresAt <= now) {
        confirmation.status = "expired";
        confirmation.decidedAt = new Date(now);
      }
    }
  }
}

