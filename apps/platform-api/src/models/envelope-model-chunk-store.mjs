import { createHash } from "node:crypto";

const DIGEST = /^sha256:[a-f0-9]{64}$/;

export class ModelChunkStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ModelChunkStoreError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ModelChunkStoreError(code, message);
}

function validDigest(digest) {
  if (typeof digest !== "string" || !DIGEST.test(digest)) {
    fail("model_chunk_invalid", "model chunk digest must be SHA-256");
  }
  return digest;
}

function digestOf(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function blobKeyFor(digest) {
  return `models/chunks/sha256/${digest.slice(7)}`;
}

/**
 * Content-addressed model byte plane. The wrapped blob store must encrypt bytes
 * before they reach disk; a plaintext adapter is deliberately rejected.
 */
export class EnvelopeModelChunkStore {
  readonlyProtection = "content-addressed-envelope-encrypted";

  #blobStore;

  constructor({ blobStore }) {
    if (blobStore?.readonlyProtection !== "envelope-encrypted"
      || !blobStore?.put || !blobStore?.get || !blobStore?.delete || !blobStore?.has) {
      fail("protected_model_storage_required", "model chunks require the envelope-encrypted object byte plane");
    }
    this.#blobStore = blobStore;
  }

  keyFor(digest) {
    return blobKeyFor(validDigest(digest));
  }

  async putChunk({ digest, content }) {
    validDigest(digest);
    if (!(content instanceof Uint8Array) || content.byteLength < 1) {
      fail("model_chunk_invalid", "model chunk content must be non-empty bytes");
    }
    const body = Buffer.from(content);
    if (digestOf(body) !== digest) {
      body.fill(0);
      fail("model_chunk_checksum_failed", "model chunk does not match its SHA-256 descriptor");
    }
    const blobKey = blobKeyFor(digest);
    try {
      if (await this.#blobStore.has(blobKey)) {
        const existing = await this.readChunk({ digest, blobKey, sizeBytes: body.byteLength });
        existing.fill(0);
        return Object.freeze({ digest, blobKey, sizeBytes: body.byteLength, created: false });
      }
      try {
        await this.#blobStore.put(blobKey, body);
      } catch (error) {
        if (error?.code !== "blob_exists" && error?.code !== "concurrent_update") throw error;
        const existing = await this.readChunk({ digest, blobKey, sizeBytes: body.byteLength });
        existing.fill(0);
        return Object.freeze({ digest, blobKey, sizeBytes: body.byteLength, created: false });
      }
      return Object.freeze({ digest, blobKey, sizeBytes: body.byteLength, created: true });
    } finally {
      body.fill(0);
    }
  }

  async readChunk({ digest, blobKey = blobKeyFor(validDigest(digest)), sizeBytes }) {
    validDigest(digest);
    if (blobKey !== blobKeyFor(digest)) fail("model_chunk_reference_invalid", "model chunk key is not content addressed");
    const content = await this.#blobStore.get(blobKey);
    if (!content) fail("model_chunk_missing", "model chunk is missing from protected storage");
    if (content.byteLength !== sizeBytes || digestOf(content) !== digest) {
      content.fill(0);
      fail("model_chunk_authentication_failed", "model chunk failed size or checksum authentication");
    }
    return content;
  }

  async deleteChunk({ digest, blobKey = blobKeyFor(validDigest(digest)) }) {
    validDigest(digest);
    if (blobKey !== blobKeyFor(digest)) fail("model_chunk_reference_invalid", "model chunk key is not content addressed");
    return this.#blobStore.delete(blobKey);
  }
}
