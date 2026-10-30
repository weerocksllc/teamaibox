function clone(value) { return value == null ? null : structuredClone(value); }
export class MemoryAuditRepository {
  #events = [];
  async head() { const value = this.#events.at(-1); return value ? { sequenceId: value.sequenceId, eventHash: value.eventHash } : null; }
  async append(value) {
    const current = this.#events.at(-1)?.eventHash ?? null;
    if (current !== value.previousEventHash) return null;
    const stored = { sequenceId: this.#events.length + 1, ...clone(value.event), previousEventHash: value.previousEventHash,
      eventHash: value.eventHash, checkpoint: clone(value.checkpoint), canonicalEvent: clone(value.event) };
    this.#events.push(stored); return clone(stored);
  }
  async list({ domain = null, correlationId = null, afterSequence = null, limit = 100 }) {
    return this.#events.filter((item) => domain === null || item.domain === domain).filter((item) => correlationId === null || item.correlationId === correlationId).filter((item) => afterSequence === null || item.sequenceId < afterSequence)
      .sort((left, right) => right.sequenceId - left.sequenceId).slice(0, limit).map(clone);
  }
  async scan({ afterSequence = 0, throughSequence = null, limit = 1000 }) { return this.#events.filter((item) => item.sequenceId > afterSequence && (throughSequence === null || item.sequenceId <= throughSequence)).slice(0, limit).map(clone); }
  tamper(sequenceId, patch) { const index = this.#events.findIndex((item) => item.sequenceId === sequenceId); if (index >= 0) this.#events[index] = { ...this.#events[index], ...clone(patch) }; }
}
