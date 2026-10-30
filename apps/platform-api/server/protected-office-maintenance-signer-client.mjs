import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isAbsolute } from "node:path";
import { checkServerIdentity as defaultCheckServerIdentity } from "node:tls";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import {
  encodeProtectedMaintenanceSignaturePayload,
  protectedMaintenanceSignaturePayload,
} from "../../../services/scheduler/src/production-protected-maintenance-signature-verifier.mjs";

const ENDPOINT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
const SERVER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ED25519_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const MAXIMUM_CONFIG_BYTES = 1 << 20;
const MAXIMUM_CREDENTIAL_BYTES = 1 << 20;
const MAXIMUM_REQUEST_BYTES = 16 << 10;
const MAXIMUM_RESPONSE_BYTES = 32 << 10;
const MAXIMUM_TTL_MILLISECONDS = 15 * 60_000;

function exactObject(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

async function boundedRegularFile(path, name, {
  maximum = MAXIMUM_CREDENTIAL_BYTES,
  privateMaterial = false,
} = {}) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")
      || path.split("/").includes("..")) {
    throw new TypeError(`${name} path is invalid`);
  }
  const resolved = await realpath(path);
  if (resolved !== path) throw new TypeError(`${name} cannot be a symbolic link`);
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > maximum
      || (privateMaterial && typeof stats.mode === "number" && (stats.mode & 0o077) !== 0)) {
    throw new TypeError(`${name} is not a protected bounded regular file`);
  }
  return readFile(path);
}

function exactUnsignedContext(value) {
  exactObject(value, [
    "transactionId", "workerIds", "allowedOperations", "maintenanceGeneration",
    "issuedAt", "expiresAt",
  ], "unsigned protected maintenance context");
  if (!Array.isArray(value.workerIds) || value.workerIds.length < 1 || value.workerIds.length > 64
      || !Array.isArray(value.allowedOperations)
      || value.allowedOperations.length !== 1
      || value.allowedOperations[0] !== "protected-set.maintenance") {
    throw new TypeError("unsigned protected maintenance context is invalid");
  }
  const payload = protectedMaintenanceSignaturePayload({
    context: value,
    operation: "protected-set.maintenance",
  });
  const canonical = {
    transactionId: payload.transactionId,
    workerIds: [...payload.workerIds],
    allowedOperations: [...payload.allowedOperations],
    maintenanceGeneration: payload.maintenanceGeneration,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  };
  if (value.transactionId !== canonical.transactionId
      || !sameJson(value.workerIds, canonical.workerIds)
      || !sameJson(value.allowedOperations, canonical.allowedOperations)
      || value.maintenanceGeneration !== canonical.maintenanceGeneration
      || value.issuedAt !== canonical.issuedAt || value.expiresAt !== canonical.expiresAt) {
    throw new TypeError("unsigned protected maintenance context is not canonical");
  }
  const issuedAt = new Date(canonical.issuedAt);
  const expiresAt = new Date(canonical.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAXIMUM_TTL_MILLISECONDS) {
    throw new TypeError("unsigned protected maintenance context window is invalid");
  }
  return Object.freeze({
    ...canonical,
    workerIds: Object.freeze(canonical.workerIds),
    allowedOperations: Object.freeze(canonical.allowedOperations),
  });
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameUnsignedContext(left, right) {
  return left.transactionId === right.transactionId
    && sameJson(left.workerIds, right.workerIds)
    && sameJson(left.allowedOperations, right.allowedOperations)
    && left.maintenanceGeneration === right.maintenanceGeneration
    && left.issuedAt === right.issuedAt
    && left.expiresAt === right.expiresAt;
}

function exactSignatureResponse(value, requested) {
  exactObject(value, ["schemaVersion", "status", "context"], "maintenance signer response");
  if (value.schemaVersion !== 1 || value.status !== "passed") {
    throw new TypeError("maintenance signer response is invalid");
  }
  const context = exactObject(value.context, [
    "transactionId", "workerIds", "allowedOperations", "maintenanceGeneration",
    "issuedAt", "expiresAt", "signature",
  ], "signed protected maintenance context");
  const unsigned = Object.fromEntries(Object.entries(context).filter(([key]) => key !== "signature"));
  if (!sameUnsignedContext(unsigned, requested)) {
    throw new TypeError("maintenance signer response context drifted");
  }
  const signature = exactObject(context.signature,
    ["algorithm", "keyId", "payloadDigest", "value"], "protected maintenance signature");
  const payload = encodeProtectedMaintenanceSignaturePayload({
    context: requested,
    operation: "protected-set.maintenance",
  });
  let expectedDigest;
  try { expectedDigest = `sha256:${createHash("sha256").update(payload).digest("hex")}`; }
  finally { payload.fill(0); }
  if (signature.algorithm !== "Ed25519" || !KEY_ID.test(signature.keyId ?? "")
      || !SHA256.test(signature.payloadDigest ?? "")
      || signature.payloadDigest !== expectedDigest
      || !ED25519_SIGNATURE.test(signature.value ?? "")) {
    throw new TypeError("protected maintenance signature is invalid");
  }
  return Object.freeze({
    algorithm: signature.algorithm,
    keyId: signature.keyId,
    payloadDigest: signature.payloadDigest,
    value: signature.value,
  });
}

function endpointFromConfig(config, endpointKey) {
  exactObject(config, ["schemaVersion", "tls", "endpoints", "candidates"],
    "maintenance runtime configuration");
  if (config.schemaVersion !== 1 || !Array.isArray(config.endpoints)
      || config.endpoints.length < 1 || config.endpoints.length > 32
      || !Array.isArray(config.candidates) || !ENDPOINT_KEY.test(endpointKey ?? "")) {
    throw new TypeError("maintenance signer endpoint selection is invalid");
  }
  exactObject(config.tls,
    ["caFile", "clientCertificateFile", "clientKeyFile"], "maintenance runtime TLS configuration");
  const keys = new Set();
  let selected = null;
  for (const raw of config.endpoints) {
    const endpoint = exactObject(raw, ["nodeKey", "host", "port", "serverName"],
      "maintenance runtime endpoint");
    if (!ENDPOINT_KEY.test(endpoint.nodeKey ?? "") || keys.has(endpoint.nodeKey)
        || !HOST.test(endpoint.host ?? "") || !SERVER_NAME.test(endpoint.serverName ?? "")
        || !Number.isSafeInteger(endpoint.port) || endpoint.port < 1024 || endpoint.port > 65535) {
      throw new TypeError("maintenance runtime endpoint is invalid or duplicated");
    }
    keys.add(endpoint.nodeKey);
    if (endpoint.nodeKey === endpointKey) selected = endpoint;
  }
  if (!selected) throw new TypeError("maintenance signer endpoint is unavailable");
  return Object.freeze({
    endpoint: Object.freeze({
      nodeKey: selected.nodeKey,
      host: selected.host,
      port: selected.port,
      serverName: selected.serverName,
    }),
    tls: Object.freeze({ ...config.tls }),
  });
}

/**
 * Production mTLS client for the maintenance-controller-owned Ed25519 key.
 * Platform sends only an exact, canonical, short-lived maintenance context and
 * receives only the detached signature object; private signing material never
 * enters the Platform process.
 */
export class ProtectedOfficeMaintenanceSignerClient {
  #endpoint;
  #tls;
  #request;
  #checkServerIdentity;
  #timeoutMilliseconds;
  #closed = false;

  constructor({
    endpoint,
    ca,
    certificate,
    privateKey,
    timeoutMilliseconds = 15_000,
    requestImplementation = httpsRequest,
    checkServerIdentityImplementation = defaultCheckServerIdentity,
  }) {
    if (!endpoint || !ENDPOINT_KEY.test(endpoint.nodeKey ?? "")
        || !HOST.test(endpoint.host ?? "") || !SERVER_NAME.test(endpoint.serverName ?? "")
        || !Number.isSafeInteger(endpoint.port) || endpoint.port < 1024 || endpoint.port > 65535
        || !Buffer.isBuffer(ca) || ca.byteLength < 1 || ca.byteLength > MAXIMUM_CREDENTIAL_BYTES
        || !Buffer.isBuffer(certificate) || certificate.byteLength < 1
        || certificate.byteLength > MAXIMUM_CREDENTIAL_BYTES
        || !Buffer.isBuffer(privateKey) || privateKey.byteLength < 1
        || privateKey.byteLength > MAXIMUM_CREDENTIAL_BYTES
        || !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1_000
        || timeoutMilliseconds > 60_000 || typeof requestImplementation !== "function"
        || typeof checkServerIdentityImplementation !== "function") {
      throw new TypeError("protected maintenance signer client configuration is invalid");
    }
    this.#endpoint = Object.freeze({ ...endpoint });
    this.#tls = {
      ca: Buffer.from(ca),
      certificate: Buffer.from(certificate),
      privateKey: Buffer.from(privateKey),
    };
    this.#request = requestImplementation;
    this.#checkServerIdentity = checkServerIdentityImplementation;
    this.#timeoutMilliseconds = timeoutMilliseconds;
  }

  async sign(context) {
    if (this.#closed) {
      throw new PlatformError("protected_maintenance_signer_closed",
        "Protected maintenance signer client is closed", { status: 503 });
    }
    const requested = exactUnsignedContext(context);
    const payload = Buffer.from(JSON.stringify(requested), "utf8");
    if (payload.byteLength > MAXIMUM_REQUEST_BYTES) {
      payload.fill(0);
      throw new TypeError("protected maintenance signer request is too large");
    }
    try {
      const response = await this.#post(payload);
      return exactSignatureResponse(response, requested);
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError("protected_maintenance_signer_protocol_invalid",
        "Protected maintenance signer returned an invalid response",
        { status: 502, cause: error });
    } finally {
      payload.fill(0);
    }
  }

  #post(payload) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (method, value) => {
        if (settled) return;
        settled = true;
        method(value);
      };
      const options = {
        host: this.#endpoint.host,
        port: this.#endpoint.port,
        servername: this.#endpoint.serverName,
        path: "/v1/protected-office/sign",
        method: "POST",
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        rejectUnauthorized: true,
        ca: this.#tls.ca,
        cert: this.#tls.certificate,
        key: this.#tls.privateKey,
        timeout: this.#timeoutMilliseconds,
        agent: false,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "content-length": String(payload.byteLength),
          "cache-control": "no-store",
        },
        checkServerIdentity: (hostname, certificate) => {
          if (hostname !== this.#endpoint.serverName) {
            return new Error("maintenance signer TLS server name drifted");
          }
          return this.#checkServerIdentity(hostname, certificate);
        },
      };
      let outgoing;
      try {
        outgoing = this.#request(options, (incoming) => {
          const chunks = [];
          let size = 0;
          incoming.on("data", (chunk) => {
            if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
            size += chunk.byteLength;
            if (size > MAXIMUM_RESPONSE_BYTES) {
              incoming.destroy(new Error("maintenance signer response is too large"));
              return;
            }
            chunks.push(chunk);
          });
          incoming.once("aborted", () => settle(reject,
            new Error("maintenance signer response was aborted")));
          incoming.once("error", (error) => settle(reject, error));
          incoming.once("end", () => {
            const bytes = Buffer.concat(chunks);
            try {
              const contentType = incoming.headers?.["content-type"];
              if (typeof contentType !== "string"
                  || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
                throw new Error("maintenance signer response content type is invalid");
              }
              let value;
              try { value = JSON.parse(bytes.toString("utf8")); }
              catch (error) { throw new Error("maintenance signer response is not JSON", { cause: error }); }
              if (incoming.statusCode !== 200) {
                throw new PlatformError("protected_maintenance_signer_rejected",
                  "Protected maintenance signer rejected the request", {
                    status: 502,
                    retryable: Number(incoming.statusCode) >= 500,
                  });
              }
              settle(resolve, value);
            } catch (error) { settle(reject, error); }
            finally { bytes.fill(0); }
          });
        });
      } catch (error) {
        settle(reject, new PlatformError("protected_maintenance_signer_unavailable",
          "Protected maintenance signer is unavailable", { status: 502, retryable: true, cause: error }));
        return;
      }
      outgoing.once("timeout", () => outgoing.destroy(new Error("maintenance signer request timed out")));
      outgoing.once("error", (error) => settle(reject,
        error instanceof PlatformError ? error : new PlatformError("protected_maintenance_signer_unavailable",
          "Protected maintenance signer is unavailable", { status: 502, retryable: true, cause: error })));
      outgoing.end(payload);
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#tls.ca.fill(0);
    this.#tls.certificate.fill(0);
    this.#tls.privateKey.fill(0);
  }
}

export async function createProtectedOfficeMaintenanceSignerClientFromEnvironment(
  environment = process.env,
  {
    endpointKey = environment.PLATFORM_PROTECTED_OFFICE_SET_MAINTENANCE_ENDPOINT_KEY,
    timeoutMilliseconds = 15_000,
    requestImplementation = httpsRequest,
    checkServerIdentityImplementation = defaultCheckServerIdentity,
  } = {},
) {
  const path = environment.PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE;
  const configBytes = await boundedRegularFile(path, "PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE", {
    maximum: MAXIMUM_CONFIG_BYTES,
  });
  let selection;
  try {
    let config;
    try { config = JSON.parse(configBytes.toString("utf8")); }
    catch { throw new TypeError("maintenance runtime configuration is invalid JSON"); }
    selection = endpointFromConfig(config, endpointKey);
  } finally {
    configBytes.fill(0);
  }
  const credentials = [];
  try {
    credentials.push(await boundedRegularFile(selection.tls.caFile, "maintenance controller CA"));
    credentials.push(await boundedRegularFile(selection.tls.clientCertificateFile,
      "maintenance controller client certificate"));
    credentials.push(await boundedRegularFile(selection.tls.clientKeyFile,
      "maintenance controller client private key", { privateMaterial: true }));
    return new ProtectedOfficeMaintenanceSignerClient({
      endpoint: selection.endpoint,
      ca: credentials[0],
      certificate: credentials[1],
      privateKey: credentials[2],
      timeoutMilliseconds,
      requestImplementation,
      checkServerIdentityImplementation,
    });
  } finally {
    for (const credential of credentials) credential.fill(0);
  }
}
