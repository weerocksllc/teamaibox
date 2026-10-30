import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";

import { FilesystemBlobStore } from "./filesystem-blob-store.mjs";

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

export class FilesystemStoragePoolDataPlane {
  #database;
  #stores;
  #roots;

  constructor({ database, pools }) {
    if (!database?.query || !Array.isArray(pools) || pools.length < 1) {
      throw new TypeError("filesystem storage-pool data plane configuration is incomplete");
    }
    this.#database = database;
    this.#stores = new Map();
    this.#roots = new Map();
    for (const pool of pools) {
      if (typeof pool?.poolId !== "string" || !/^[a-z][a-z0-9_.-]{2,127}$/.test(pool.poolId)
          || typeof pool?.root !== "string" || !pool.root.startsWith("/") || this.#stores.has(pool.poolId)) {
        throw new TypeError("filesystem storage-pool definition is invalid");
      }
      this.#stores.set(pool.poolId, new FilesystemBlobStore({ root: pool.root }));
      this.#roots.set(pool.poolId, pool.root);
    }
  }

  configuredPoolIds() { return Object.freeze([...this.#stores.keys()].sort()); }
  supports(poolId) { return this.#stores.has(poolId); }

  #store(poolId) {
    const value = this.#stores.get(poolId);
    if (!value) throw new TypeError(`storage pool ${poolId} has no mounted data plane`);
    return value;
  }

  put({ poolId, blobKey, content }) { return this.#store(poolId).put(blobKey, content); }
  putStream({ poolId, blobKey, chunks }) { return this.#store(poolId).putStream(blobKey, chunks); }
  get({ poolId, blobKey }) { return this.#store(poolId).get(blobKey); }
  read({ poolId, blobKey }) { return this.#store(poolId).read(blobKey); }
  has({ poolId, blobKey }) { return this.#store(poolId).has(blobKey); }
  delete({ poolId, blobKey }) { return this.#store(poolId).delete(blobKey); }

  async copy({ sourcePoolId, targetPoolId, blobKey }) {
    const chunks = await this.read({ poolId: sourcePoolId, blobKey });
    if (!chunks) throw new Error("storage migration source ciphertext is missing");
    await this.putStream({ poolId: targetPoolId, blobKey, chunks });
  }

  async inspect({ poolId, blobKey }) {
    const stream = await this.read({ poolId, blobKey });
    if (!stream) return null;
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of stream) { size += chunk.byteLength; hash.update(chunk); }
    const digest = hash.digest('hex');
      const row = (await this.#database.query(`SELECT plaintext_size,encode(plaintext_sha256,'hex') AS plaintext_sha256,
        ciphertext_size,encode(ciphertext_sha256,'hex') AS ciphertext_sha256 FROM objects.encrypted_blobs WHERE blob_key=$1`, [blobKey])).rows?.[0];
      if (!row || Number(row.ciphertext_size) !== size || row.ciphertext_sha256 !== digest) return null;
      return Object.freeze({ size: Number(row.plaintext_size), sha256: row.plaintext_sha256,
        ciphertextSize: size, ciphertextSha256: row.ciphertext_sha256 });
  }

  async capacity(poolId) {
    const facts = await statfs(this.#roots.get(poolId));
    const totalBytes = Number(facts.blocks) * Number(facts.bsize);
    const availableBytes = Number(facts.bavail) * Number(facts.bsize);
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || !Number.isSafeInteger(availableBytes) || availableBytes < 0) {
      throw new Error("storage pool filesystem capacity is outside supported integer range");
    }
    return Object.freeze({ totalBytes, availableBytes });
  }
}
