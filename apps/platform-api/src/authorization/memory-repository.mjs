function copy(value) {
  return value === null ? null : structuredClone(value);
}

export class MemoryAuthorizationRepository {
  #principals = new Map();

  constructor(principals = []) {
    for (const principal of principals) this.upsertPrincipal(principal);
  }

  upsertPrincipal(principal) {
    if (!principal?.id) throw new TypeError("principal id is required");
    this.#principals.set(principal.id, copy(principal));
  }

  async loadPrincipalAccess(identityId) {
    return copy(this.#principals.get(identityId) ?? null);
  }
}

