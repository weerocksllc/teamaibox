function copy(value) { return value == null ? null : structuredClone(value); }

function conflict(code, message) { const error = new Error(message); error.code = code; throw error; }

export class MemoryOfflineMediaRepository {
  #media = new Map();
  #artifacts = new Map();
  #tail = Promise.resolve();

  async #exclusive(operation) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  async listMedia({ nodeId = null } = {}) {
    return [...this.#media.values()].filter((value) => nodeId === null || value.nodeId === nodeId)
      .sort((left, right) => left.volumeLabel.localeCompare(right.volumeLabel) || left.mediaId.localeCompare(right.mediaId)).map(copy);
  }

  async findMedia(mediaId) { return copy(this.#media.get(mediaId) ?? null); }
  async findByDeviceIdentity(deviceIdentitySha256) { return copy([...this.#media.values()].find((value) => value.deviceIdentitySha256 === deviceIdentitySha256) ?? null); }

  async upsertObservation({ existingMediaId = null, value }) {
    return this.#exclusive(async () => {
      if (existingMediaId === null) {
        if ([...this.#media.values()].some((item) => item.deviceIdentitySha256 === value.deviceIdentitySha256)) conflict("offline_media_identity_conflict", "Offline media identity already exists");
        this.#media.set(value.mediaId, copy(value));
        return copy(value);
      }
      const current = this.#media.get(existingMediaId);
      if (!current) return null;
      if (current.deviceIdentitySha256 !== value.deviceIdentitySha256) conflict("offline_media_identity_conflict", "Offline media identity changed");
      const contentChanged = current.observedManifestSha256 !== value.observedManifestSha256 || current.availability !== "attached";
      const next = {
        ...current, ...copy(value), mediaId: current.mediaId, revision: current.revision + 1,
        approvalState: contentChanged ? "pending" : current.approvalState,
        lifecycleState: contentChanged ? "discovered" : current.lifecycleState,
        health: contentChanged ? { state: "unknown", errorCode: null, observedAt: value.lastSeenAt } : current.health,
        createdAt: current.createdAt, createdBy: current.createdBy,
      };
      this.#media.set(existingMediaId, next);
      return copy(next);
    });
  }

  async markDetached(mediaId, expectedRevision, now) {
    return this.#exclusive(async () => {
      const current = this.#media.get(mediaId);
      if (!current) return null;
      if (current.revision !== expectedRevision) conflict("offline_media_revision_conflict", "Offline media revision changed");
      if (current.availability === "detached") return copy(current);
      const next = { ...current, availability: "detached", lifecycleState: "detached", approvalState: "pending", mediaHandle: null,
        health: { state: "detached", errorCode: "offline_media_removed", observedAt: now }, revision: current.revision + 1, updatedAt: now };
      this.#media.set(mediaId, next);
      return copy(next);
    });
  }

  async approveIndex(mediaId, expectedRevision, approval) {
    return this.#exclusive(async () => {
      const current = this.#media.get(mediaId);
      if (!current) return null;
      if (current.revision !== expectedRevision) conflict("offline_media_revision_conflict", "Offline media revision changed");
      if (current.availability !== "attached") conflict("offline_media_detached", "Offline media is detached");
      const next = { ...current, ...copy(approval.media), revision: current.revision + 1, updatedAt: approval.media.approvedAt };
      this.#media.set(mediaId, next);
      this.#artifacts.set(mediaId, copy(approval.artifacts));
      return copy(next);
    });
  }

  async listArtifacts(mediaId) { return copy(this.#artifacts.get(mediaId) ?? []); }
}
