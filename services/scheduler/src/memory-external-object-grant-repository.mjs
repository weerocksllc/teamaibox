function copy(value) { return value == null ? null : structuredClone(value); }

export class MemoryExternalObjectGrantRepository {
  #items = new Map();
  #byTicket = new Map();
  #tail = Promise.resolve();

  async #exclusive(operation) {
    const prior = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release(); }
  }

  async create(record) {
    return this.#exclusive(async () => {
      if (this.#items.has(record.grantId) || this.#byTicket.has(record.ticketDigest)) throw new Error("external object grant already exists");
      this.#items.set(record.grantId, copy(record));
      this.#byTicket.set(record.ticketDigest, record.grantId);
      return copy(record);
    });
  }

  async findByTicketDigest(ticketDigest) {
    return copy(this.#items.get(this.#byTicket.get(ticketDigest)) ?? null);
  }

  async authorize({ ticketDigest, operation, usedAt }) {
    return this.#exclusive(async () => {
      const record = this.#items.get(this.#byTicket.get(ticketDigest));
      if (!record || record.state !== "active" || new Date(record.expiresAt) <= new Date(usedAt)
          || !record.operations.includes(operation) || record.useCount >= record.maximumUses) return null;
      record.useCount += 1;
      record.lastUsedAt = new Date(usedAt);
      if (operation === "write") record.state = "consuming";
      return copy(record);
    });
  }

  async completeOutput(grantId, { completedAt, objectId, objectVersion, sha256 }) {
    return this.#exclusive(async () => {
      const record = this.#items.get(grantId);
      if (!record || record.state !== "consuming" || record.direction !== "output") return null;
      Object.assign(record, { state: "consumed", completedAt: new Date(completedAt), completedObjectId: objectId, completedObjectVersion: objectVersion, completedSha256: sha256 });
      return copy(record);
    });
  }

  async failOutput(grantId, { failedAt, failureCode }) {
    return this.#exclusive(async () => {
      const record = this.#items.get(grantId);
      if (!record || record.state !== "consuming") return null;
      Object.assign(record, { state: "failed", failedAt: new Date(failedAt), failureCode });
      return copy(record);
    });
  }

  async revokeAttempt({ ownerIdentityId, attemptId, revokedAt, reason }) {
    return this.#exclusive(async () => {
      const revoked = [];
      for (const record of this.#items.values()) {
        if (record.ownerIdentityId !== ownerIdentityId || record.attemptId !== attemptId
            || !new Set(["active", "consuming"]).has(record.state)) continue;
        Object.assign(record, { state: "revoked", revokedAt: new Date(revokedAt), revokeReason: reason });
        revoked.push(copy(record));
      }
      return revoked;
    });
  }
}
