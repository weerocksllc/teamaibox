export class MemoryPluginImportRepository {
  #byVersion = new Map();

  async saveVerified(record) {
    const key = `${record.pluginId}@${record.version}`;
    const previous = this.#byVersion.get(key);
    if (previous) {
      if (previous.manifestPayloadDigest !== record.manifestPayloadDigest
        || previous.bundlePayloadDigest !== record.bundlePayloadDigest) {
        const error = new Error("plugin version already has different verified content");
        error.code = "plugin_version_conflict";
        throw error;
      }
      return structuredClone(previous);
    }
    const stored = structuredClone(record);
    this.#byVersion.set(key, stored);
    return structuredClone(stored);
  }

  async get(pluginId, version) {
    const value = this.#byVersion.get(`${pluginId}@${version}`);
    return value ? structuredClone(value) : null;
  }

  async list() {
    return [...this.#byVersion.values()]
      .map((value) => structuredClone(value))
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId) || left.version.localeCompare(right.version));
  }
}
