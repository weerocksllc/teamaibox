function copy(value) { return value === null || value === undefined ? value : structuredClone(value); }
function conflict(code, message) { const error = new Error(message); error.code = code; throw error; }

export class MemoryModelLifecycleRepository {
  #profiles = new Map();
  #events = new Map();
  #optIns = new Map();

  constructor({ profiles = [] } = {}) {
    for (const profile of profiles) {
      this.#profiles.set(profile.profileId, copy({
        revision: 1, reasonKey: "model.lifecycle.registered", evidenceRefs: [],
        validationRunId: null, updatedAt: new Date(), ...profile,
      }));
    }
  }

  async findProfile(profileId) { return copy(this.#profiles.get(profileId) ?? null); }

  async listProfiles({ limit, afterProfileKey = null }) {
    return [...this.#profiles.values()]
      .filter((profile) => afterProfileKey === null || profile.profileKey > afterProfileKey)
      .sort((left, right) => left.profileKey.localeCompare(right.profileKey))
      .slice(0, limit)
      .map(copy);
  }

  async transitionLifecycle({ profileId, expectedRevision, expectedState, nextState, reasonKey, evidenceRefs, validationRunId, actorIdentityId, occurredAt }) {
    const profile = this.#profiles.get(profileId);
    if (!profile) return null;
    if (profile.revision !== expectedRevision || profile.state !== expectedState) {
      conflict("model_lifecycle_revision_conflict", "profile lifecycle revision changed");
    }
    const fromState = profile.state;
    profile.state = nextState;
    profile.revision += 1;
    profile.reasonKey = reasonKey;
    profile.evidenceRefs = copy(evidenceRefs);
    profile.validationRunId = validationRunId;
    profile.updatedAt = new Date(occurredAt);
    const events = this.#events.get(profileId) ?? [];
    events.push({
      profileId, revision: profile.revision, fromState, toState: nextState,
      reasonKey, evidenceRefs: copy(evidenceRefs), validationRunId,
      actorIdentityId, occurredAt: new Date(occurredAt),
    });
    this.#events.set(profileId, events);
    return copy(profile);
  }

  async upsertExperimentalOptIn({ policyKey, environment, profileId, enabled, reasonKey, expiresAt, actorIdentityId, occurredAt }) {
    const key = `${policyKey}\u0000${environment}\u0000${profileId}`;
    const previous = this.#optIns.get(key);
    const record = {
      policyKey, environment, profileId, enabled, reasonKey,
      expiresAt: new Date(expiresAt), actorIdentityId,
      revision: (previous?.revision ?? 0) + 1,
      createdAt: previous?.createdAt ?? new Date(occurredAt),
      updatedAt: new Date(occurredAt),
    };
    this.#optIns.set(key, record);
    return copy(record);
  }

  async listExperimentalOptIns({ policyKey, environment, now }) {
    return [...this.#optIns.values()]
      .filter((record) => record.policyKey === policyKey && record.environment === environment
        && record.enabled && record.expiresAt > now)
      .sort((left, right) => left.profileId.localeCompare(right.profileId))
      .map(copy);
  }

  async listLifecycleEvents(profileId) { return copy(this.#events.get(profileId) ?? []); }
}
