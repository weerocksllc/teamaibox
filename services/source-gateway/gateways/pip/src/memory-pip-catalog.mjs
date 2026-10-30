function copy(value) { return value == null ? null : structuredClone(value); }

export class MemoryPipCatalog {
  #artifacts = new Map();
  async listProjects() { return [...new Set([...this.#artifacts.values()].map((item) => item.project))].sort(); }
  async listProjectArtifacts(project) { return [...this.#artifacts.values()].filter((item) => item.project === project).sort((a, b) => a.version.localeCompare(b.version) || a.filename.localeCompare(b.filename)).map(copy); }
  async findArtifact(artifactId) { return copy(this.#artifacts.get(artifactId) ?? null); }
  async putArtifact(value) {
    const collision = [...this.#artifacts.values()].find((item) => item.artifactId !== value.artifactId && item.project === value.project && item.filename === value.filename && item.sourceId === value.sourceId);
    if (collision && collision.sha256 !== value.sha256) { const error = new Error("PIP artifact identity changed"); error.code = "pip_artifact_conflict"; throw error; }
    this.#artifacts.set(value.artifactId, copy(value)); return copy(value);
  }
}

export class MemoryPipContentStore {
  #values = new Map();
  async get(key) { const value = this.#values.get(key); return value ? Buffer.from(value) : null; }
  async put(key, bytes) { this.#values.set(key, Buffer.from(bytes)); }
  async corrupt(key, bytes) { this.#values.set(key, Buffer.from(bytes)); }
}
