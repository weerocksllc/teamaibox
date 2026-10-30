import { Buffer } from "node:buffer";

import { EnvelopeMetadataRepositoryError } from "./envelope-metadata-repository.mjs";


function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL envelope metadata result is invalid");
  return result.rows;
}


function decoded(value, size) {
  if (!(value instanceof Uint8Array) || value.byteLength !== size) {
    throw new EnvelopeMetadataRepositoryError("metadata_corrupt", "Encrypted object metadata is corrupt");
  }
  return Buffer.from(value).toString("base64");
}


function encoded(value, size) {
  if (typeof value !== "string") throw new TypeError("encrypted object metadata encoding is invalid");
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== size || bytes.toString("base64") !== value) {
    throw new TypeError("encrypted object metadata encoding is invalid");
  }
  return bytes;
}


function digest(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new EnvelopeMetadataRepositoryError("metadata_corrupt", "Encrypted object digest is corrupt");
  }
  return Buffer.from(value).toString("hex");
}


function record(row) {
  if (!row) return null;
  return {
    schemaVersion: Number(row.schema_version),
    blobKey: row.blob_key,
    revision: Number(row.revision),
    plaintextSize: Number(row.plaintext_size),
    plaintextSha256: digest(row.plaintext_sha256),
    ciphertextSize: Number(row.ciphertext_size),
    ciphertextSha256: digest(row.ciphertext_sha256),
    dataEncryption: {
      algorithm: row.data_algorithm,
      nonce: decoded(row.data_nonce, 12),
      tag: decoded(row.data_tag, 16),
    },
    keyEnvelope: {
      algorithm: row.wrap_algorithm,
      keyVersion: Number(row.wrapping_key_version),
      nonce: decoded(row.wrap_nonce, 12),
      ciphertext: decoded(row.wrapped_data_key, 32),
      tag: decoded(row.wrap_tag, 16),
    },
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}


function values(value) {
  return [
    value.blobKey, value.schemaVersion, value.revision,
    value.plaintextSize, Buffer.from(value.plaintextSha256, "hex"),
    value.ciphertextSize, Buffer.from(value.ciphertextSha256, "hex"),
    value.dataEncryption.algorithm, encoded(value.dataEncryption.nonce, 12), encoded(value.dataEncryption.tag, 16),
    value.keyEnvelope.algorithm, value.keyEnvelope.keyVersion,
    encoded(value.keyEnvelope.nonce, 12), encoded(value.keyEnvelope.ciphertext, 32), encoded(value.keyEnvelope.tag, 16),
    value.createdAt, value.updatedAt,
  ];
}


export class PostgresEnvelopeMetadataRepository {
  #database;

  constructor({ database }) {
    if (!database?.query) throw new TypeError("PostgreSQL envelope metadata repository requires query");
    this.#database = database;
  }

  async load(blobKey) {
    return record(rows(await this.#database.query(
      "SELECT * FROM objects.encrypted_blobs WHERE blob_key=$1",
      [blobKey],
    ))[0]);
  }

  async putIfAbsent(value) {
    const result = await this.#database.query(`
      INSERT INTO objects.encrypted_blobs (
        blob_key,schema_version,revision,plaintext_size,plaintext_sha256,ciphertext_size,ciphertext_sha256,
        data_algorithm,data_nonce,data_tag,wrap_algorithm,wrapping_key_version,wrap_nonce,wrapped_data_key,wrap_tag,
        created_at,updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (blob_key) DO NOTHING`, values(value));
    return result.rowCount === 1;
  }

  async compareAndSwap(blobKey, expectedRevision, value) {
    const parameters = values(value);
    const result = await this.#database.query(`
      UPDATE objects.encrypted_blobs SET
        revision=$3,wrapping_key_version=$12,wrap_nonce=$13,wrapped_data_key=$14,wrap_tag=$15,updated_at=$17
      WHERE blob_key=$1 AND revision=$18`, [...parameters, expectedRevision]);
    return result.rowCount === 1;
  }

  async delete(blobKey) {
    return record(rows(await this.#database.query(
      "DELETE FROM objects.encrypted_blobs WHERE blob_key=$1 RETURNING *",
      [blobKey],
    ))[0]);
  }

  async list({ keyVersion = null, cursor = "", limit = 100 } = {}) {
    return rows(await this.#database.query(`
      SELECT * FROM objects.encrypted_blobs
      WHERE blob_key>$1 AND ($2::bigint IS NULL OR wrapping_key_version=$2)
      ORDER BY blob_key LIMIT $3`, [cursor, keyVersion, limit])).map(record);
  }

  async countByKeyVersion(keyVersion) {
    const value = rows(await this.#database.query(
      "SELECT count(*)::bigint AS count FROM objects.encrypted_blobs WHERE wrapping_key_version=$1",
      [keyVersion],
    ))[0];
    return Number(value.count);
  }
}
