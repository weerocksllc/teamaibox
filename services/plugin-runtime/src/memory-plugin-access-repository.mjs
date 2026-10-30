function copy(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

export class MemoryPluginAccessRepository {
  #plugins = new Map();
  #delegations = new Map();
  #delegationByHash = new Map();
  #profiles = new Map();
  #workers = new Map();
  #registrations = new Map();

  seedPlugin(plugin) { this.#plugins.set(plugin.pluginId, copy(plugin)); }
  seedProfile(profile) { this.#profiles.set(profile.modelProfileId, copy(profile)); }
  seedWorker(worker) { this.#workers.set(worker.workerId, copy(worker)); }

  async getActivePlugin(pluginId) { return copy(this.#plugins.get(pluginId) ?? null); }

  async insertDelegation(record) {
    if (this.#delegationByHash.has(record.tokenHash)) {
      const error = new Error("delegated token collision");
      error.code = "delegated_token_collision";
      throw error;
    }
    this.#delegations.set(record.delegationId, copy(record));
    this.#delegationByHash.set(record.tokenHash, record.delegationId);
    return copy(record);
  }

  async getDelegation(delegationId) { return copy(this.#delegations.get(delegationId) ?? null); }

  async findDelegationByTokenHash(tokenHash) {
    const id = this.#delegationByHash.get(tokenHash);
    return copy(id ? this.#delegations.get(id) : null);
  }

  async touchDelegation(delegationId, now) {
    const record = this.#delegations.get(delegationId);
    if (!record || record.revokedAt) return false;
    record.lastUsedAt = now;
    return true;
  }

  async revokeDelegation(delegationId, now, reason) {
    const record = this.#delegations.get(delegationId);
    if (!record || record.revokedAt) return false;
    record.revokedAt = now;
    record.revokeReason = reason;
    return true;
  }

  async #revokeWhere(predicate, now, reason) {
    let count = 0;
    for (const record of this.#delegations.values()) {
      if (!record.revokedAt && predicate(record)) {
        record.revokedAt = now;
        record.revokeReason = reason;
        count += 1;
      }
    }
    return count;
  }

  revokeForSession(identityId, sessionId, now, reason) {
    return this.#revokeWhere((record) => record.identityId === identityId && record.sessionId === sessionId, now, reason);
  }

  revokeForPlugin(pluginId, now, reason) {
    return this.#revokeWhere((record) => record.pluginId === pluginId, now, reason);
  }

  async getWorker(workerId) { return copy(this.#workers.get(workerId) ?? null); }

  async getProfiles(profileIds) {
    return profileIds.map((id) => copy(this.#profiles.get(id) ?? null));
  }

  async putCapabilityRegistration(record) {
    const key = `${record.workerId}|${record.workerGeneration}|${record.modelProfileId}`;
    const previous = this.#registrations.get(key);
    if (previous && previous.registrationDigest !== record.registrationDigest) {
      const error = new Error("compute capability registration changed within one worker generation");
      error.code = "compute_registration_conflict";
      throw error;
    }
    if (!previous) this.#registrations.set(key, copy(record));
    return copy(this.#registrations.get(key));
  }

  async listCapabilityRegistrations(now) {
    return [...this.#registrations.values()]
      .filter((record) => record.state === "available" && new Date(record.expiresAt) > now)
      .map(copy);
  }

  async retireWorkerRegistrations(workerId, workerGeneration, now, reason) {
    let count = 0;
    for (const record of this.#registrations.values()) {
      if (record.workerId === workerId && record.workerGeneration === workerGeneration && record.state === "available") {
        record.state = "retired";
        record.retiredAt = now;
        record.retireReason = reason;
        count += 1;
      }
    }
    return count;
  }
}
