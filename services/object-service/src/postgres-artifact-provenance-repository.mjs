import { ArtifactProvenanceRepositoryError } from "./memory-artifact-provenance-repository.mjs";

function rows(result) { return Array.isArray(result?.rows) ? result.rows : []; }
function iso(value) { return new Date(value).toISOString(); }
function sha(value) { return `sha256:${Buffer.from(value).toString("hex")}`; }
function shaBytes(value) { return Buffer.from(value.slice(7), "hex"); }
function json(value) { return typeof value === "string" ? JSON.parse(value) : structuredClone(value); }

function source(row) {
  return Object.freeze({
    ordinal: Number(row.source_ordinal), relationship: row.relationship,
    objectId: row.source_object_id, objectVersion: Number(row.source_object_version),
    sha256: sha(row.source_sha256), provenanceId: row.source_provenance_id,
  });
}

function record(row, sources = []) {
  if (!row) return null;
  return Object.freeze({
    id: row.id, artifactKind: row.artifact_kind,
    object: Object.freeze({
      objectId: row.object_id, objectVersion: Number(row.object_version), size: Number(row.byte_size),
      mediaType: row.media_type, sha256: sha(row.sha256), objectKey: row.object_key,
    }),
    ownerIdentityId: row.owner_identity_id,
    producer: Object.freeze({
      kind: row.producer_kind, key: row.producer_key,
      applicationKey: row.application_key, jobId: row.job_id,
    }),
    sources: Object.freeze(sources), metadata: Object.freeze(json(row.metadata)),
    provenanceDigest: sha(row.provenance_digest), createdAt: new Date(row.created_at),
  });
}

function repositoryError(error) {
  if (error?.code === "23505") return new ArtifactProvenanceRepositoryError("artifact_provenance_conflict", "Artifact provenance already exists");
  return error;
}

export class PostgresArtifactProvenanceRepository {
  #database;

  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL artifact provenance repository requires transactions");
    this.#database = database;
  }

  async #sources(executor, id) {
    return rows(await executor.query(`
      SELECT source_ordinal,relationship,source_object_id,source_object_version,source_sha256,source_provenance_id
      FROM objects.artifact_provenance_sources WHERE provenance_id=$1 ORDER BY source_ordinal`, [id])).map(source);
  }

  async #record(executor, row) {
    return row ? record(row, await this.#sources(executor, row.id)) : null;
  }

  async create(value) {
    try {
      return await this.#database.transaction(async (transaction) => {
        const existing = rows(await transaction.query(
          "SELECT * FROM objects.artifact_provenance WHERE provenance_digest=$1 FOR SHARE",
          [shaBytes(value.provenanceDigest)],
        ))[0];
        if (existing) return { record: await this.#record(transaction, existing), created: false };
        const inserted = rows(await transaction.query(`
          INSERT INTO objects.artifact_provenance (
            id,artifact_kind,object_id,object_version,byte_size,media_type,sha256,object_key,
            owner_identity_id,producer_kind,producer_key,application_key,job_id,metadata,provenance_digest,created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16)
          RETURNING *`, [
          value.id, value.artifactKind, value.object.objectId, value.object.objectVersion,
          value.object.size, value.object.mediaType, shaBytes(value.object.sha256), value.object.objectKey,
          value.ownerIdentityId, value.producer.kind, value.producer.key,
          value.producer.applicationKey, value.producer.jobId, JSON.stringify(value.metadata),
          shaBytes(value.provenanceDigest), value.createdAt,
        ]))[0];
        for (const item of value.sources) {
          await transaction.query(`
            INSERT INTO objects.artifact_provenance_sources (
              provenance_id,source_ordinal,relationship,source_object_id,source_object_version,source_sha256,source_provenance_id
            ) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
            value.id, item.ordinal, item.relationship, item.objectId, item.objectVersion,
            shaBytes(item.sha256), item.provenanceId,
          ]);
        }
        return { record: await this.#record(transaction, inserted), created: true };
      });
    } catch (error) { throw repositoryError(error); }
  }

  async findById(id) {
    return this.#record(this.#database, rows(await this.#database.query(
      "SELECT * FROM objects.artifact_provenance WHERE id=$1", [id],
    ))[0]);
  }

  async findLatestByObject(objectId, objectVersion) {
    return this.#record(this.#database, rows(await this.#database.query(`
      SELECT * FROM objects.artifact_provenance
      WHERE object_id=$1 AND object_version=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
    [objectId, objectVersion]))[0]);
  }

  async recordHandoff(value) {
    const row = rows(await this.#database.query(`
      INSERT INTO objects.artifact_handoffs (
        id,provenance_id,object_id,object_version,actor_identity_id,consumer_kind,consumer_key,
        application_key,job_id,audience,operation,occurred_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [
      value.id, value.provenanceId, value.objectId, value.objectVersion, value.actorIdentityId,
      value.consumer.kind, value.consumer.key, value.consumer.applicationKey, value.consumer.jobId,
      value.audience, value.operation, value.occurredAt,
    ]))[0];
    return Object.freeze({
      id: row.id, provenanceId: row.provenance_id, objectId: row.object_id,
      objectVersion: Number(row.object_version), actorIdentityId: row.actor_identity_id,
      consumer: Object.freeze({ kind: row.consumer_kind, key: row.consumer_key, applicationKey: row.application_key, jobId: row.job_id }),
      audience: row.audience, operation: row.operation, occurredAt: new Date(row.occurred_at),
    });
  }

  async lineage(id) {
    const root = await this.findById(id);
    if (!root) return null;
    const result = [], seen = new Set([root.id]), queue = [root];
    while (queue.length) {
      const current = queue.shift();
      result.push(current);
      for (const item of current.sources) {
        if (item.provenanceId && !seen.has(item.provenanceId)) {
          seen.add(item.provenanceId);
          const parent = await this.findById(item.provenanceId);
          if (parent) queue.push(parent);
        }
      }
    }
    return Object.freeze({ rootId: id, records: Object.freeze(result) });
  }
}
