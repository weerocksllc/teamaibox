import { randomUUID } from "node:crypto";

function copy(value) { return value === null || value === undefined ? value : structuredClone(value); }
function conflict(message) { const error = new Error(message); error.code = "model_revalidation_baseline_conflict"; throw error; }

export class MemoryModelRevalidationRepository {
  #baselines = new Map();
  #checks = [];
  #idFactory;
  constructor({ idFactory = randomUUID } = {}) { this.#idFactory = idFactory; }

  async putBaseline(record) {
    const items = this.#baselines.get(record.profileId) ?? [];
    const previous = items.find((item) => item.lifecycleRevision === record.lifecycleRevision
      || item.factsDigest === record.factsDigest);
    if (previous) {
      if (previous.lifecycleRevision !== record.lifecycleRevision || previous.factsDigest !== record.factsDigest
        || previous.validationRunId !== record.validationRunId) conflict("certification baseline immutable facts changed");
      return { baseline: copy(previous), created: false };
    }
    const baseline = { id: this.#idFactory(), ...copy(record) };
    items.push(baseline); this.#baselines.set(record.profileId, items);
    return { baseline: copy(baseline), created: true };
  }

  async getLatestBaseline(profileId) {
    const items = this.#baselines.get(profileId) ?? [];
    return copy([...items].sort((left, right) => right.lifecycleRevision - left.lifecycleRevision)[0] ?? null);
  }

  async recordCheck(record) {
    const check = { id: this.#idFactory(), ...copy(record) };
    this.#checks.push(check); return copy(check);
  }

  async listChecks(profileId) { return copy(this.#checks.filter((item) => item.profileId === profileId)); }
}
