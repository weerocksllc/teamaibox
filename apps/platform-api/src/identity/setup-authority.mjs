import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

const MIN_TOKEN_BYTES = 32;
const MAX_TOKEN_BYTES = 128;

function digest(value) {
  return createHash("sha256").update(value).digest();
}

function isTokenByte(value) {
  return (value >= 0x41 && value <= 0x5a)
    || (value >= 0x61 && value <= 0x7a)
    || (value >= 0x30 && value <= 0x39)
    || value === 0x5f
    || value === 0x2d;
}

function tokenBytes(value) {
  const bytes = typeof value === "string"
    ? Buffer.from(value, "utf8")
    : Buffer.isBuffer(value) || value instanceof Uint8Array
      ? Buffer.from(value)
      : null;
  if (!bytes || bytes.length < MIN_TOKEN_BYTES || bytes.length > MAX_TOKEN_BYTES
    || !bytes.every(isTokenByte)) {
    bytes?.fill(0);
    throw new TypeError("owner setup token must be a high-entropy base64url value");
  }
  return bytes;
}

function trimmedTokenBytes(raw) {
  let start = 0;
  let end = raw.length;
  while (start < end && [0x09, 0x0a, 0x0d, 0x20].includes(raw[start])) start += 1;
  while (end > start && [0x09, 0x0a, 0x0d, 0x20].includes(raw[end - 1])) end -= 1;
  return raw.subarray(start, end);
}

export class OwnerSetupTokenAuthority {
  #tokenDigest;
  #closed = false;

  static async fromFile(path) {
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new TypeError("PLATFORM_API_SETUP_TOKEN_FILE must be an absolute path");
    }
    const raw = await readFile(path);
    try {
      return new OwnerSetupTokenAuthority(trimmedTokenBytes(raw));
    } finally {
      raw.fill(0);
    }
  }

  constructor(token) {
    const bytes = tokenBytes(token);
    try {
      this.#tokenDigest = digest(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  async verify(candidate) {
    if (this.#closed) return false;
    let bytes;
    try {
      bytes = tokenBytes(candidate);
    } catch {
      bytes = Buffer.alloc(MIN_TOKEN_BYTES);
    }
    const actual = digest(bytes);
    try {
      return typeof candidate === "string" && timingSafeEqual(actual, this.#tokenDigest);
    } finally {
      bytes.fill(0);
      actual.fill(0);
    }
  }

  close() {
    if (this.#closed) return;
    this.#tokenDigest.fill(0);
    this.#closed = true;
  }
}
