import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
} from "node:fs/promises";
import path from "node:path";
import util from "node:util";

const NAME = /^[a-z][a-z0-9._-]{2,127}$/;
const ALGORITHM = "aes-256-gcm";
const REDACTED = "[REDACTED]";

export class SecretError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SecretError";
    this.code = code;
  }
}

function safeName(value, field = "secret name") {
  if (typeof value !== "string" || !NAME.test(value)) {
    throw new SecretError("invalid_identifier", field + " is invalid");
  }
  return value;
}

function normalizedReaders(readers) {
  if (!Array.isArray(readers) || readers.length === 0) {
    throw new SecretError("invalid_scope", "at least one reader service is required");
  }
  return [...new Set(readers.map((reader) => safeName(reader, "reader service")))].sort();
}

function requirePermission(context, permission) {
  if (!context || !NAME.test(context.service ?? "")) {
    throw new SecretError("invalid_context", "a stable service context is required");
  }
  const permissions = new Set(context.permissions ?? []);
  if (!permissions.has(permission)) {
    throw new SecretError("access_denied", "missing permission: " + permission);
  }
}

function canonicalAad(record) {
  return Buffer.from(
    JSON.stringify({
      name: record.name,
      version: record.version,
      readers: record.readers,
      createdAt: record.createdAt,
      rotatedFrom: record.rotatedFrom,
    }),
    "utf8",
  );
}

function clone(value) {
  return value === null ? null : structuredClone(value);
}

function redactedMetadata(state) {
  if (!state) return null;
  return {
    name: state.name,
    revision: state.revision,
    activeVersion: state.activeVersion,
    versions: state.versions.map((record) => ({
      version: record.version,
      readers: [...record.readers],
      status: record.status,
      createdAt: record.createdAt,
      activatedAt: record.activatedAt,
      retiredAt: record.retiredAt,
      rotateAfter: record.rotateAfter,
      rotatedFrom: record.rotatedFrom,
      value: REDACTED,
    })),
  };
}

export class MemoryCiphertextBackend {
  #states = new Map();

  async load(name) {
    return clone(this.#states.get(name) ?? null);
  }

  async compareAndSwap(name, expectedRevision, nextState) {
    const current = this.#states.get(name) ?? null;
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== expectedRevision) return false;
    this.#states.set(name, clone(nextState));
    return true;
  }

  async listNames() {
    return [...this.#states.keys()].sort();
  }
}

export class FileCiphertextBackend {
  constructor(directory) {
    if (!path.isAbsolute(directory)) {
      throw new SecretError("invalid_backend", "secret ciphertext directory must be absolute");
    }
    this.directory = directory;
  }

  _recordPath(name) {
    safeName(name);
    const digest = createHash("sha256").update(name).digest("hex");
    return path.join(this.directory, digest + ".json");
  }

  async _ensureDirectory() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new SecretError("unsafe_backend", "secret ciphertext path must be a real directory");
    }
    if ((info.mode & 0o077) !== 0) {
      throw new SecretError("unsafe_backend", "secret ciphertext directory is group/world accessible");
    }
  }

  async load(name) {
    await this._ensureDirectory();
    const filename = this._recordPath(name);
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        throw new SecretError("unsafe_backend", "ciphertext record permissions are unsafe");
      }
      const value = JSON.parse(await readFile(filename, "utf8"));
      if (value?.name !== name) {
        throw new SecretError("corrupt_backend", "ciphertext record name does not match its key");
      }
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async compareAndSwap(name, expectedRevision, nextState) {
    await this._ensureDirectory();
    const current = await this.load(name);
    if ((current?.revision ?? 0) !== expectedRevision) return false;
    const filename = this._recordPath(name);
    const temporary = filename + "." + process.pid + "." + randomBytes(8).toString("hex") + ".tmp";
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(nextState), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filename);
    const directory = await open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return true;
  }

  async listNames() {
    throw new SecretError(
      "unsupported_operation",
      "filesystem secret names require a separate encrypted index",
    );
  }
}

export class EncryptedSecretStore {
  #masterKey;
  #backend;
  #audit;
  #closed = false;
  #locks = new Map();

  constructor({ masterKey, backend, audit = async () => {} }) {
    if (!(masterKey instanceof Uint8Array) || masterKey.byteLength !== 32) {
      throw new SecretError("invalid_master_key", "master key must contain exactly 32 bytes");
    }
    if (!backend?.load || !backend?.compareAndSwap) {
      throw new SecretError("invalid_backend", "ciphertext backend is incomplete");
    }
    if (typeof audit !== "function") {
      throw new SecretError("invalid_audit", "audit sink must be a function");
    }
    this.#masterKey = Buffer.from(masterKey);
    this.#backend = backend;
    this.#audit = audit;
  }

  [util.inspect.custom]() {
    return "EncryptedSecretStore { masterKey: [REDACTED] }";
  }

  toJSON() {
    return { type: "EncryptedSecretStore", masterKey: REDACTED };
  }

  close() {
    if (!this.#closed) {
      this.#masterKey.fill(0);
      this.#closed = true;
    }
  }

  _assertOpen() {
    if (this.#closed) throw new SecretError("store_closed", "secret store is closed");
  }

  async _withNameLock(name, operation) {
    const previous = this.#locks.get(name) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#locks.set(name, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(name) === queued) this.#locks.delete(name);
    }
  }

  async _emit(operation, context, name, version, success, reason = null) {
    await this.#audit({
      operation,
      service: context.service,
      name,
      version,
      success,
      reason,
      occurredAt: new Date().toISOString(),
    });
  }

  _encrypt(name, version, readers, value, rotatedFrom, rotateAfter) {
    if (!(value instanceof Uint8Array) || value.byteLength === 0) {
      throw new SecretError("invalid_secret", "secret value must be a non-empty byte array");
    }
    const now = new Date().toISOString();
    const record = {
      name,
      version,
      readers,
      status: "active",
      createdAt: now,
      activatedAt: now,
      retiredAt: null,
      rotateAfter: rotateAfter ?? null,
      rotatedFrom: rotatedFrom ?? null,
      encryption: {
        algorithm: ALGORITHM,
        nonce: null,
        ciphertext: null,
        tag: null,
      },
    };
    const nonce = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.#masterKey, nonce);
    cipher.setAAD(canonicalAad(record));
    const plaintext = Buffer.from(value);
    try {
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      record.encryption.nonce = nonce.toString("base64");
      record.encryption.ciphertext = ciphertext.toString("base64");
      record.encryption.tag = cipher.getAuthTag().toString("base64");
      return record;
    } finally {
      plaintext.fill(0);
    }
  }

  _decrypt(record) {
    if (record.encryption?.algorithm !== ALGORITHM) {
      throw new SecretError("unsupported_cipher", "secret record uses an unsupported cipher");
    }
    const nonce = Buffer.from(record.encryption.nonce, "base64");
    const ciphertext = Buffer.from(record.encryption.ciphertext, "base64");
    const tag = Buffer.from(record.encryption.tag, "base64");
    const decipher = createDecipheriv(ALGORITHM, this.#masterKey, nonce);
    decipher.setAAD(canonicalAad(record));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new SecretError("decryption_failed", "secret authentication failed");
    }
  }

  async putInitial(name, value, readers, context, { rotateAfter = null } = {}) {
    this._assertOpen();
    requirePermission(context, "secrets:write");
    name = safeName(name);
    readers = normalizedReaders(readers);
    try {
      const metadata = await this._withNameLock(name, async () => {
        const current = await this.#backend.load(name);
        if (current) throw new SecretError("secret_exists", "secret already exists");
        const record = this._encrypt(name, 1, readers, value, null, rotateAfter);
        const state = { name, revision: 1, activeVersion: 1, versions: [record] };
        if (!(await this.#backend.compareAndSwap(name, 0, state))) {
          throw new SecretError("concurrent_update", "secret changed concurrently");
        }
        return redactedMetadata(state);
      });
      await this._emit("secret.create", context, name, 1, true);
      return metadata;
    } catch (error) {
      await this._emit("secret.create", context, name, null, false, error.code ?? "failed");
      throw error;
    }
  }

  async rotate(name, value, readers, context, { rotateAfter = null } = {}) {
    this._assertOpen();
    requirePermission(context, "secrets:rotate");
    name = safeName(name);
    readers = normalizedReaders(readers);
    try {
      const metadata = await this._withNameLock(name, async () => {
        const current = await this.#backend.load(name);
        if (!current) throw new SecretError("secret_not_found", "secret does not exist");
        const oldVersion = current.activeVersion;
        const newVersion = Math.max(...current.versions.map((record) => record.version)) + 1;
        const retiredAt = new Date().toISOString();
        const versions = current.versions.map((record) =>
          record.version === oldVersion
            ? { ...record, status: "retired", retiredAt }
            : record,
        );
        versions.push(
          this._encrypt(name, newVersion, readers, value, oldVersion, rotateAfter),
        );
        const next = {
          name,
          revision: current.revision + 1,
          activeVersion: newVersion,
          versions,
        };
        if (!(await this.#backend.compareAndSwap(name, current.revision, next))) {
          throw new SecretError("concurrent_update", "secret changed concurrently");
        }
        return redactedMetadata(next);
      });
      await this._emit("secret.rotate", context, name, metadata.activeVersion, true);
      return metadata;
    } catch (error) {
      await this._emit("secret.rotate", context, name, null, false, error.code ?? "failed");
      throw error;
    }
  }

  async revoke(name, context) {
    this._assertOpen();
    requirePermission(context, "secrets:revoke");
    name = safeName(name);
    try {
      const metadata = await this._withNameLock(name, async () => {
        const current = await this.#backend.load(name);
        if (!current) throw new SecretError("secret_not_found", "secret does not exist");
        if (current.activeVersion === null) return redactedMetadata(current);
        const retiredAt = new Date().toISOString();
        const next = {
          name,
          revision: current.revision + 1,
          activeVersion: null,
          versions: current.versions.map((record) => record.version === current.activeVersion
            ? { ...record, status: "retired", retiredAt }
            : record),
        };
        if (!(await this.#backend.compareAndSwap(name, current.revision, next))) {
          throw new SecretError("concurrent_update", "secret changed concurrently");
        }
        return redactedMetadata(next);
      });
      await this._emit("secret.revoke", context, name, null, true);
      return metadata;
    } catch (error) {
      await this._emit("secret.revoke", context, name, null, false, error.code ?? "failed");
      throw error;
    }
  }

  async metadata(name, context) {
    this._assertOpen();
    requirePermission(context, "secrets:metadata");
    name = safeName(name);
    const state = await this.#backend.load(name);
    if (!state) {
      await this._emit("secret.metadata", context, name, null, false, "secret_not_found");
      throw new SecretError("secret_not_found", "secret does not exist");
    }
    await this._emit("secret.metadata", context, name, state.activeVersion, true);
    return redactedMetadata(state);
  }

  async withSecret(name, context, callback) {
    this._assertOpen();
    requirePermission(context, "secrets:read");
    if (typeof callback !== "function") {
      throw new SecretError("invalid_callback", "secret callback must be a function");
    }
    name = safeName(name);
    const state = await this.#backend.load(name);
    if (!state) {
      await this._emit("secret.read", context, name, null, false, "secret_not_found");
      throw new SecretError("secret_not_found", "secret does not exist");
    }
    const record = state.versions.find((candidate) => candidate.version === state.activeVersion);
    if (!record || record.status !== "active") {
      await this._emit("secret.read", context, name, state.activeVersion, false, "no_active_version");
      throw new SecretError("no_active_version", "secret has no active version");
    }
    if (!record.readers.includes(context.service)) {
      await this._emit("secret.read", context, name, record.version, false, "scope_denied");
      throw new SecretError("scope_denied", "service is not in the secret reader scope");
    }
    let plaintext;
    try {
      plaintext = this._decrypt(record);
    } catch (error) {
      await this._emit("secret.read", context, name, record.version, false, error.code ?? "failed");
      throw error;
    }
    await this._emit("secret.read", context, name, record.version, true);
    try {
      const result = await callback(plaintext);
      if (
        typeof result === "string"
        || result instanceof Uint8Array
        || result instanceof ArrayBuffer
        || ArrayBuffer.isView(result)
      ) {
        throw new SecretError("unsafe_return", "secret callback must not return text or byte material");
      }
      return result;
    } finally {
      plaintext.fill(0);
    }
  }

  async withSecretVersion(name, version, context, callback) {
    this._assertOpen();
    requirePermission(context, "secrets:read");
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new SecretError("invalid_version", "secret version must be a positive integer");
    }
    if (typeof callback !== "function") {
      throw new SecretError("invalid_callback", "secret callback must be a function");
    }
    name = safeName(name);
    const state = await this.#backend.load(name);
    if (!state) {
      await this._emit("secret.read_version", context, name, version, false, "secret_not_found");
      throw new SecretError("secret_not_found", "secret does not exist");
    }
    const record = state.versions.find((candidate) => candidate.version === version);
    if (!record || !["active", "retired"].includes(record.status)) {
      await this._emit("secret.read_version", context, name, version, false, "version_not_found");
      throw new SecretError("version_not_found", "secret version does not exist");
    }
    if (!record.readers.includes(context.service)) {
      await this._emit("secret.read_version", context, name, version, false, "scope_denied");
      throw new SecretError("scope_denied", "service is not in the secret reader scope");
    }
    let plaintext;
    try {
      plaintext = this._decrypt(record);
    } catch (error) {
      await this._emit("secret.read_version", context, name, version, false, error.code ?? "failed");
      throw error;
    }
    await this._emit("secret.read_version", context, name, version, true);
    try {
      const result = await callback(plaintext);
      if (
        typeof result === "string"
        || result instanceof Uint8Array
        || result instanceof ArrayBuffer
        || ArrayBuffer.isView(result)
      ) {
        throw new SecretError("unsafe_return", "secret callback must not return text or byte material");
      }
      return result;
    } finally {
      plaintext.fill(0);
    }
  }
}

export async function loadDevelopmentMasterKey(
  filename,
  { runtimeEnvironment, explicitlyAllowed },
) {
  if (runtimeEnvironment !== "development" || explicitlyAllowed !== true) {
    throw new SecretError(
      "development_bootstrap_denied",
      "file master-key bootstrap is allowed only in explicitly enabled development",
    );
  }
  if (!path.isAbsolute(filename)) {
    throw new SecretError("unsafe_bootstrap", "development key path must be absolute");
  }
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SecretError("unsafe_bootstrap", "development key must be a regular file");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new SecretError("unsafe_bootstrap", "development key must not be group/world accessible");
  }
  if (info.size !== 32) {
    throw new SecretError("invalid_master_key", "development master key must contain 32 raw bytes");
  }
  const value = await readFile(filename);
  const after = await stat(filename);
  if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size) {
    value.fill(0);
    throw new SecretError("unsafe_bootstrap", "development key changed while being read");
  }
  return value;
}
