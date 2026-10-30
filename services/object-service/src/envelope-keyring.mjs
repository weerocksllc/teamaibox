export class EnvelopeKeyringError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EnvelopeKeyringError";
    this.code = code;
  }
}

function validVersion(version) {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new EnvelopeKeyringError("invalid_key_version", "Wrapping-key version is invalid");
  }
  return version;
}

function requireKey(key) {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new EnvelopeKeyringError(
      "invalid_wrapping_key",
      "Wrapping key must contain exactly 32 bytes",
    );
  }
}

async function insideZeroizedCopy(key, callback) {
  requireKey(key);
  if (typeof callback !== "function") {
    throw new EnvelopeKeyringError("invalid_callback", "Key callback is required");
  }
  const copy = Buffer.from(key);
  try {
    return await callback(copy);
  } finally {
    copy.fill(0);
  }
}

export class ProtectedSecretEnvelopeKeyring {
  constructor({ secretStore, secretName = "object.envelope-kek", serviceContext }) {
    if (!secretStore?.metadata || !secretStore?.withSecretVersion) {
      throw new EnvelopeKeyringError("invalid_secret_store", "Protected secret store is incomplete");
    }
    if (!serviceContext?.permissions?.includes("secrets:read")
      || !serviceContext.permissions.includes("secrets:metadata")) {
      throw new EnvelopeKeyringError(
        "invalid_service_context",
        "Object-service secret context requires read and metadata permissions",
      );
    }
    this.secretStore = secretStore;
    this.secretName = secretName;
    this.serviceContext = Object.freeze({
      ...serviceContext,
      permissions: Object.freeze([...serviceContext.permissions]),
    });
  }

  async activeVersion() {
    const metadata = await this.secretStore.metadata(this.secretName, this.serviceContext);
    return validVersion(metadata.activeVersion);
  }

  async withKey(version, callback) {
    version = validVersion(version);
    return this.secretStore.withSecretVersion(
      this.secretName,
      version,
      this.serviceContext,
      async (key) => insideZeroizedCopy(key, callback),
    );
  }
}

export class MemoryVersionedEnvelopeKeyring {
  #versions = new Map();
  #activeVersion = null;

  constructor(initialKey = null) {
    if (initialKey) this.addVersion(1, initialKey, { active: true });
  }

  addVersion(version, key, { active = false } = {}) {
    version = validVersion(version);
    requireKey(key);
    if (this.#versions.has(version)) {
      throw new EnvelopeKeyringError("key_version_exists", "Wrapping-key version already exists");
    }
    this.#versions.set(version, Buffer.from(key));
    if (active || this.#activeVersion === null) this.#activeVersion = version;
  }

  activate(version) {
    version = validVersion(version);
    if (!this.#versions.has(version)) {
      throw new EnvelopeKeyringError("key_version_not_found", "Wrapping-key version was not found");
    }
    this.#activeVersion = version;
  }

  async activeVersion() {
    if (this.#activeVersion === null) {
      throw new EnvelopeKeyringError("no_active_key", "No active wrapping key is configured");
    }
    return this.#activeVersion;
  }

  async withKey(version, callback) {
    version = validVersion(version);
    const key = this.#versions.get(version);
    if (!key) {
      throw new EnvelopeKeyringError("key_version_not_found", "Wrapping-key version was not found");
    }
    return insideZeroizedCopy(key, callback);
  }

  close() {
    for (const key of this.#versions.values()) key.fill(0);
    this.#versions.clear();
    this.#activeVersion = null;
  }
}
