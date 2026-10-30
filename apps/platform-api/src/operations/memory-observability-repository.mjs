function copy(value) { return value == null ? null : structuredClone(value); }
function time(value) { return new Date(value).getTime(); }
function within(value, { since = null, until = null } = {}) {
  const at = time(value);
  return (since === null || at >= time(since)) && (until === null || at <= time(until));
}
function limited(values, limit) { return values.slice(0, limit).map(copy); }
function beforePosition(at, id, before) { return before == null || time(at) < time(before.at) || (time(at) === time(before.at) && id < before.id); }

export class MemoryObservabilityRepository {
  #signals = new Map();
  #health = new Map();
  #alerts = new Map();
  #exports = new Map();

  async insertSignal(value) { this.#signals.set(value.signalId, copy(value)); return copy(value); }
  async insertHealth(value) { this.#health.set(value.healthId, copy(value)); return copy(value); }

  async listSignals({ since = null, until = null, correlationId = null, producerKinds = null, limit = 1000, before = null } = {}) {
    return limited([...this.#signals.values()]
      .filter((item) => within(item.observedAt, { since, until }))
      .filter((item) => correlationId === null || item.correlationId === correlationId)
      .filter((item) => producerKinds === null || producerKinds.includes(item.producer.kind))
      .filter((item) => beforePosition(item.observedAt, item.signalId, before))
      .sort((left, right) => time(right.observedAt) - time(left.observedAt) || right.signalId.localeCompare(left.signalId)), limit);
  }

  async listHealth({ since = null, until = null, correlationId = null, targetKinds = null, limit = 1000, before = null } = {}) {
    return limited([...this.#health.values()]
      .filter((item) => within(item.observedAt, { since, until }))
      .filter((item) => beforePosition(item.observedAt, item.healthId, before))
      .filter((item) => correlationId === null || item.correlationId === correlationId)
      .filter((item) => targetKinds === null || targetKinds.includes(item.target.kind))
      .sort((left, right) => time(right.observedAt) - time(left.observedAt) || right.healthId.localeCompare(left.healthId)), limit);
  }

  async currentHealth() {
    const latest = new Map();
    for (const item of this.#health.values()) {
      const key = `${item.target.kind}:${item.target.key}`;
      const current = latest.get(key);
      if (!current || time(item.observedAt) > time(current.observedAt)
          || (time(item.observedAt) === time(current.observedAt) && item.healthId > current.healthId)) latest.set(key, item);
    }
    return [...latest.values()].sort((left, right) => left.target.kind.localeCompare(right.target.kind)
      || left.target.key.localeCompare(right.target.key)).map(copy);
  }

  async upsertAlert(value) {
    const existing = this.#alerts.get(value.alertKey);
    const next = existing ? {
      ...existing,
      ...copy(value),
      alertId: existing.alertId,
      openedAt: existing.openedAt,
      status: "open",
      resolvedAt: null,
      occurrenceCount: existing.occurrenceCount + 1,
      signalIds: [...new Set([...existing.signalIds, ...value.signalIds])],
      jobIds: [...new Set([...existing.jobIds, ...value.jobIds])],
    } : copy(value);
    this.#alerts.set(value.alertKey, next);
    return copy(next);
  }

  async resolveAlert(alertKey, { correlationId, resolvedAt }) {
    const current = this.#alerts.get(alertKey);
    if (!current || current.status === "resolved") return copy(current ?? null);
    current.status = "resolved";
    current.correlationId = correlationId;
    current.lastSeenAt = new Date(resolvedAt);
    current.resolvedAt = new Date(resolvedAt);
    return copy(current);
  }

  async listAlerts({ since = null, until = null, correlationId = null, statuses = null, targetKinds = null, limit = 1000, before = null } = {}) {
    return limited([...this.#alerts.values()]
      .filter((item) => within(item.lastSeenAt, { since, until }))
      .filter((item) => beforePosition(item.lastSeenAt, item.alertId, before))
      .filter((item) => correlationId === null || item.correlationId === correlationId)
      .filter((item) => statuses === null || statuses.includes(item.status))
      .filter((item) => targetKinds === null || targetKinds.includes(item.target.kind))
      .sort((left, right) => time(right.lastSeenAt) - time(left.lastSeenAt) || right.alertId.localeCompare(left.alertId)), limit);
  }

  async lookupJobIdsByAttemptIds(attemptIds) {
    const wanted = new Set(attemptIds), result = new Set();
    for (const item of this.#signals.values()) {
      if (item.attemptIds.some((attemptId) => wanted.has(attemptId))) for (const jobId of item.jobIds) result.add(jobId);
    }
    return [...result].sort();
  }

  async recordExport(value) { this.#exports.set(value.exportId, copy(value)); return copy(value); }

  async purgeBefore({ signalCutoffs, healthBefore, exportBefore, resolvedAlertBefore }) {
    const counts = { signals: 0, health: 0, exports: 0, alerts: 0 };
    for (const [id, item] of this.#health) if (time(item.observedAt) < time(healthBefore)) { this.#health.delete(id); counts.health += 1; }
    for (const [id, item] of this.#exports) if (time(item.createdAt) < time(exportBefore)) { this.#exports.delete(id); counts.exports += 1; }
    for (const [key, item] of this.#alerts) if (item.status === "resolved" && time(item.resolvedAt) < time(resolvedAlertBefore)) { this.#alerts.delete(key); counts.alerts += 1; }
    const protectedSignals = new Set([...this.#health.values()].map((item) => item.signalId).filter(Boolean));
    for (const item of this.#alerts.values()) if (item.status === "open") for (const signalId of item.signalIds) protectedSignals.add(signalId);
    for (const [id, item] of this.#signals) {
      const cutoff = signalCutoffs[item.kind];
      if (cutoff && !protectedSignals.has(id) && time(item.observedAt) < time(cutoff)) { this.#signals.delete(id); counts.signals += 1; }
    }
    return counts;
  }
}
