import { PlatformError } from "../../../packages/observability/src/index.mjs";

function copy(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

export class MemoryWorkerRepository {
  #workers = new Map();
  #tail = Promise.resolve();

  constructor({ workers = [] } = {}) {
    for (const worker of workers) this.#workers.set(worker.workerId, copy(worker));
  }

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

  async create(worker) {
    return this.#exclusive(async () => {
      const previous = this.#workers.get(worker.workerId);
      if (previous) {
        const immutable = ["nodeId", "nodeGeneration", "computePluginId", "modelProfileId", "image", "architecture"];
        if (immutable.some((key) => previous[key] !== worker[key])) {
          throw new PlatformError("worker_identity_conflict", "Worker ID was reused with different immutable facts", { status: 409 });
        }
        return copy(previous);
      }
      this.#workers.set(worker.workerId, copy(worker));
      return copy(worker);
    });
  }

  async get(workerId) {
    const worker = this.#workers.get(workerId);
    if (!worker) throw new PlatformError("worker_not_found", "Compute worker does not exist", { status: 404 });
    return copy(worker);
  }

  async mutate(workerId, mutation) {
    return this.#exclusive(async () => {
      const current = this.#workers.get(workerId);
      if (!current) throw new PlatformError("worker_not_found", "Compute worker does not exist", { status: 404 });
      const next = await mutation(copy(current));
      if (!next || next.workerId !== workerId) throw new TypeError("worker mutation must preserve identity");
      this.#workers.set(workerId, copy(next));
      return copy(next);
    });
  }

  async list({ states } = {}) {
    const allowed = states ? new Set(states) : null;
    return [...this.#workers.values()]
      .filter((worker) => !allowed || allowed.has(worker.lifecycleState))
      .map(copy)
      .sort((left, right) => left.workerId.localeCompare(right.workerId));
  }
}
