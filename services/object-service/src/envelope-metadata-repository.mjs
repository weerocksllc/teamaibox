function copy(value) {
  return value === null ? null : structuredClone(value);
}

export class EnvelopeMetadataRepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EnvelopeMetadataRepositoryError";
    this.code = code;
  }
}

export class MemoryEnvelopeMetadataRepository {
  #records = new Map();

  async load(blobKey) {
    return copy(this.#records.get(blobKey) ?? null);
  }

  async putIfAbsent(record) {
    if (this.#records.has(record.blobKey)) return false;
    this.#records.set(record.blobKey, copy(record));
    return true;
  }

  async compareAndSwap(blobKey, expectedRevision, record) {
    const current = this.#records.get(blobKey);
    if (!current || current.revision !== expectedRevision) return false;
    this.#records.set(blobKey, copy(record));
    return true;
  }

  async delete(blobKey) {
    const current = this.#records.get(blobKey);
    this.#records.delete(blobKey);
    return copy(current ?? null);
  }

  async list({ keyVersion = null, cursor = "", limit = 100 } = {}) {
    const records = [...this.#records.values()]
      .filter((record) => record.blobKey > cursor
        && (keyVersion === null || record.keyEnvelope.keyVersion === keyVersion))
      .sort((left, right) => left.blobKey.localeCompare(right.blobKey))
      .slice(0, limit);
    return records.map(copy);
  }

  async countByKeyVersion(keyVersion) {
    return [...this.#records.values()]
      .filter((record) => record.keyEnvelope.keyVersion === keyVersion).length;
  }
}
