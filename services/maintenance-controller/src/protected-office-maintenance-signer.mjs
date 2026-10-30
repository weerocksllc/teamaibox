import { createHash, createPrivateKey, sign as signBytes } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  encodeProtectedMaintenanceSignaturePayload,
  protectedMaintenanceSignaturePayload,
} from "../../scheduler/src/production-protected-maintenance-signature-verifier.mjs";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;
const PRODUCTION_KEY = /^\/var\/lib\/teamaibox-maintenance\/[A-Za-z0-9][A-Za-z0-9._-]+\.key$/;
const MAXIMUM_PRIVATE_KEY_BYTES = 16 * 1024;

async function protectedPrivateKey(path, { allowTestRoot = false } = {}) {
  if (!isAbsolute(path ?? "") || (!allowTestRoot && !PRODUCTION_KEY.test(path))) {
    throw new TypeError("protected maintenance private-key path is invalid");
  }
  const resolved = await realpath(path);
  if (resolved !== path) throw new TypeError("protected maintenance private key cannot be a symbolic link");
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 64
      || stats.size > MAXIMUM_PRIVATE_KEY_BYTES
      || (typeof stats.mode === "number" && (stats.mode & 0o077) !== 0)) {
    throw new TypeError("protected maintenance private key is not a protected bounded regular file");
  }
  const bytes = await readFile(path);
  try {
    const key = createPrivateKey(bytes);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new TypeError("protected maintenance private key must be Ed25519");
    }
    return key;
  } finally {
    bytes.fill(0);
  }
}

function signedContext(payload, signature) {
  return Object.freeze({
    transactionId: payload.transactionId,
    workerIds: Object.freeze([...payload.workerIds]),
    allowedOperations: Object.freeze([...payload.allowedOperations]),
    maintenanceGeneration: payload.maintenanceGeneration,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    signature: Object.freeze(signature),
  });
}

/**
 * The maintenance controller owns the appliance Ed25519 private key. Platform
 * receives only a short-lived, exact-set signature and validates it against a
 * separately mounted public keyring before any protected Worker is stopped.
 */
export class ProtectedOfficeMaintenanceSigner {
  #privateKeyFile;
  #keyId;
  #allowTestRoot;

  constructor({
    privateKeyFile = "/var/lib/teamaibox-maintenance/protected-office.ed25519.key",
    keyId = "protected-office-main-v1",
    allowTestRoot = false,
  } = {}) {
    if (!isAbsolute(privateKeyFile ?? "") || (!allowTestRoot && !PRODUCTION_KEY.test(privateKeyFile))
        || !KEY_ID.test(keyId ?? "")) {
      throw new TypeError("protected maintenance signer configuration is invalid");
    }
    this.#privateKeyFile = privateKeyFile;
    this.#keyId = keyId;
    this.#allowTestRoot = allowTestRoot;
  }

  async sign(context) {
    if (!Array.isArray(context?.allowedOperations)
        || context.allowedOperations.length !== 1
        || context.allowedOperations[0] !== "protected-set.maintenance") {
      throw new TypeError("protected maintenance signature context is invalid");
    }
    const payload = protectedMaintenanceSignaturePayload({
      context,
      operation: "protected-set.maintenance",
    });
    const bytes = encodeProtectedMaintenanceSignaturePayload({
      context,
      operation: "protected-set.maintenance",
    });
    const key = await protectedPrivateKey(this.#privateKeyFile, {
      allowTestRoot: this.#allowTestRoot,
    });
    try {
      const value = signBytes(null, bytes, key).toString("base64url");
      if (!/^[A-Za-z0-9_-]{86}$/.test(value)) {
        throw new TypeError("protected maintenance signature is invalid");
      }
      return signedContext(payload, {
        algorithm: "Ed25519",
        keyId: this.#keyId,
        payloadDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        value,
      });
    } finally {
      bytes.fill(0);
    }
  }
}

export function createProtectedOfficeMaintenanceSigner(options) {
  return new ProtectedOfficeMaintenanceSigner(options);
}

export function protectedOfficeMaintenanceSignerFromEnvironment(environment = process.env) {
  const privateKeyFile = environment.MAINTENANCE_CONTROLLER_PROTECTED_OFFICE_PRIVATE_KEY_FILE;
  const keyId = environment.MAINTENANCE_CONTROLLER_PROTECTED_OFFICE_KEY_ID;
  if (!privateKeyFile && !keyId) return null;
  if (typeof privateKeyFile !== "string" || typeof keyId !== "string") {
    throw new TypeError("protected maintenance signer environment is incomplete");
  }
  return new ProtectedOfficeMaintenanceSigner({ privateKeyFile, keyId });
}
