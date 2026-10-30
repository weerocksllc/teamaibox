const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION = /^[a-z][a-z0-9_.-]{2,127}$/;

function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid");
  return result.rows;
}

export class PostgresPluginCapabilityDescriptorResolver {
  #database;
  constructor({ database }) {
    if (!database?.query) throw new TypeError("PostgreSQL database is required");
    this.#database = database;
  }

  async resolve({ computePluginId, modelProfileId }) {
    if (!UUID.test(computePluginId ?? "") || !UUID.test(modelProfileId ?? "")) {
      throw new TypeError("compute plugin capability identity is invalid");
    }
    const row = rows(await this.#database.query(`
      SELECT plugin.plugin_key, capability.api_operations
      FROM plugins.plugins plugin
      JOIN plugins.plugin_versions version ON version.id = plugin.current_version_id
      JOIN compute.model_profiles profile ON profile.id = $2
      JOIN compute.capabilities capability ON capability.id = profile.capability_id
      WHERE plugin.id = $1 AND plugin.plugin_type = 'compute'
        AND plugin.lifecycle_state = 'enabled'
        AND version.plugin_id = plugin.id
        AND version.supply_chain_state = 'verified'
        AND version.install_state = 'healthy'
        AND capability.lifecycle_state = 'active'`, [computePluginId, modelProfileId]))[0];
    const operations = typeof row?.api_operations === "string" ? JSON.parse(row.api_operations) : row?.api_operations;
    if (!row || !Array.isArray(operations) || operations.length < 1 || operations.length > 32
      || operations.some((operation) => typeof operation !== "string" || !OPERATION.test(operation))
      || new Set(operations).size !== operations.length) return null;
    return Object.freeze({ pluginId: row.plugin_key, operations: Object.freeze([...operations].sort()) });
  }
}
