export class MemoryModelProfileRepository {
  #profiles = new Map();
  #operations = new Map();

  async registerImmutable({ profile, fingerprint, registeredBy, operationKey }) {
    const operation = this.#operations.get(operationKey);
    if (operation) {
      if (operation.profile.profileKey !== profile.profileKey || operation.fingerprint !== fingerprint) {
        const error = new Error("operation key was already used for another model profile");
        error.code = "model_profile_conflict";
        throw error;
      }
      return { profile: structuredClone(operation.profile), created: false };
    }
    const previous = this.#profiles.get(profile.profileKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        const error = new Error("model profile key is immutable");
        error.code = "model_profile_conflict";
        throw error;
      }
      this.#operations.set(operationKey, previous);
      return { profile: structuredClone(previous.profile), created: false };
    }
    const stored = {
      profile: structuredClone(profile), fingerprint, registeredBy, operationKey,
    };
    this.#profiles.set(profile.profileKey, stored);
    this.#operations.set(operationKey, stored);
    return { profile: structuredClone(profile), created: true };
  }

  async getByKey(profileKey) {
    const stored = this.#profiles.get(profileKey);
    return stored ? { profile: structuredClone(stored.profile), fingerprint: stored.fingerprint } : null;
  }
}
