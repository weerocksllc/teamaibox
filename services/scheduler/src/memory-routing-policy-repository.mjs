function copy(value) { return value == null ? null : structuredClone(value); }
function conflict(code, message) { const error = new Error(message); error.code = code; throw error; }

export class MemoryRoutingPolicyRepository {
  #items = new Map(); #byKey = new Map(); #tail = Promise.resolve();
  constructor(values = []) { for (const value of values) { this.#items.set(value.policyId, copy(value)); this.#byKey.set(value.policyKey, value.policyId); } }
  async #exclusive(operation) { const prior = this.#tail; let release; this.#tail = new Promise((resolve) => { release = resolve; }); await prior; try { return await operation(); } finally { release(); } }
  async list() { return [...this.#items.values()].sort((a, b) => a.policyKey.localeCompare(b.policyKey)).map(copy); }
  async findById(id) { return copy(this.#items.get(id)); }
  async findByKey(key) { return copy(this.#items.get(this.#byKey.get(key))); }
  async create(value) { return this.#exclusive(async () => { if (this.#items.has(value.policyId) || this.#byKey.has(value.policyKey)) conflict("routing_policy_key_conflict", "Routing policy already exists"); this.#items.set(value.policyId, copy(value)); this.#byKey.set(value.policyKey, value.policyId); return copy(value); }); }
  async update(id, revision, value) { return this.#exclusive(async () => { const current = this.#items.get(id); if (!current) return null; if (current.revision !== revision) conflict("routing_policy_revision_conflict", "Routing policy revision changed"); if (value.policyKey !== current.policyKey && this.#byKey.has(value.policyKey)) conflict("routing_policy_key_conflict", "Routing policy key already exists"); this.#byKey.delete(current.policyKey); Object.assign(current, copy(value), { revision: current.revision + 1 }); this.#byKey.set(current.policyKey, id); return copy(current); }); }
}
