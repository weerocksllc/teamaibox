function copy(value) { return value == null ? null : structuredClone(value); }
export class MemoryNpmCatalog {
  #values = new Map();
  async listPackages() { return [...new Set([...this.#values.values()].map((item) => item.packageName))].sort(); }
  async listPackageArtifacts(name) { return [...this.#values.values()].filter((item) => item.packageName === name).map(copy); }
  async findArtifact(id) { return copy(this.#values.get(id) ?? null); }
  async putArtifact(value) { const collision = [...this.#values.values()].find((item) => item.artifactId !== value.artifactId && item.packageName === value.packageName && item.version === value.version && item.sourceId === value.sourceId); if (collision && collision.integrity !== value.integrity) { const error = new Error("NPM package identity changed"); error.code = "npm_package_conflict"; throw error; } this.#values.set(value.artifactId, copy(value)); return copy(value); }
}
