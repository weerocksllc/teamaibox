import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const DATA_ALGORITHM = "aes-256-gcm";
const WRAP_ALGORITHM = "aes-256-gcm-keywrap";
const SCHEMA_VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/;

export class EnvelopeEncryptionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EnvelopeEncryptionError";
    this.code = code;
  }
}

function safeBlobKey(blobKey) {
  if (typeof blobKey !== "string" || blobKey.length < 1 || blobKey.length > 2048
    || blobKey.includes("\0")) {
    throw new EnvelopeEncryptionError("invalid_blob_key", "Encrypted blob key is invalid");
  }
  return blobKey;
}

function contentBytes(content) {
  if (!(content instanceof Uint8Array) || content.byteLength < 1) {
    throw new EnvelopeEncryptionError("invalid_blob_content", "Encrypted blob content must be bytes");
  }
  return Buffer.from(content);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function dataAad({ blobKey, plaintextSize, plaintextSha256 }) {
  return Buffer.from(JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    blobKey,
    algorithm: DATA_ALGORITHM,
    plaintextSize,
    plaintextSha256,
  }), "utf8");
}

function wrapAad(record, keyVersion) {
  return Buffer.from(JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    blobKey: record.blobKey,
    algorithm: WRAP_ALGORITHM,
    keyVersion,
    dataAlgorithm: record.dataEncryption.algorithm,
    dataNonce: record.dataEncryption.nonce,
    dataTag: record.dataEncryption.tag,
    plaintextSize: record.plaintextSize,
    plaintextSha256: record.plaintextSha256,
    ciphertextSize: record.ciphertextSize,
    ciphertextSha256: record.ciphertextSha256,
  }), "utf8");
}

function encoded(value) {
  return value.toString("base64");
}

function decoded(value, expectedLength) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new EnvelopeEncryptionError(
      "object_authentication_failed",
      "Encrypted object authentication failed",
    );
  }
  const result = Buffer.from(value, "base64");
  if (result.byteLength !== expectedLength || result.toString("base64") !== value) {
    result.fill(0);
    throw new EnvelopeEncryptionError(
      "object_authentication_failed",
      "Encrypted object authentication failed",
    );
  }
  return result;
}

function validMetadata(record, blobKey) {
  if (!record || record.schemaVersion !== SCHEMA_VERSION || record.blobKey !== blobKey
    || !Number.isSafeInteger(record.revision) || record.revision < 1
    || !Number.isSafeInteger(record.plaintextSize) || record.plaintextSize < 1
    || !Number.isSafeInteger(record.ciphertextSize) || record.ciphertextSize < 1
    || !SHA256.test(record.plaintextSha256 ?? "")
    || !SHA256.test(record.ciphertextSha256 ?? "")
    || record.dataEncryption?.algorithm !== DATA_ALGORITHM
    || record.keyEnvelope?.algorithm !== WRAP_ALGORITHM
    || !Number.isSafeInteger(record.keyEnvelope?.keyVersion)
    || record.keyEnvelope.keyVersion < 1) {
    throw new EnvelopeEncryptionError(
      "object_authentication_failed",
      "Encrypted object authentication failed",
    );
  }
  return record;
}

function authenticationFailure() {
  return new EnvelopeEncryptionError(
    "object_authentication_failed",
    "Encrypted object authentication failed",
  );
}

export class EnvelopeEncryptedBlobStore {
  #rawStore;
  #metadataRepository;
  #keyring;
  #clock;
  #dataKeyGenerator;
  #onKeyReleased;
  #locks = new Map();

  readonlyProtection = "envelope-encrypted";

  constructor({
    rawStore,
    metadataRepository,
    keyring,
    clock = () => new Date(),
    dataKeyGenerator = () => randomBytes(32),
    onKeyReleased = () => {},
  }) {
    if (!rawStore?.put || !rawStore?.get || !rawStore?.delete || !rawStore?.has) {
      throw new EnvelopeEncryptionError("invalid_raw_store", "Raw blob store is incomplete");
    }
    if (!metadataRepository?.load || !metadataRepository?.putIfAbsent
      || !metadataRepository?.compareAndSwap || !metadataRepository?.delete
      || !metadataRepository?.list || !metadataRepository?.countByKeyVersion) {
      throw new EnvelopeEncryptionError(
        "invalid_metadata_repository",
        "Envelope metadata repository is incomplete",
      );
    }
    if (!keyring?.activeVersion || !keyring?.withKey) {
      throw new EnvelopeEncryptionError("invalid_keyring", "Envelope keyring is incomplete");
    }
    if (typeof dataKeyGenerator !== "function" || typeof onKeyReleased !== "function") {
      throw new EnvelopeEncryptionError("invalid_key_boundary", "Key boundary hooks are invalid");
    }
    this.#rawStore = rawStore;
    this.#metadataRepository = metadataRepository;
    this.#keyring = keyring;
    this.#clock = clock;
    this.#dataKeyGenerator = dataKeyGenerator;
    this.#onKeyReleased = onKeyReleased;
  }

  async #withBlobLock(blobKey, operation) {
    const previous = this.#locks.get(blobKey) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.#locks.set(blobKey, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(blobKey) === queued) this.#locks.delete(blobKey);
    }
  }

  #releaseKey(key, kind) {
    if (key instanceof Uint8Array) key.fill(0);
    try {
      this.#onKeyReleased({
        kind,
        byteLength: key?.byteLength ?? 0,
        zeroized: key instanceof Uint8Array && key.every((byte) => byte === 0),
      });
    } catch {
      // Observability must never extend key lifetime or change encryption behavior.
    }
  }

  #newDataKey() {
    const generated = this.#dataKeyGenerator();
    if (!(generated instanceof Uint8Array) || generated.byteLength !== 32) {
      if (generated instanceof Uint8Array) generated.fill(0);
      throw new EnvelopeEncryptionError(
        "invalid_data_key",
        "Generated data key must contain exactly 32 bytes",
      );
    }
    if (Buffer.isBuffer(generated)) return generated;
    const copy = Buffer.from(generated);
    generated.fill(0);
    return copy;
  }

  #encryptContent(blobKey, body, dataKey) {
    const plaintextSha256 = sha256(body);
    const nonce = randomBytes(12);
    const cipher = createCipheriv(DATA_ALGORITHM, dataKey, nonce);
    cipher.setAAD(dataAad({
      blobKey,
      plaintextSize: body.byteLength,
      plaintextSha256,
    }));
    const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
    return {
      ciphertext,
      record: {
        schemaVersion: SCHEMA_VERSION,
        blobKey,
        revision: 1,
        plaintextSize: body.byteLength,
        plaintextSha256,
        ciphertextSize: ciphertext.byteLength,
        ciphertextSha256: sha256(ciphertext),
        dataEncryption: {
          algorithm: DATA_ALGORITHM,
          nonce: encoded(nonce),
          tag: encoded(cipher.getAuthTag()),
        },
      },
    };
  }

  async #wrapDataKey(record, dataKey, keyVersion) {
    return this.#keyring.withKey(keyVersion, async (wrappingKey) => {
      if (!(wrappingKey instanceof Uint8Array) || wrappingKey.byteLength !== 32) {
        throw new EnvelopeEncryptionError("invalid_wrapping_key", "Wrapping key is invalid");
      }
      const nonce = randomBytes(12);
      const cipher = createCipheriv(DATA_ALGORITHM, wrappingKey, nonce);
      cipher.setAAD(wrapAad(record, keyVersion));
      const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
      return {
        keyEnvelope: {
          algorithm: WRAP_ALGORITHM,
          keyVersion,
          nonce: encoded(nonce),
          ciphertext: encoded(ciphertext),
          tag: encoded(cipher.getAuthTag()),
        },
      };
    });
  }

  async #withUnwrappedDataKey(record, operation) {
    return this.#keyring.withKey(record.keyEnvelope.keyVersion, async (wrappingKey) => {
      let dataKey;
      let nonce;
      let wrapped;
      let tag;
      try {
        nonce = decoded(record.keyEnvelope.nonce, 12);
        wrapped = decoded(record.keyEnvelope.ciphertext, 32);
        tag = decoded(record.keyEnvelope.tag, 16);
        const decipher = createDecipheriv(DATA_ALGORITHM, wrappingKey, nonce);
        decipher.setAAD(wrapAad(record, record.keyEnvelope.keyVersion));
        decipher.setAuthTag(tag);
        dataKey = Buffer.concat([decipher.update(wrapped), decipher.final()]);
        if (dataKey.byteLength !== 32) throw authenticationFailure();
        return await operation(dataKey);
      } catch (error) {
        if (error instanceof EnvelopeEncryptionError) throw error;
        throw authenticationFailure();
      } finally {
        this.#releaseKey(dataKey, "data-key:unwrapped");
        nonce?.fill(0);
        wrapped?.fill(0);
        tag?.fill(0);
      }
    });
  }

  async put(blobKey, content, { dataClass = "team-file", copies = 1 } = {}) {
    blobKey = safeBlobKey(blobKey);
    const body = contentBytes(content);
    return this.#withBlobLock(blobKey, async () => {
      if (await this.#metadataRepository.load(blobKey) || await this.#rawStore.has(blobKey)) {
        body.fill(0);
        throw new EnvelopeEncryptionError("blob_exists", "Encrypted blob already exists");
      }
      let dataKey;
      let ciphertext;
      try {
        dataKey = this.#newDataKey();
        const encrypted = this.#encryptContent(blobKey, body, dataKey);
        ciphertext = encrypted.ciphertext;
        const keyVersion = await this.#keyring.activeVersion();
        const wrapped = await this.#wrapDataKey(encrypted.record, dataKey, keyVersion);
        const now = this.#clock().toISOString();
        const record = {
          ...encrypted.record,
          ...wrapped,
          createdAt: now,
          updatedAt: now,
        };
        await this.#rawStore.put(blobKey, ciphertext, {
          dataClass,
          copies,
          plaintextSize: encrypted.record.plaintextSize,
          plaintextSha256: encrypted.record.plaintextSha256,
        });
        if (!(await this.#metadataRepository.putIfAbsent(record))) {
          await this.#rawStore.delete(blobKey);
          throw new EnvelopeEncryptionError("concurrent_update", "Encrypted blob changed concurrently");
        }
        if (typeof this.#rawStore.commitPlacement === "function") {
          try { await this.#rawStore.commitPlacement(blobKey); }
          catch (error) {
            await this.#metadataRepository.delete(blobKey).catch(() => {});
            await this.#rawStore.delete(blobKey).catch(() => {});
            throw error;
          }
        }
      } finally {
        body.fill(0);
        this.#releaseKey(dataKey, "data-key:generated");
        ciphertext?.fill(0);
      }
    });
  }

  async get(blobKey) {
    return this.getRange(blobKey, null);
  }

  async putStream(blobKey, chunks, { plaintextSize, plaintextSha256, dataClass='team-file', copies=1 }={}) {
    blobKey=safeBlobKey(blobKey);
    if (!chunks?.[Symbol.asyncIterator] || !Number.isSafeInteger(plaintextSize) || plaintextSize<1
        || !SHA256.test(plaintextSha256??'') || typeof this.#rawStore.putStream!=='function') {
      throw new TypeError('encrypted stream requires size, digest and streaming storage');
    }
    return this.#withBlobLock(blobKey,async()=>{
      if(await this.#metadataRepository.load(blobKey)||await this.#rawStore.has(blobKey)) {
        throw new EnvelopeEncryptionError('blob_exists','Encrypted blob already exists');
      }
      const dataKey=this.#newDataKey(),nonce=randomBytes(12);
      const cipher=createCipheriv(DATA_ALGORITHM,dataKey,nonce);
      cipher.setAAD(dataAad({blobKey,plaintextSize,plaintextSha256}));
      const plainHash=createHash('sha256'),cipherHash=createHash('sha256');
      let size=0,ciphertextSize=0,complete=false,stored=false,metadataStored=false;
      const encrypted=(async function*(){
        for await(const chunk of chunks){
          if(!(chunk instanceof Uint8Array))throw new TypeError('encrypted input must contain bytes');
          size+=chunk.byteLength;
          if(size>plaintextSize)throw authenticationFailure();
          plainHash.update(chunk);
          const output=cipher.update(chunk);
          try{cipherHash.update(output);ciphertextSize+=output.byteLength;yield output;}
          finally{output.fill(0);}
        }
        if(size!==plaintextSize||plainHash.digest('hex')!==plaintextSha256)throw authenticationFailure();
        const tail=cipher.final();
        try{if(tail.length){cipherHash.update(tail);ciphertextSize+=tail.length;yield tail;}}
        finally{tail.fill(0);}
        complete=true;
      })();
      try {
        await this.#rawStore.putStream(blobKey,encrypted,{dataClass,copies,plaintextSize,plaintextSha256});stored=true;
        if(!complete)throw authenticationFailure();
        const now=this.#clock().toISOString();
        const record={schemaVersion:SCHEMA_VERSION,blobKey,revision:1,plaintextSize,plaintextSha256,
          ciphertextSize,ciphertextSha256:cipherHash.digest('hex'),
          dataEncryption:{algorithm:DATA_ALGORITHM,nonce:encoded(nonce),tag:encoded(cipher.getAuthTag())}};
        const wrapped=await this.#wrapDataKey(record,dataKey,await this.#keyring.activeVersion());
        if(!await this.#metadataRepository.putIfAbsent({...record,...wrapped,createdAt:now,updatedAt:now})) {
          throw new EnvelopeEncryptionError('concurrent_update','Encrypted blob changed concurrently');
        }
        metadataStored=true;
        if(typeof this.#rawStore.commitPlacement==='function')await this.#rawStore.commitPlacement(blobKey);
      }catch(error){
        if(metadataStored)await this.#metadataRepository.delete(blobKey).catch(()=>{});
        if(stored)await this.#rawStore.delete(blobKey).catch(()=>{});
        throw error;
      }finally{try{await encrypted.return();}finally{this.#releaseKey(dataKey,'data-key:generated');nonce.fill(0);}}
    });
  }

  async verify(blobKey,{size,sha256:expected}) {
    // Authenticate the entire ciphertext but retain just one byte. The on-disk
    // envelope format and key rotation remain compatible with existing files.
    const record=await this.#metadataRepository.load(safeBlobKey(blobKey));
    if(!record||record.plaintextSize!==size||record.plaintextSha256!==expected)throw authenticationFailure();
    const byte=await this.getRange(blobKey,{start:0,endInclusive:0});
    if(!byte)throw authenticationFailure();
    byte.fill(0);return {size,sha256:expected};
  }

  async read(blobKey) {
    const record=await this.metadata(blobKey);
    if(!record)return null;
    // GCM v1 authenticates the whole object. Verify in a bounded-memory pass
    // before releasing plaintext, then read sequentially (not N full-file
    // decryptions for N ranges). The second pass still checks integrity.
    await this.verify(blobKey,{size:record.plaintextSize,sha256:record.plaintextSha256});
    const store=this;
    return (async function*(){
      let key,nonce,tag;
      const source=await store.#rawStore.read(blobKey);
      if(!source)throw authenticationFailure();
      try{
        await store.#withUnwrappedDataKey(record,async(value)=>{key=Buffer.from(value);});
        nonce=decoded(record.dataEncryption.nonce,12);tag=decoded(record.dataEncryption.tag,16);
        const decipher=createDecipheriv(DATA_ALGORITHM,key,nonce);
        decipher.setAAD(dataAad(record));decipher.setAuthTag(tag);
        let size=0;const hash=createHash('sha256');
        for await(const encrypted of source){
          const output=decipher.update(encrypted);
          try{size+=output.length;hash.update(output);if(size>record.plaintextSize)throw authenticationFailure();yield output;}
          finally{output.fill(0);}
        }
        const tail=decipher.final();
        try{size+=tail.length;hash.update(tail);if(tail.length)yield tail;}
        finally{tail.fill(0);}
        if(size!==record.plaintextSize||hash.digest('hex')!==record.plaintextSha256)throw authenticationFailure();
      }finally{source.destroy?.();store.#releaseKey(key,'data-key:stream');nonce?.fill(0);tag?.fill(0);}
    })();
  }

  async getRange(blobKey, range = null) {
    blobKey = safeBlobKey(blobKey);
    const loaded = await this.#metadataRepository.load(blobKey);
    if (!loaded) return null;
    const record = validMetadata(loaded, blobKey);
    const start = range == null ? 0 : Number(range.start);
    const end = range == null || range.endInclusive === undefined
      ? record.plaintextSize - 1 : Number(range.endInclusive);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end < start || end >= record.plaintextSize) {
      throw new EnvelopeEncryptionError("range_not_satisfiable", "Encrypted blob byte range is not satisfiable");
    }
    const stream = typeof this.#rawStore.read === "function" ? await this.#rawStore.read(blobKey) : null;
    if (stream) {
      return this.#withUnwrappedDataKey(record, async (dataKey) => {
        let nonce;
        let tag;
        const selected = [];
        const ciphertextHash = createHash("sha256");
        const plaintextHash = createHash("sha256");
        let ciphertextSize = 0;
        let plaintextSize = 0;
        const collect = (plaintext) => {
          plaintextHash.update(plaintext);
          const chunkStart = plaintextSize;
          const chunkEnd = chunkStart + plaintext.byteLength - 1;
          if (chunkEnd >= start && chunkStart <= end) {
            const from = Math.max(0, start - chunkStart);
            const to = Math.min(plaintext.byteLength, end - chunkStart + 1);
            selected.push(Buffer.from(plaintext.subarray(from, to)));
          }
          plaintextSize += plaintext.byteLength;
          plaintext.fill(0);
        };
        try {
          nonce = decoded(record.dataEncryption.nonce, 12);
          tag = decoded(record.dataEncryption.tag, 16);
          const decipher = createDecipheriv(DATA_ALGORITHM, dataKey, nonce);
          decipher.setAAD(dataAad(record));
          decipher.setAuthTag(tag);
          for await (const value of stream) {
            const ciphertext = Buffer.from(value);
            ciphertextSize += ciphertext.byteLength;
            ciphertextHash.update(ciphertext);
            collect(decipher.update(ciphertext));
            ciphertext.fill(0);
          }
          collect(decipher.final());
          if (ciphertextSize !== record.ciphertextSize
              || ciphertextHash.digest("hex") !== record.ciphertextSha256
              || plaintextSize !== record.plaintextSize
              || plaintextHash.digest("hex") !== record.plaintextSha256) {
            throw authenticationFailure();
          }
          const content = Buffer.concat(selected);
          selected.forEach((value) => value.fill(0));
          if (content.byteLength !== end - start + 1) {
            content.fill(0);
            throw authenticationFailure();
          }
          return { content };
        } catch (error) {
          selected.forEach((value) => value.fill(0));
          if (error instanceof EnvelopeEncryptionError) throw error;
          throw authenticationFailure();
        } finally {
          nonce?.fill(0);
          tag?.fill(0);
        }
      }).then((result) => result.content);
    }
    const ciphertext = await this.#rawStore.get(blobKey);
    if (!ciphertext || ciphertext.byteLength !== record.ciphertextSize || sha256(ciphertext) !== record.ciphertextSha256) {
      ciphertext?.fill(0); throw authenticationFailure();
    }
    try {
      return await this.#withUnwrappedDataKey(record, async (dataKey) => {
        let nonce; let tag; let plaintext;
        try {
          nonce = decoded(record.dataEncryption.nonce, 12); tag = decoded(record.dataEncryption.tag, 16);
          const decipher = createDecipheriv(DATA_ALGORITHM, dataKey, nonce);
          decipher.setAAD(dataAad(record)); decipher.setAuthTag(tag);
          plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
          if (plaintext.byteLength !== record.plaintextSize || sha256(plaintext) !== record.plaintextSha256) throw authenticationFailure();
          return { content: Buffer.from(plaintext.subarray(start, end + 1)) };
        } catch (error) { if (error instanceof EnvelopeEncryptionError) throw error; throw authenticationFailure(); }
        finally { plaintext?.fill(0); nonce?.fill(0); tag?.fill(0); }
      }).then((result) => result.content);
    } finally { ciphertext.fill(0); }
  }

  async delete(blobKey) {
    blobKey = safeBlobKey(blobKey);
    return this.#withBlobLock(blobKey, async () => {
      const record = await this.#metadataRepository.load(blobKey);
      if (!record) return false;
      await this.#rawStore.delete(blobKey);
      await this.#metadataRepository.delete(blobKey);
      return true;
    });
  }

  async has(blobKey) {
    blobKey = safeBlobKey(blobKey);
    return Boolean(await this.#metadataRepository.load(blobKey)) && await this.#rawStore.has(blobKey);
  }

  async list({ prefix = "", cursor = "", limit = 100 } = {}) {
    if (typeof prefix !== "string" || typeof cursor !== "string"
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new EnvelopeEncryptionError("invalid_page", "Encrypted blob page is invalid");
    }
    const records = await this.#metadataRepository.list({ cursor, limit: 1000 });
    return records
      .filter((record) => record.blobKey.startsWith(prefix))
      .slice(0, limit)
      .map((record) => ({ blobKey: record.blobKey, createdAt: record.createdAt }));
  }

  async metadata(blobKey) {
    blobKey = safeBlobKey(blobKey);
    const record = await this.#metadataRepository.load(blobKey);
    return record ? validMetadata(record, blobKey) : null;
  }

  async rewrap(blobKey) {
    blobKey = safeBlobKey(blobKey);
    return this.#withBlobLock(blobKey, async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const loaded = await this.#metadataRepository.load(blobKey);
        if (!loaded) return null;
        const record = validMetadata(loaded, blobKey);
        const activeVersion = await this.#keyring.activeVersion();
        if (record.keyEnvelope.keyVersion === activeVersion) {
          return { blobKey, keyVersion: activeVersion, rewrapped: false };
        }
        const next = await this.#withUnwrappedDataKey(record, async (dataKey) => {
          const wrapped = await this.#wrapDataKey(record, dataKey, activeVersion);
          return {
            record: {
              ...record,
              ...wrapped,
              revision: record.revision + 1,
              updatedAt: this.#clock().toISOString(),
            },
          };
        });
        if (await this.#metadataRepository.compareAndSwap(blobKey, record.revision, next.record)) {
          return { blobKey, keyVersion: activeVersion, rewrapped: true };
        }
      }
      throw new EnvelopeEncryptionError("concurrent_update", "Encrypted blob changed concurrently");
    });
  }

  async rewrapAll({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new EnvelopeEncryptionError("invalid_limit", "Rewrap limit is invalid");
    }
    const activeVersion = await this.#keyring.activeVersion();
    let cursor = "";
    let scanned = 0;
    let rewrapped = 0;
    while (scanned < limit) {
      const page = await this.#metadataRepository.list({
        cursor,
        limit: Math.min(100, limit - scanned),
      });
      if (page.length === 0) break;
      for (const record of page) {
        scanned += 1;
        cursor = record.blobKey;
        if (record.keyEnvelope.keyVersion !== activeVersion) {
          const result = await this.rewrap(record.blobKey);
          if (result?.rewrapped) rewrapped += 1;
        }
      }
    }
    return { activeKeyVersion: activeVersion, scanned, rewrapped };
  }

  async keyVersionUsage(keyVersion) {
    if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
      throw new EnvelopeEncryptionError("invalid_key_version", "Wrapping-key version is invalid");
    }
    return this.#metadataRepository.countByKeyVersion(keyVersion);
  }
}
