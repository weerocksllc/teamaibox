import { Buffer } from "node:buffer";

function rows(result) { if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL PIP catalog result is invalid"); return result.rows; }
function json(value) { return typeof value === "string" ? JSON.parse(value) : structuredClone(value); }
function digest(value) { return value == null ? null : `sha256:${Buffer.from(value).toString("hex")}`; }
function digestBytes(value) { return value == null ? null : Buffer.from(value.slice(7), "hex"); }
function artifact(row) { return row ? { artifactId: row.id, project: row.project, version: row.package_version, filename: row.filename, sha256: digest(row.sha256), size: Number(row.byte_size), sourceId: row.source_id, sourceKind: row.source_kind, locationKey: row.location_key, upstreamUrl: row.upstream_url, requiresPython: row.requires_python, dependencies: json(row.dependencies), architectures: [...row.architectures], yankedReason: row.yanked_reason, coreMetadataSha256: digest(row.core_metadata_sha256), signatureStatus: row.signature_status, scanStatus: row.scan_status, license: row.license, cachedAt: row.cached_at == null ? null : new Date(row.cached_at), importedAt: new Date(row.imported_at) } : null; }
function conflict(code, message) { const error = new Error(message); error.code = code; throw error; }

export class PostgresPipCatalog {
  #database;
  constructor({ database }) { if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL PIP catalog requires transactions"); this.#database = database; }
  async listProjects() { return rows(await this.#database.query("SELECT DISTINCT project FROM source_center.pip_artifacts ORDER BY project")).map((row) => row.project); }
  async listProjectArtifacts(project) { return rows(await this.#database.query("SELECT * FROM source_center.pip_artifacts WHERE project=$1 ORDER BY package_version,filename,id", [project])).map(artifact); }
  async findArtifact(artifactId) { return artifact(rows(await this.#database.query("SELECT * FROM source_center.pip_artifacts WHERE id=$1", [artifactId]))[0]); }
  async putArtifact(value) {
    try {
      return await this.#database.transaction(async (transaction) => {
        const existing = artifact(rows(await transaction.query("SELECT * FROM source_center.pip_artifacts WHERE id=$1 FOR UPDATE", [value.artifactId]))[0]);
        if (existing) {
          const immutable = ["project", "version", "filename", "sha256", "size", "sourceId", "sourceKind", "locationKey", "upstreamUrl"];
          if (immutable.some((field) => existing[field] !== value[field])) conflict("pip_artifact_conflict", "PIP artifact immutable identity changed");
          return artifact(rows(await transaction.query("UPDATE source_center.pip_artifacts SET cached_at=COALESCE(cached_at,$2) WHERE id=$1 RETURNING *", [value.artifactId, value.cachedAt]))[0]);
        }
        return artifact(rows(await transaction.query(`INSERT INTO source_center.pip_artifacts (
          id,project,package_version,filename,sha256,byte_size,source_id,source_kind,location_key,upstream_url,requires_python,
          dependencies,architectures,yanked_reason,core_metadata_sha256,signature_status,scan_status,license,cached_at,imported_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`, [
          value.artifactId,value.project,value.version,value.filename,digestBytes(value.sha256),value.size,value.sourceId,value.sourceKind,value.locationKey,value.upstreamUrl,value.requiresPython,
          JSON.stringify(value.dependencies),value.architectures,value.yankedReason,digestBytes(value.coreMetadataSha256),value.signatureStatus,value.scanStatus,value.license,value.cachedAt,value.importedAt,
        ]))[0]);
      });
    } catch (error) { if (error?.code === "23505") conflict("pip_artifact_conflict", "PIP artifact filename already exists for the source"); throw error; }
  }
}
