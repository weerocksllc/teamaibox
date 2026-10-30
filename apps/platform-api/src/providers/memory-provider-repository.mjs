function copy(value) { return value == null ? null : structuredClone(value); }
function conflict(code, message) { const error = new Error(message); error.code = code; throw error; }

export class MemoryExternalProviderRepository {
  #items = new Map();
  #byKey = new Map();
  #tail = Promise.resolve();

  async #exclusive(operation) {
    const prior = this.#tail; let release; this.#tail = new Promise((resolve) => { release = resolve; });
    await prior; try { return await operation(); } finally { release(); }
  }
  async list() { return [...this.#items.values()].filter((item) => item.lifecycleState !== "removed").sort((a, b) => a.providerKey.localeCompare(b.providerKey)).map(copy); }
  async listRoutable() { return this.list(); }
  async findById(id) { return copy(this.#items.get(id)); }
  async findByKey(key) { return copy(this.#items.get(this.#byKey.get(key))); }
  async create(value) { return this.#exclusive(async () => { if (this.#items.has(value.providerId) || this.#byKey.has(value.providerKey)) conflict("provider_key_conflict", "Provider already exists"); this.#items.set(value.providerId, copy(value)); this.#byKey.set(value.providerKey, value.providerId); return copy(value); }); }
  async setLifecycle(id, revision, lifecycleState, updatedAt) { return this.#exclusive(async () => { const item = this.#items.get(id); if (!item) return null; if (item.revision !== revision) conflict("provider_revision_conflict", "Provider revision changed"); item.lifecycleState = lifecycleState; item.revision += 1; item.updatedAt = new Date(updatedAt); return copy(item); }); }
  async recordContractTest(id, revision, observation) { return this.#exclusive(async () => { const item = this.#items.get(id); if (!item) return null; if (item.revision !== revision) conflict("provider_revision_conflict", "Provider revision changed"); Object.assign(item, copy(observation)); item.revision += 1; return copy(item); }); }
  async recordHealth(id, observation) { return this.#exclusive(async () => { const item = this.#items.get(id); if (!item || item.lifecycleState === "removed") return null; item.lifecycleState = observation.lifecycleState; item.health = copy(observation.health); return copy(item); }); }
  async remove(id, revision, updatedAt) { return this.#exclusive(async () => { const item = this.#items.get(id); if (!item) return null; if (item.revision !== revision) conflict("provider_revision_conflict", "Provider revision changed"); item.lifecycleState = "removed"; item.revision += 1; item.updatedAt = new Date(updatedAt); return copy(item); }); }
}
