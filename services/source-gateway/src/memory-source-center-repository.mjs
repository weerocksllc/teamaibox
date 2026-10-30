function copy(value) {
  return value == null ? null : structuredClone(value);
}

function conflict(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export class MemorySourceCenterRepository {
  #sources = new Map();
  #policies = new Map();
  #healthEvents = [];
  #tail = Promise.resolve();

  async #exclusive(operation) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  async listSources({ ecosystem = null } = {}) {
    return [...this.#sources.values()]
      .filter((source) => ecosystem === null || source.ecosystem === ecosystem)
      .sort((left, right) => left.ecosystem.localeCompare(right.ecosystem)
        || left.priority - right.priority || left.sourceKey.localeCompare(right.sourceKey))
      .map(copy);
  }

  async findSource(sourceId) { return copy(this.#sources.get(sourceId) ?? null); }

  async findSourceByKey(sourceKey) {
    return copy([...this.#sources.values()].find((source) => source.sourceKey === sourceKey) ?? null);
  }

  async createSource(value) {
    return this.#exclusive(async () => {
      if ([...this.#sources.values()].some((source) => source.sourceKey === value.sourceKey)) conflict("source_key_conflict", "source key already exists");
      this.#sources.set(value.sourceId, copy(value));
      return copy(value);
    });
  }

  async updateSource(sourceId, expectedRevision, patch) {
    return this.#exclusive(async () => {
      const current = this.#sources.get(sourceId);
      if (!current) return null;
      if (current.revision !== expectedRevision) conflict("source_revision_conflict", "source revision changed");
      if ([...this.#sources.values()].some((source) => source.sourceId !== sourceId && source.sourceKey === patch.sourceKey)) conflict("source_key_conflict", "source key already exists");
      const next = { ...copy(patch), sourceId, revision: current.revision + 1, createdBy: current.createdBy, createdAt: current.createdAt };
      this.#sources.set(sourceId, next);
      return copy(next);
    });
  }

  async recordHealth(sourceId, expectedRevision, health, updatedAt) {
    return this.#exclusive(async () => {
      const current = this.#sources.get(sourceId);
      if (!current) return null;
      if (current.revision !== expectedRevision) conflict("source_revision_conflict", "source revision changed");
      current.health = copy(health); current.revision += 1; current.updatedAt = new Date(updatedAt);
      this.#healthEvents.push({ sourceId, revision: current.revision, health: copy(health), recordedAt: new Date(updatedAt) });
      return copy(current);
    });
  }

  async listPolicies({ ecosystem = null } = {}) {
    return [...this.#policies.values()]
      .filter((policy) => ecosystem === null || policy.ecosystem === ecosystem)
      .sort((left, right) => left.ecosystem.localeCompare(right.ecosystem) || left.policyKey.localeCompare(right.policyKey))
      .map(copy);
  }

  async findPolicy(policyId) { return copy(this.#policies.get(policyId) ?? null); }

  async findPolicyByKey(policyKey) {
    return copy([...this.#policies.values()].find((policy) => policy.policyKey === policyKey) ?? null);
  }

  async createPolicy(value) {
    return this.#exclusive(async () => {
      if ([...this.#policies.values()].some((policy) => policy.policyKey === value.policyKey)) conflict("source_policy_key_conflict", "source policy key already exists");
      this.#policies.set(value.policyId, copy(value));
      return copy(value);
    });
  }

  async updatePolicy(policyId, expectedRevision, patch) {
    return this.#exclusive(async () => {
      const current = this.#policies.get(policyId);
      if (!current) return null;
      if (current.revision !== expectedRevision) conflict("source_policy_revision_conflict", "source policy revision changed");
      if ([...this.#policies.values()].some((policy) => policy.policyId !== policyId && policy.policyKey === patch.policyKey)) conflict("source_policy_key_conflict", "source policy key already exists");
      const next = { ...copy(patch), policyId, revision: current.revision + 1, createdBy: current.createdBy, createdAt: current.createdAt };
      this.#policies.set(policyId, next);
      return copy(next);
    });
  }
}
