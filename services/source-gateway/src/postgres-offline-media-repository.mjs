function rows(value) { if (!value || !Array.isArray(value.rows)) throw new TypeError("PostgreSQL offline media result is invalid"); return value.rows; }
function json(value) { return typeof value === "string" ? JSON.parse(value) : structuredClone(value); }
function bytes(value) { return Buffer.from(value.slice(7), "hex"); }
function digest(value) { return `sha256:${Buffer.from(value).toString("hex")}`; }
function copy(value) { return value == null ? null : structuredClone(value); }
function conflict(code, message) { const error = new Error(message); error.code = code; throw error; }

function media(row) {
  if (!row) return null;
  return { ...json(row.record), mediaId: row.id, nodeId: row.node_id, deviceIdentitySha256: digest(row.device_identity_sha256),
    filesystemUuid: row.filesystem_uuid, volumeLabel: row.volume_label, observedManifestSha256: digest(row.observed_manifest_sha256),
    availability: row.availability, approvalState: row.approval_state, lifecycleState: row.lifecycle_state,
    revision: Number(row.revision), createdBy: row.created_by, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) };
}

function artifact(row) { return row ? json(row.artifact) : null; }
function record(value) { const result = copy(value); for (const key of ["mediaId", "nodeId", "deviceIdentitySha256", "filesystemUuid", "volumeLabel", "observedManifestSha256", "availability", "approvalState", "lifecycleState", "revision", "createdBy", "createdAt", "updatedAt"]) delete result[key]; return result; }

export class PostgresOfflineMediaRepository {
  #database;
  constructor({ database }) { if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL offline media repository requires transactions"); this.#database = database; }

  async listMedia({ nodeId = null } = {}) { return rows(await this.#database.query(`SELECT * FROM source_center.offline_media
    WHERE ($1::uuid IS NULL OR node_id=$1) ORDER BY volume_label,id`, [nodeId])).map(media); }
  async findMedia(mediaId) { return media(rows(await this.#database.query("SELECT * FROM source_center.offline_media WHERE id=$1", [mediaId]))[0]); }
  async findByDeviceIdentity(deviceIdentitySha256) { return media(rows(await this.#database.query("SELECT * FROM source_center.offline_media WHERE device_identity_sha256=$1", [bytes(deviceIdentitySha256)]))[0]); }

  async upsertObservation({ existingMediaId = null, value }) {
    try {
      if (existingMediaId === null) return media(rows(await this.#database.query(`INSERT INTO source_center.offline_media
        (id,node_id,device_identity_sha256,filesystem_uuid,volume_label,observed_manifest_sha256,availability,approval_state,lifecycle_state,record,revision,created_by,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,'attached','pending','discovered',$7::jsonb,1,$8,$9,$9) RETURNING *`, [value.mediaId, value.nodeId,
        bytes(value.deviceIdentitySha256), value.filesystemUuid, value.volumeLabel, bytes(value.observedManifestSha256), JSON.stringify(record(value)), value.createdBy, value.createdAt]))[0]);
      return this.#database.transaction(async (transaction) => {
        const current = media(rows(await transaction.query("SELECT * FROM source_center.offline_media WHERE id=$1 FOR UPDATE", [existingMediaId]))[0]);
        if (!current) return null;
        if (current.deviceIdentitySha256 !== value.deviceIdentitySha256) conflict("offline_media_identity_conflict", "Offline media identity changed");
        const contentChanged = current.observedManifestSha256 !== value.observedManifestSha256 || current.availability !== "attached";
        const next = { ...current, ...copy(value), mediaId: current.mediaId, revision: current.revision + 1,
          approvalState: contentChanged ? "pending" : current.approvalState, lifecycleState: contentChanged ? "discovered" : current.lifecycleState,
          health: contentChanged ? { state: "unknown", errorCode: null, observedAt: value.lastSeenAt } : current.health,
          createdAt: current.createdAt, createdBy: current.createdBy };
        return media(rows(await transaction.query(`UPDATE source_center.offline_media SET node_id=$2,filesystem_uuid=$3,volume_label=$4,
          observed_manifest_sha256=$5,availability=$6,approval_state=$7,lifecycle_state=$8,record=$9::jsonb,revision=revision+1,updated_at=$10
          WHERE id=$1 RETURNING *`, [existingMediaId, next.nodeId, next.filesystemUuid, next.volumeLabel, bytes(next.observedManifestSha256), next.availability,
          next.approvalState, next.lifecycleState, JSON.stringify(record(next)), next.updatedAt]))[0]);
      });
    } catch (error) { if (error?.code === "23505") conflict("offline_media_identity_conflict", "Offline media identity already exists"); throw error; }
  }

  async markDetached(mediaId, expectedRevision, now) {
    const result = media(rows(await this.#database.query(`UPDATE source_center.offline_media SET availability='detached',approval_state='pending',
      lifecycle_state='detached',record=(record - 'mediaHandle') || jsonb_build_object('health',jsonb_build_object('state','detached','errorCode','offline_media_removed','observedAt',$3::timestamptz)),
      revision=revision+1,updated_at=$3 WHERE id=$1 AND revision=$2 AND availability='attached' RETURNING *`, [mediaId, expectedRevision, now]))[0]);
    if (!result) { const current = await this.findMedia(mediaId); if (current && current.revision !== expectedRevision) conflict("offline_media_revision_conflict", "Offline media revision changed"); return current; }
    return result;
  }

  async approveIndex(mediaId, expectedRevision, approval) {
    return this.#database.transaction(async (transaction) => {
      const current = media(rows(await transaction.query("SELECT * FROM source_center.offline_media WHERE id=$1 FOR UPDATE", [mediaId]))[0]);
      if (!current) return null;
      if (current.revision !== expectedRevision) conflict("offline_media_revision_conflict", "Offline media revision changed");
      if (current.availability !== "attached") conflict("offline_media_detached", "Offline media is detached");
      const next = { ...current, ...copy(approval.media), revision: current.revision + 1, updatedAt: approval.media.approvedAt };
      const updated = media(rows(await transaction.query(`UPDATE source_center.offline_media SET approval_state=$3,lifecycle_state=$4,record=$5::jsonb,
        revision=revision+1,updated_at=$6 WHERE id=$1 AND revision=$2 RETURNING *`, [mediaId, expectedRevision, next.approvalState, next.lifecycleState, JSON.stringify(record(next)), next.updatedAt]))[0]);
      if (!updated) conflict("offline_media_revision_conflict", "Offline media revision changed");
      await transaction.query("DELETE FROM source_center.offline_media_artifacts WHERE media_id=$1", [mediaId]);
      for (const [ordinal, value] of approval.artifacts.entries()) await transaction.query(`INSERT INTO source_center.offline_media_artifacts
        (media_id,ordinal,ecosystem,package_name,package_version,architecture,relative_path,sha256,byte_size,artifact)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [mediaId, ordinal, value.ecosystem, value.name, value.version, value.architecture, value.relativePath, bytes(value.sha256), value.sizeBytes, JSON.stringify(value)]);
      await transaction.query(`INSERT INTO source_center.offline_media_approvals
        (media_id,media_revision,manifest_sha256,signer_fingerprint,inventory,approved_by,approved_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`, [mediaId, updated.revision, bytes(approval.media.approvedManifestSha256), approval.media.manifestSignerFingerprint,
        JSON.stringify(approval.media.inventory), approval.media.approvedBy, approval.media.approvedAt]);
      return updated;
    });
  }

  async listArtifacts(mediaId) { return rows(await this.#database.query("SELECT artifact FROM source_center.offline_media_artifacts WHERE media_id=$1 ORDER BY ordinal", [mediaId])).map(artifact); }
}
