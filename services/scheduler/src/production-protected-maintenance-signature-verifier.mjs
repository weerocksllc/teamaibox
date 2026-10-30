import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;
const OPERATION = /^[a-z][a-z0-9.-]{2,127}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const PRODUCTION_KEYRING = /^\/run\/teamaibox\/maintenance-keys\/[A-Za-z0-9._-]+\.json$/;
const MAXIMUM_KEYRING_BYTES = 256 * 1024;
const DEFAULT_MAXIMUM_TTL_MILLISECONDS = 15 * 60_000;

function exactObject(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function instant(value, name) {
  if (typeof value !== "string" || !value.endsWith("Z")) throw new TypeError(`${name} is invalid`);
  const result = new Date(value);
  if (!Number.isFinite(result.getTime()) || result.toISOString() !== value) throw new TypeError(`${name} is invalid`);
  return result;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("maintenance signature payload contains an unsafe number");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("maintenance signature payload is not canonical JSON");
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function boundedRegularFile(path) {
  if (!isAbsolute(path) || path.includes("\0") || path.split("/").includes("..")) {
    throw new TypeError("protected maintenance keyring path is invalid");
  }
  const resolved = await realpath(path);
  if (resolved !== path) throw new TypeError("protected maintenance keyring cannot be a symbolic link");
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 2 || stats.size > MAXIMUM_KEYRING_BYTES) {
    throw new TypeError("protected maintenance keyring is not a bounded regular file");
  }
  return readFile(path);
}

function parseKeyring(bytes) {
  let document;
  try { document = JSON.parse(bytes.toString("utf8")); }
  catch { throw new TypeError("protected maintenance keyring is invalid JSON"); }
  exactObject(document, ["schemaVersion", "keys"], "protected maintenance keyring");
  if (document.schemaVersion !== 1 || !Array.isArray(document.keys)
      || document.keys.length < 1 || document.keys.length > 32) {
    throw new TypeError("protected maintenance keyring is invalid");
  }
  const keys = new Map();
  for (const entry of document.keys) {
    exactObject(entry, ["keyId", "algorithm", "publicKeyPem", "publicKeyDigest", "status", "notBefore", "notAfter"],
      "protected maintenance key");
    if (!KEY_ID.test(entry.keyId ?? "") || entry.algorithm !== "Ed25519"
        || entry.status !== "active" || typeof entry.publicKeyPem !== "string"
        || entry.publicKeyPem.length < 80 || entry.publicKeyPem.length > 8192
        || !SHA256.test(entry.publicKeyDigest ?? "") || keys.has(entry.keyId)) {
      throw new TypeError("protected maintenance key is invalid");
    }
    const notBefore = instant(entry.notBefore, "protected maintenance key notBefore");
    const notAfter = instant(entry.notAfter, "protected maintenance key notAfter");
    if (notAfter <= notBefore) throw new TypeError("protected maintenance key validity is invalid");
    const key = createPublicKey(entry.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new TypeError("protected maintenance key must be Ed25519");
    const actualDigest = digest(key.export({ type: "spki", format: "der" }));
    if (actualDigest !== entry.publicKeyDigest) throw new TypeError("protected maintenance key digest drifted");
    keys.set(entry.keyId, Object.freeze({ key, notBefore, notAfter, publicKeyDigest: actualDigest }));
  }
  return keys;
}

function sortedUniqueStrings(value, name, pattern = null) {
  if (!Array.isArray(value) || value.length < 1 || new Set(value).size !== value.length
      || value.some((item) => typeof item !== "string" || (pattern && !pattern.test(item)))) {
    throw new TypeError(`${name} is invalid`);
  }
  return [...value].sort();
}

export function protectedMaintenanceSignaturePayload({ context, operation }) {
  if (!context || typeof context !== "object" || Array.isArray(context)
      || !UUID.test(context.transactionId ?? "") || !OPERATION.test(operation ?? "")
      || !Number.isSafeInteger(context.maintenanceGeneration) || context.maintenanceGeneration < 1) {
    throw new TypeError("protected maintenance signature context is invalid");
  }
  const issuedAt = instant(context.issuedAt, "protected maintenance issuedAt").toISOString();
  const expiresAt = instant(context.expiresAt, "protected maintenance expiresAt").toISOString();
  return Object.freeze({
    schemaVersion: 1,
    purpose: "teamaibox.protected-resident-maintenance.v1",
    transactionId: context.transactionId.toLowerCase(),
    operation,
    workerIds: Object.freeze(sortedUniqueStrings(context.workerIds, "protected maintenance workerIds", UUID)
      .map((value) => value.toLowerCase())),
    allowedOperations: Object.freeze(sortedUniqueStrings(context.allowedOperations,
      "protected maintenance allowedOperations", OPERATION)),
    maintenanceGeneration: context.maintenanceGeneration,
    issuedAt,
    expiresAt,
  });
}

export function encodeProtectedMaintenanceSignaturePayload(input) {
  return Buffer.from(canonicalJson(protectedMaintenanceSignaturePayload(input)), "utf8");
}

export class ProductionProtectedMaintenanceSignatureVerifier {
  #keyringFile;
  #allowTestRoot;
  #maximumTtlMilliseconds;

  constructor({
    trustedKeyringFile = "/run/teamaibox/maintenance-keys/protected-office.ed25519.json",
    maximumTtlMilliseconds = DEFAULT_MAXIMUM_TTL_MILLISECONDS,
    allowTestRoot = false,
  } = {}) {
    if ((!allowTestRoot && !PRODUCTION_KEYRING.test(trustedKeyringFile ?? ""))
        || !isAbsolute(trustedKeyringFile ?? "")
        || !Number.isSafeInteger(maximumTtlMilliseconds) || maximumTtlMilliseconds < 1
        || maximumTtlMilliseconds > DEFAULT_MAXIMUM_TTL_MILLISECONDS) {
      throw new TypeError("protected maintenance verifier configuration is invalid");
    }
    this.#keyringFile = trustedKeyringFile;
    this.#allowTestRoot = allowTestRoot;
    this.#maximumTtlMilliseconds = maximumTtlMilliseconds;
  }

  async verify({ context, operation, workers, now = new Date() }) {
    const denied = (payload = null) => Object.freeze({
      authorized: false,
      signatureVerified: false,
      transactionId: payload?.transactionId ?? context?.transactionId ?? null,
      operation,
      maintenanceGeneration: payload?.maintenanceGeneration ?? context?.maintenanceGeneration ?? null,
      workerIds: Object.freeze(payload?.workerIds ?? []),
    });
    let payload;
    let signature;
    let at;
    try {
      payload = protectedMaintenanceSignaturePayload({ context, operation });
      exactObject(context.signature, ["algorithm", "keyId", "payloadDigest", "value"],
        "protected maintenance signature");
      signature = context.signature;
      at = now instanceof Date ? new Date(now) : new Date(now);
      if (!Number.isFinite(at.getTime()) || signature.algorithm !== "Ed25519"
          || !KEY_ID.test(signature.keyId ?? "") || !SHA256.test(signature.payloadDigest ?? "")
          || !SIGNATURE.test(signature.value ?? "")
          || operation !== "protected-set.maintenance"
          || payload.allowedOperations.length !== 1 || payload.allowedOperations[0] !== operation
          || payload.workerIds.length !== workers?.length
          || workers.some((worker) => !UUID.test(worker?.workerId ?? "")
            || worker.placementClass !== "protected-resident"
            || worker.maintenanceGeneration !== payload.maintenanceGeneration)
          || workers.map((worker) => worker.workerId.toLowerCase()).sort()
            .some((workerId, index) => workerId !== payload.workerIds[index])) return denied(payload);
    } catch {
      return denied(payload);
    }
    const issuedAt = new Date(payload.issuedAt);
    const expiresAt = new Date(payload.expiresAt);
    if (issuedAt > new Date(at.getTime() + 1_000) || expiresAt <= at || expiresAt <= issuedAt
        || expiresAt - issuedAt > this.#maximumTtlMilliseconds) return denied(payload);
    const bytes = Buffer.from(canonicalJson(payload), "utf8");
    if (digest(bytes) !== signature.payloadDigest) return denied(payload);
    const keyringBytes = await boundedRegularFile(this.#keyringFile);
    let keys;
    try { keys = parseKeyring(keyringBytes); }
    finally { keyringBytes.fill(0); }
    const trusted = keys.get(signature.keyId);
    if (!trusted || issuedAt < trusted.notBefore || expiresAt > trusted.notAfter) return denied(payload);
    const supplied = Buffer.from(signature.value, "base64url");
    if (supplied.byteLength !== 64 || supplied.toString("base64url") !== signature.value
        || !verifySignature(null, bytes, trusted.key, supplied)) return denied(payload);
    return Object.freeze({
      authorized: true,
      signatureVerified: true,
      transactionId: payload.transactionId,
      operation,
      maintenanceGeneration: payload.maintenanceGeneration,
      workerIds: payload.workerIds,
      signature: Object.freeze({
        verified: true,
        algorithm: "Ed25519",
        keyId: signature.keyId,
        payloadDigest: signature.payloadDigest,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt,
        workerIds: payload.workerIds,
        publicKeyDigest: trusted.publicKeyDigest,
      }),
    });
  }

  authorize(input) { return this.verify(input); }
}

export function createProductionProtectedMaintenanceAuthorizer(options) {
  const verifier = new ProductionProtectedMaintenanceSignatureVerifier(options);
  return verifier.verify.bind(verifier);
}

