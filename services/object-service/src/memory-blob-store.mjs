function bytes(value) {
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError("blob content must be bytes");
}

export class MemoryBlobStore {
  #blobs = new Map();

  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
  }

  readonlyProtection = "test-only-plaintext";

  async put(blobKey, content) {
    if (typeof blobKey !== "string" || !blobKey) throw new TypeError("blob key is required");
    this.#blobs.set(blobKey, { content: bytes(content), createdAt: this.clock() });
  }

  async get(blobKey) {
    const record = this.#blobs.get(blobKey);
    return record ? Buffer.from(record.content) : null;
  }

  async putStream(blobKey, chunks) {
    // Test double only. The filesystem implementation writes each chunk.
    const parts=[];
    try {
      for await(const chunk of chunks)parts.push(bytes(chunk));
      const content=Buffer.concat(parts);
      try{await this.put(blobKey,content);}finally{content.fill(0);}
    }finally{parts.forEach(part=>part.fill(0));}
  }

  async read(blobKey) {
    const record = this.#blobs.get(blobKey);
    if (!record) return null;
    const content = Buffer.from(record.content);
    return (async function* chunks() {
      try { yield content; } finally { content.fill(0); }
    }());
  }

  async delete(blobKey) {
    return this.#blobs.delete(blobKey);
  }

  async has(blobKey) {
    return this.#blobs.has(blobKey);
  }

  async list({ prefix = "", cursor = "", limit = 100 } = {}) {
    return [...this.#blobs.entries()]
      .filter(([blobKey]) => blobKey.startsWith(prefix) && blobKey > cursor)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, limit)
      .map(([blobKey, record]) => ({
        blobKey,
        createdAt: new Date(record.createdAt).toISOString(),
      }));
  }

  get size() {
    return this.#blobs.size;
  }
}
