function copy(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

export class ArtifactProvenanceRepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ArtifactProvenanceRepositoryError";
    this.code = code;
  }
}

export class MemoryArtifactProvenanceRepository {
  #records = new Map();
  #byDigest = new Map();
  #byObject = new Map();
  #handoffs = [];
  #tail = Promise.resolve();

  async #exclusive(operation) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  async create(record) {
    return this.#exclusive(async () => {
      const existingId = this.#byDigest.get(record.provenanceDigest);
      if (existingId) return { record: copy(this.#records.get(existingId)), created: false };
      if (this.#records.has(record.id)) throw new ArtifactProvenanceRepositoryError("artifact_provenance_conflict", "Artifact provenance identity already exists");
      const stored = copy(record);
      this.#records.set(stored.id, stored);
      this.#byDigest.set(stored.provenanceDigest, stored.id);
      const key = `${stored.object.objectId}:${stored.object.objectVersion}`;
      const values = this.#byObject.get(key) ?? [];
      values.push(stored.id);
      this.#byObject.set(key, values);
      return { record: copy(stored), created: true };
    });
  }

  async findById(id) {
    return copy(this.#records.get(id) ?? null);
  }

  async findLatestByObject(objectId, objectVersion) {
    const ids = this.#byObject.get(`${objectId}:${objectVersion}`) ?? [];
    return copy(ids.length ? this.#records.get(ids.at(-1)) : null);
  }

  async recordHandoff(value) {
    return this.#exclusive(async () => {
      const stored = copy(value);
      this.#handoffs.push(stored);
      return copy(stored);
    });
  }

  async lineage(id) {
    const root = this.#records.get(id);
    if (!root) return null;
    const visited = new Set();
    const records = [];
    const pending = [root];
    while (pending.length) {
      const record = pending.pop();
      if (!record || visited.has(record.id)) continue;
      visited.add(record.id);
      records.push(copy(record));
      for (const source of [...record.sources].reverse()) {
        if (source.provenanceId) pending.push(this.#records.get(source.provenanceId));
      }
    }
    return { rootId: id, records };
  }

  async handoffsForObject(objectId, objectVersion) {
    return this.#handoffs
      .filter((value) => value.objectId === objectId && value.objectVersion === objectVersion)
      .map(copy);
  }
}
