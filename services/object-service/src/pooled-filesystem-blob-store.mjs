export class PooledFilesystemBlobStore {
  #repository;
  #storagePools;
  #dataPlane;
  #principal;
  #defaultPoolId;
  #pending = new Map();

  readonlyProtection = "raw-ciphertext-only";

  constructor({ repository, storagePoolService, dataPlane, principal, defaultPoolId }) {
    if (!repository?.allocations || !repository?.deleteAllocation || !storagePoolService?.reservePlacement
        || !storagePoolService?.commitPlacement || !storagePoolService?.abortPlacement || !dataPlane?.put
        || !dataPlane?.get || !dataPlane?.read || !dataPlane?.delete || !dataPlane?.inspect
        || typeof defaultPoolId !== "string" || !dataPlane.supports(defaultPoolId)) {
      throw new TypeError("pooled filesystem blob-store dependencies are incomplete");
    }
    this.#repository = repository;
    this.#storagePools = storagePoolService;
    this.#dataPlane = dataPlane;
    this.#principal = principal;
    this.#defaultPoolId = defaultPoolId;
  }

  async put(blobKey, content, { dataClass = "team-file", plaintextSize, plaintextSha256, copies = 1 } = {}) {
    if (!(content instanceof Uint8Array) || !Number.isSafeInteger(plaintextSize) || plaintextSize < 1
        || typeof plaintextSha256 !== "string" || !/^[a-f0-9]{64}$/.test(plaintextSha256)) {
      throw new TypeError("pooled encrypted-blob placement metadata is invalid");
    }
    const reservation = await this.#storagePools.reservePlacement({ principal: this.#principal, blobKey,
      dataClass, size: plaintextSize, sha256: plaintextSha256, copies,
      preferredPoolIds: [this.#defaultPoolId] });
    const written = [];
    try {
      for (const target of reservation.targets) {
        await this.#dataPlane.put({ poolId: target.poolId, blobKey, content });
        written.push(target.poolId);
      }
      this.#pending.set(blobKey, { reservation, written });
    } catch (error) {
      for (const poolId of written) await this.#dataPlane.delete({ poolId, blobKey }).catch(() => {});
      await this.#storagePools.abortPlacement({ principal: this.#principal, reservationId: reservation.reservationId }).catch(() => {});
      throw error;
    }
  }

  async commitPlacement(blobKey) {
    const pending = this.#pending.get(blobKey);
    if (!pending) throw new Error("encrypted blob has no pending storage placement");
    try {
      const verifiedCopies = [];
      for (const target of pending.reservation.targets) {
        const observed = await this.#dataPlane.inspect({ poolId: target.poolId, blobKey });
        if (!observed) throw new Error("stored ciphertext failed physical integrity verification");
        verifiedCopies.push({ poolId: target.poolId, size: observed.size, sha256: observed.sha256, verifiedAt: new Date() });
      }
      return await this.#storagePools.commitPlacement({ principal: this.#principal,
        reservationId: pending.reservation.reservationId, verifiedCopies });
    } catch (error) {
      for (const poolId of pending.written) await this.#dataPlane.delete({ poolId, blobKey }).catch(() => {});
      await this.#storagePools.abortPlacement({ principal: this.#principal,
        reservationId: pending.reservation.reservationId }).catch(() => {});
      throw error;
    } finally { this.#pending.delete(blobKey); }
  }

  async putStream(blobKey, chunks, { dataClass = 'team-file', plaintextSize, plaintextSha256, copies = 1 } = {}) {
    if (!chunks?.[Symbol.asyncIterator] || !Number.isSafeInteger(plaintextSize) || plaintextSize < 1
        || !/^[a-f0-9]{64}$/.test(plaintextSha256 ?? '') || typeof this.#dataPlane.putStream !== 'function') {
      throw new TypeError('pooled stream placement metadata is invalid');
    }
    const reservation = await this.#storagePools.reservePlacement({ principal:this.#principal, blobKey,
      dataClass, size:plaintextSize, sha256:plaintextSha256, copies, preferredPoolIds:[this.#defaultPoolId] });
    const written=[];
    try {
      for (const target of reservation.targets) {
        // The encrypted stream is consumed once. Replicas read ciphertext from
        // the first completed target; never buffer a complete media file.
        const source=written.length ? await this.#dataPlane.read({poolId:written[0],blobKey}) : chunks;
        if (!source) throw new Error('storage replica source missing');
        await this.#dataPlane.putStream({poolId:target.poolId,blobKey,chunks:source});
        written.push(target.poolId);
      }
      this.#pending.set(blobKey,{reservation,written});
    } catch(error) {
      for(const poolId of written) await this.#dataPlane.delete({poolId,blobKey}).catch(()=>{});
      await this.#storagePools.abortPlacement({principal:this.#principal,reservationId:reservation.reservationId}).catch(()=>{});
      throw error;
    }
  }

  async #locations(blobKey) {
    const allocations = await this.#repository.allocations({ blobKey });
    return allocations.length > 0 ? allocations.map((value) => value.poolId) : [this.#defaultPoolId];
  }

  async get(blobKey) {
    for (const poolId of await this.#locations(blobKey)) {
      const value = await this.#dataPlane.get({ poolId, blobKey });
      if (value) return value;
    }
    return null;
  }

  async read(blobKey) {
    for (const poolId of await this.#locations(blobKey)) {
      const value = await this.#dataPlane.read({ poolId, blobKey });
      if (value) return value;
    }
    return null;
  }

  async has(blobKey) {
    for (const poolId of await this.#locations(blobKey)) {
      if (await this.#dataPlane.has({ poolId, blobKey })) return true;
    }
    return false;
  }

  async delete(blobKey) {
    const pending = this.#pending.get(blobKey);
    if (pending) {
      for (const poolId of pending.written) await this.#dataPlane.delete({ poolId, blobKey }).catch(() => {});
      await this.#storagePools.abortPlacement({ principal: this.#principal,
        reservationId: pending.reservation.reservationId }).catch(() => {});
      this.#pending.delete(blobKey);
    }
    let deleted = false;
    const allocations = await this.#repository.allocations({ blobKey });
    if (allocations.length === 0) return this.#dataPlane.delete({ poolId: this.#defaultPoolId, blobKey });
    for (const allocation of allocations) {
      deleted = await this.#dataPlane.delete({ poolId: allocation.poolId, blobKey }) || deleted;
      await this.#repository.deleteAllocation(allocation.poolId, blobKey);
    }
    return deleted;
  }
}
