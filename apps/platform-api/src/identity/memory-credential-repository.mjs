import { randomUUID } from "node:crypto";

function copy(value) {
  return value === null ? null : structuredClone(value);
}

export class CredentialRepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CredentialRepositoryError";
    this.code = code;
  }
}

export class MemoryCredentialRepository {
  #principals = new Map();
  #credentials = new Map();
  #credentialByHash = new Map();

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

  async insertCredential(credential) {
    if (this.#credentialByHash.has(credential.tokenHash)) {
      throw new CredentialRepositoryError("credential_collision", "Credential collision");
    }
    const value = { ...copy(credential), id: credential.id ?? randomUUID() };
    this.#credentials.set(value.id, value);
    this.#credentialByHash.set(value.tokenHash, value.id);
    return copy(value);
  }

  async findCredentialByHash(tokenHash) {
    const id = this.#credentialByHash.get(tokenHash);
    return copy(id ? this.#credentials.get(id) : null);
  }

  async findCredentialById(credentialId) {
    return copy(this.#credentials.get(credentialId) ?? null);
  }

  async listCredentialsForSubject(subjectIdentityId) {
    return [...this.#credentials.values()]
      .filter((credential) => credential.subjectIdentityId === subjectIdentityId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map(copy);
  }

  async touchCredential(credentialId, at) {
    const credential = this.#credentials.get(credentialId);
    if (!credential || credential.revokedAt) return false;
    credential.lastUsedAt = new Date(at);
    return true;
  }

  async revokeCredential(credentialId, at, reason) {
    const credential = this.#credentials.get(credentialId);
    if (!credential || credential.revokedAt) return false;
    credential.revokedAt = new Date(at);
    credential.revokeReason = reason;
    return true;
  }
}
