function copy(value) { return value == null ? null : structuredClone(value); }

function conflict(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export class MemoryClusterMetricRepository {
  #snapshots = new Map();
  #tail = Promise.resolve();

  async #exclusive(operation) {
    const prior = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release(); }
  }

  async record(value) {
    return this.#exclusive(async () => {
      const key = `${value.nodeId}:${value.nodeGeneration}:${value.sequence}`;
      const existing = this.#snapshots.get(key);
      if (existing) {
        if (existing.snapshotDigest !== value.snapshotDigest) {
          conflict("node_metric_sequence_conflict", "Node metric sequence already has different facts");
        }
        return copy(existing);
      }
      const latest = [...this.#snapshots.values()]
        .filter((item) => item.nodeId === value.nodeId && item.nodeGeneration === value.nodeGeneration)
        .sort((left, right) => right.sequence - left.sequence)[0];
      if (latest && latest.sequence > value.sequence) {
        conflict("node_metric_sequence_stale", "Node metric sequence is older than the recorded snapshot");
      }
      this.#snapshots.set(key, copy(value));
      return copy(value);
    });
  }

  async latestForNode(nodeId) {
    const value = [...this.#snapshots.values()]
      .filter((item) => item.nodeId === nodeId)
      .sort((left, right) => right.nodeGeneration - left.nodeGeneration
        || right.sequence - left.sequence
        || right.receivedAt.getTime() - left.receivedAt.getTime())[0];
    return copy(value ?? null);
  }

  async listLatest() {
    const latest = new Map();
    for (const value of this.#snapshots.values()) {
      const current = latest.get(value.nodeId);
      if (!current || value.nodeGeneration > current.nodeGeneration
          || (value.nodeGeneration === current.nodeGeneration && value.sequence > current.sequence)) {
        latest.set(value.nodeId, value);
      }
    }
    return [...latest.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId)).map(copy);
  }
}
