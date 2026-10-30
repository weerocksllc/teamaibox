function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid");
  return result.rows;
}

function json(value) {
  return typeof value === "string" ? JSON.parse(value) : structuredClone(value);
}

function digest(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw new TypeError("PostgreSQL SHA-256 value is invalid");
  return `sha256:${Buffer.from(value).toString("hex")}`;
}

function digestBytes(value) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new TypeError("SHA-256 value is invalid");
  return Buffer.from(value.slice(7), "hex");
}

function mapped(row) {
  if (!row) return null;
  return {
    schemaVersion: 1,
    pluginId: row.plugin_key,
    pluginType: row.plugin_type,
    version: row.version,
    sourceKind: row.source_kind,
    manifest: json(row.manifest),
    manifestPayloadDigest: digest(row.manifest_payload_sha256),
    manifestSignerKeyId: row.manifest_signer_key_id,
    bundlePayloadDigest: digest(row.bundle_payload_sha256),
    bundleSignerKeyId: row.bundle_signer_key_id,
    imageDigests: [...row.image_digests],
    artifacts: json(row.artifacts),
    supplyChain: json(row.supply_chain),
    policyVersion: Number(row.policy_version),
    state: row.state,
    verifiedAt: new Date(row.verified_at).toISOString(),
  };
}

function different(left, right) {
  return left.manifestPayloadDigest !== right.manifestPayloadDigest
    || left.bundlePayloadDigest !== right.bundlePayloadDigest;
}

export class PostgresPluginImportRepository {
  #database;

  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL database adapter with query and transaction is required");
    this.#database = database;
  }

  async saveVerified(record) {
    return this.#database.transaction(async (transaction) => {
      const inserted = rows(await transaction.query(`
        INSERT INTO plugins.verified_imports (
          plugin_key, plugin_type, version, source_kind, manifest,
          manifest_payload_sha256, manifest_signer_key_id,
          bundle_payload_sha256, bundle_signer_key_id,
          image_digests, artifacts, supply_chain, policy_version, state,
          verified_at
        ) VALUES (
          $1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::text[],$11::jsonb,
          $12::jsonb,$13,$14,$15
        )
        ON CONFLICT (plugin_key, version) DO NOTHING
        RETURNING *`, [
        record.pluginId,
        record.pluginType,
        record.version,
        record.sourceKind,
        JSON.stringify(record.manifest),
        digestBytes(record.manifestPayloadDigest),
        record.manifestSignerKeyId,
        digestBytes(record.bundlePayloadDigest),
        record.bundleSignerKeyId,
        record.imageDigests,
        JSON.stringify(record.artifacts),
        JSON.stringify(record.supplyChain),
        record.policyVersion,
        record.state,
        record.verifiedAt,
      ]));
      if (inserted[0]) return mapped(inserted[0]);
      const current = mapped(rows(await transaction.query(`
        SELECT *
        FROM plugins.verified_imports
        WHERE plugin_key = $1 AND version = $2
        FOR UPDATE`, [record.pluginId, record.version]))[0]);
      if (!current || different(current, record)) {
        const error = new Error("plugin version already has different verified content");
        error.code = "plugin_version_conflict";
        throw error;
      }
      return current;
    });
  }

  async get(pluginId, version) {
    return mapped(rows(await this.#database.query(`
      SELECT * FROM plugins.verified_imports
      WHERE plugin_key = $1 AND version = $2`, [pluginId, version]))[0]);
  }

  async list() {
    return rows(await this.#database.query(`
      SELECT * FROM plugins.verified_imports
      ORDER BY plugin_key, version`, [])).map(mapped);
  }
}
