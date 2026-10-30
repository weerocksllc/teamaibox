import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir, open, readFile, readdir, rename, rm, stat,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";


const BLOB_KEY = /^(?:objects\/[0-9a-f-]{36}|multipart\/[0-9a-f-]{36}\/[1-9][0-9]{0,4}\/[0-9a-f-]{36})$/i;


function safeRoot(value) {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new TypeError("filesystem blob root must be absolute");
  }
  return resolve(value);
}


function safeKey(value) {
  if (typeof value !== "string" || !BLOB_KEY.test(value)) {
    throw new TypeError("filesystem blob key is invalid");
  }
  return value;
}


export class FilesystemBlobStore {
  #root;

  readonlyProtection = "raw-ciphertext-only";

  constructor({ root }) {
    this.#root = safeRoot(root);
  }

  #path(blobKey) {
    const key = safeKey(blobKey);
    const path = resolve(this.#root, key);
    const boundary = relative(this.#root, path);
    if (!boundary || boundary === ".." || boundary.startsWith(`..${sep}`)) {
      throw new TypeError("filesystem blob path escapes its root");
    }
    return path;
  }

  async put(blobKey, content) {
    if (!(content instanceof Uint8Array) || content.byteLength < 1) {
      throw new TypeError("filesystem blob content must be bytes");
    }
    return this.putStream(blobKey, (async function* () { yield content; })());
  }

  async putStream(blobKey, chunks) {
    if (!chunks?.[Symbol.asyncIterator]) throw new TypeError("blob input must be a byte stream");
    const path = this.#path(blobKey);
    await mkdir(dirname(path), { recursive: true, mode: 0o750 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o640);
      let total = 0;
      for await (const chunk of chunks) {
        if (!(chunk instanceof Uint8Array)) throw new TypeError("blob input must contain bytes");
        total += chunk.byteLength;
        if (!Number.isSafeInteger(total)) throw new TypeError("blob size exceeds integer representation");
        await handle.writeFile(chunk);
      }
      if (total < 1) throw new TypeError("blob input must not be empty");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, path);
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async get(blobKey) {
    try {
      return await readFile(this.#path(blobKey));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async read(blobKey) {
    const path = this.#path(blobKey);
    try {
      await stat(path);
      return createReadStream(path, { highWaterMark: 1024 * 1024 });
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(blobKey) {
    try {
      await rm(this.#path(blobKey));
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async has(blobKey) {
    try {
      await stat(this.#path(blobKey));
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async list({ prefix = "", cursor = "", limit = 100 } = {}) {
    if ((prefix !== "" && !/^(?:objects|multipart)\//.test(prefix))
      || (cursor !== "" && !BLOB_KEY.test(cursor))
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError("filesystem raw blob listing is invalid");
    }
    const discovered = [];
    const walk = async (directory) => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) {
          const key = relative(this.#root, path).split(sep).join("/");
          if (BLOB_KEY.test(key)) discovered.push({ key, path });
        }
      }
    };
    await walk(this.#root);
    const selected = discovered
      .filter((item) => item.key.startsWith(prefix) && item.key > cursor)
      .sort((left, right) => left.key.localeCompare(right.key))
      .slice(0, limit);
    return Promise.all(selected.map(async (item) => ({
      blobKey: item.key,
      createdAt: (await stat(item.path)).birthtime.toISOString(),
    })));
  }
}
