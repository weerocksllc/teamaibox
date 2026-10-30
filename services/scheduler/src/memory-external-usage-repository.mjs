function copy(value) { return value == null ? null : structuredClone(value); }
export class MemoryExternalUsageRepository {
  #items = new Map(); #tail = Promise.resolve();
  async #exclusive(operation) { const prior = this.#tail; let release; this.#tail = new Promise((resolve) => { release = resolve; }); await prior; try { return await operation(); } finally { release(); } }
  async record(value) { return this.#exclusive(async () => { const current = this.#items.get(value.attemptId); if (current) { if (JSON.stringify(current) !== JSON.stringify(value)) { const error = new Error("External usage already has different facts"); error.code = "external_usage_conflict"; throw error; } return copy(current); } this.#items.set(value.attemptId, copy(value)); return copy(value); }); }
  async findByAttempt(attemptId) { return copy(this.#items.get(attemptId)); }
}
