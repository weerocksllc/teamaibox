function copy(value) {
  return value === null ? null : structuredClone(value);
}

export class ObjectGrantRepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ObjectGrantRepositoryError";
    this.code = code;
  }
}

export class MemoryObjectGrantRepository {
  #grants = new Map();

  async create(record) {
    if (this.#grants.has(record.referenceId)) {
      throw new ObjectGrantRepositoryError("grant_exists", "Object grant already exists");
    }
    this.#grants.set(record.referenceId, copy(record));
    return copy(record);
  }

  async find(referenceId) {
    return copy(this.#grants.get(referenceId) ?? null);
  }

  async revoke(referenceId, { revokedAt, revokedByIdentityId, reason }) {
    const record = this.#grants.get(referenceId);
    if (!record) return null;
    if (!record.revokedAt) {
      record.revokedAt = new Date(revokedAt);
      record.revokedByIdentityId = revokedByIdentityId;
      record.revokeReason = reason;
    }
    return copy(record);
  }

  async recordUse(referenceId, { usedAt }) {
    const record = this.#grants.get(referenceId);
    if (!record) return null;
    record.lastUsedAt = new Date(usedAt);
    record.useCount += 1;
    return copy(record);
  }
}
