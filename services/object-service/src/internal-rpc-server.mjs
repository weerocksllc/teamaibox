import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { createPostgresDatabaseFromEnvironment } from "../../../packages/persistence/src/postgres-database.mjs";
import { ArtifactProvenanceService } from "./artifact-provenance-service.mjs";
import { EnvelopeEncryptedBlobStore } from "./envelope-encrypted-blob-store.mjs";
import { MemoryVersionedEnvelopeKeyring } from "./envelope-keyring.mjs";
import { FilesystemBlobStore } from "./filesystem-blob-store.mjs";
import { FilesystemStoragePoolDataPlane } from "./filesystem-storage-pool-data-plane.mjs";
import { ProtectedObjectService } from "./object-service.mjs";
import { PooledFilesystemBlobStore } from "./pooled-filesystem-blob-store.mjs";
import { PostgresArtifactProvenanceRepository } from "./postgres-artifact-provenance-repository.mjs";
import { PostgresEnvelopeMetadataRepository } from "./postgres-envelope-metadata-repository.mjs";
import { PostgresObjectGrantRepository } from "./postgres-object-grant-repository.mjs";
import { PostgresObjectRepository } from "./postgres-object-repository.mjs";
import { PostgresStoragePoolRepository } from "./postgres-storage-pool-repository.mjs";
import { StorageAdministrationRuntime } from "./storage-administration-runtime.mjs";
import { StoragePoolService } from "./storage-pool-service.mjs";
import { reserveBufferedMedia } from "./buffered-media-budget.mjs";


const TOKEN = /^[A-Za-z0-9_-]{43,171}$/;
const DIRECT_METHODS = new Set([
  "upload", "download", "downloadStream", "head", "delete", "list", "beginMultipart", "uploadPart", "listUploadParts", "completeMultipart",
  "abortMultipart", "createScopedReference", "revokeScopedReference", "downloadByReferenceId", "downloadStreamByReferenceId", "headByReferenceId",
]);
const SPECIAL_METHODS = new Set([
  "handoff.resolve", "handoff.head", "handoff.download", "handoff.downloadStream", "handoff.storeOutput", "handoff.issue", "handoff.revoke",
  "handoff.beginOutput", "handoff.storeOutputPart", "handoff.completeOutput", "handoff.abortOutput",
  "messaging.resolveAttachment", "messaging.issueAttachmentDownload", "scoped.head", "scoped.download",
  "storage.list", "storage.find", "storage.create", "storage.replaceDataClasses", "storage.transition",
]);
const STORAGE_OBSERVATION_INTERVAL_MILLISECONDS = 60_000;


function requireAbsolute(value, name) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new TypeError(`${name} must be absolute`);
  return value;
}


async function secret(path, name) {
  const raw = await readFile(requireAbsolute(path, name));
  try {
    const encoded = raw.toString("utf8").trim();
    if (!TOKEN.test(encoded)) throw new TypeError(`${name} is invalid`);
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.byteLength < 32 || bytes.byteLength > 128 || bytes.toString("base64url") !== encoded) {
      bytes.fill(0);
      throw new TypeError(`${name} is invalid`);
    }
    return { encoded, bytes };
  } finally { raw.fill(0); }
}


function authorized(request, expected) {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  const valid = supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
  supplied.fill(0);
  return valid;
}


export async function readObjectRpcBody(request, reserve = reserveBufferedMedia) {
  const chunks = [];
  const releases = [];
  let size = 0;
  let joined;
  const release = () => { for (const done of releases.splice(0)) done(); };
  try {
    for await (const chunk of request) {
      if (!chunk.byteLength) continue;
      releases.push(reserve(chunk.byteLength));
      size += chunk.byteLength;
      chunks.push(Buffer.from(chunk));
    }
    joined = Buffer.concat(chunks, size);
    let value;
    try { value = JSON.parse(joined.toString("utf8")); } catch {
      throw new PlatformError("object_rpc_invalid", "Object RPC request is invalid", { status: 400 });
    }
    // Hold admission through decoding and execution, not just network reads.
    return { value, release };
  } catch (error) {
    release();
    throw error;
  } finally {
    joined?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}


function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    if (value.__type === "bytes" && typeof value.base64 === "string") return Buffer.from(value.base64, "base64");
    if (Object.hasOwn(value, "__proto__") || Object.hasOwn(value, "constructor") || Object.hasOwn(value, "prototype")) {
      throw new PlatformError("object_rpc_invalid", "Object RPC input is unsafe", { status: 400 });
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  }
  return value;
}


function encode(value) {
  if (value instanceof Uint8Array) return { __type: "bytes", base64: Buffer.from(value).toString("base64") };
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  return value;
}


function reply(response, status, value) {
  const payload = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": payload.byteLength,
    "content-type": "application/json; charset=utf-8",
  });
  response.end(payload);
}


export function createObjectRpcServer({ token, objectService, provenanceService, storageAdministration = null }) {
  if (typeof token !== "string" || !TOKEN.test(token)) throw new TypeError("object RPC server token is invalid");
  const expectedToken = Buffer.from(token, "utf8");
  const handoff = objectService.createObjectHandoffGateway();
  const attachmentVerifier = provenanceService.createMessagingAttachmentVerifier();
  const server = createServer(async (request, response) => {
    let admitted;
    try {
      const url = new URL(request.url, "http://object-service.invalid");
      if (request.method === "GET" && url.pathname === "/health/ready") {
        reply(response, 200, { status: "ready", service: "object-service", encryption: "aes-256-gcm-envelope" });
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/internal/v1/call") {
        throw new PlatformError("not_found", "Object RPC endpoint was not found", { status: 404 });
      }
      if (!authorized(request, expectedToken)) throw new PlatformError("object_rpc_unauthorized", "Object RPC authorization failed", { status: 401 });
      admitted = await readObjectRpcBody(request);
      const requestBody = admitted.value;
      const method = requestBody?.method;
      if (typeof method !== "string" || (!DIRECT_METHODS.has(method) && !SPECIAL_METHODS.has(method))) {
        throw new PlatformError("object_rpc_method_denied", "Object RPC method is not allowed", { status: 403 });
      }
      const input = decode(requestBody.input);
      let result;
      if (DIRECT_METHODS.has(method)) result = await objectService[method](input);
      else if (method === "scoped.head") result = await objectService.headWithScopedReference(input);
      else if (method === "scoped.download") result = await objectService.downloadWithScopedReference(input);
      else if (method.startsWith("storage.")) {
        if (!storageAdministration) throw new PlatformError("storage_data_plane_unavailable", "Storage pool data plane is not configured", { status: 503, retryable: true });
        result = await storageAdministration[method.slice("storage.".length)](input);
      } else if (method === "messaging.resolveAttachment") result = await attachmentVerifier.resolveAttachment(input);
      else if (method === "messaging.issueAttachmentDownload") result = await attachmentVerifier.issueDownloadReference(input);
      else result = await handoff[method.slice("handoff.".length)](input);
      if(method==='downloadStream'||method==='downloadStreamByReferenceId'||method==='handoff.downloadStream') {
        response.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store',
          'content-length':String(result.metadata.size),
          'x-teamaibox-object-metadata':Buffer.from(JSON.stringify(result.metadata)).toString('base64url')});
        try{
          for await(const chunk of result.chunks){
            if(response.destroyed)throw Error('object_stream_closed');
            // Wait for the write callback before the producer wipes its buffer.
            await new Promise((resolve,reject)=>response.write(chunk,error=>error?reject(error):resolve()));
          }
          response.end();
        }catch(error){response.destroy(error);}finally{await result.chunks.return?.();}
        return;
      }
      reply(response, 200, { ok: true, result: encode(result) });
    } catch (error) {
      if(response.headersSent){response.destroy();return;}
      const status = error instanceof PlatformError ? error.status : 500;
      reply(response, status, { ok: false, error: {
        code: error instanceof PlatformError ? error.code : "object_service_internal_error",
        message: error instanceof PlatformError ? error.message : "Protected object service failed",
        status, retryable: error instanceof PlatformError && error.retryable === true,
      } });
    } finally { admitted?.release(); }
  });
  server.once("close", () => expectedToken.fill(0));
  return server;
}


export async function startStorageObservationLoop({
  storageAdministration,
  context,
  intervalMilliseconds = STORAGE_OBSERVATION_INTERVAL_MILLISECONDS,
  setIntervalImplementation = setInterval,
  clearIntervalImplementation = clearInterval,
  onError = (error) => process.stderr.write(`storage observation refresh failed: ${typeof error?.code === "string" ? error.code : "storage_observation_failed"}\n`),
}) {
  if (typeof storageAdministration?.refresh !== "function"
      || typeof context?.identityId !== "string" || !Array.isArray(context?.permissions)
      || !context.permissions.includes("storage:manage")
      || !Number.isSafeInteger(intervalMilliseconds) || intervalMilliseconds < 1_000
      || typeof setIntervalImplementation !== "function" || typeof clearIntervalImplementation !== "function"
      || typeof onError !== "function") {
    throw new TypeError("storage observation loop configuration is invalid");
  }
  let running = false;
  let stopped = false;
  const refresh = async () => {
    if (running || stopped) return;
    running = true;
    try { await storageAdministration.refresh({ context }); }
    catch (error) { onError(error); }
    finally { running = false; }
  };
  await refresh();
  const timer = setIntervalImplementation(() => { void refresh(); }, intervalMilliseconds);
  timer?.unref?.();
  return Object.freeze({
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalImplementation(timer);
    },
  });
}

async function storageConfiguration(path) {
  if (!path) return null;
  const value = JSON.parse(await readFile(requireAbsolute(path, "TEAMAIBOX_OBJECT_STORAGE_CONFIG_FILE"), "utf8"));
  if (value?.schemaVersion !== 1 || typeof value.defaultPoolId !== "string" || !Array.isArray(value.pools)
      || value.pools.length < 1 || !value.pools.some((pool) => pool?.poolId === value.defaultPoolId)) {
    throw new TypeError("object storage-pool configuration is invalid");
  }
  for (const pool of value.pools) {
    if (typeof pool?.poolId !== "string" || typeof pool?.root !== "string" || !isAbsolute(pool.root)
        || !["local-block", "local-filesystem"].includes(pool.backendKind)
        || typeof pool.nodeId !== "string" || pool.luks2Verified !== true) {
      throw new TypeError("object storage-pool configuration is invalid");
    }
  }
  return Object.freeze({ defaultPoolId: value.defaultPoolId,
    pools: Object.freeze(value.pools.map((pool) => Object.freeze({ ...pool }))) });
}


export async function startObjectRpcService(environment = process.env) {
  const rpc = await secret(environment.TEAMAIBOX_OBJECT_RPC_TOKEN_FILE, "TEAMAIBOX_OBJECT_RPC_TOKEN_FILE");
  const reference = await secret(environment.TEAMAIBOX_OBJECT_REFERENCE_KEY_FILE, "TEAMAIBOX_OBJECT_REFERENCE_KEY_FILE");
  const kek = await secret(environment.TEAMAIBOX_OBJECT_KEK_FILE, "TEAMAIBOX_OBJECT_KEK_FILE");
  if (kek.bytes.byteLength !== 32) throw new TypeError("object KEK must contain exactly 32 bytes");
  const database = await createPostgresDatabaseFromEnvironment(environment);
  await database.ready();
  const keyring = new MemoryVersionedEnvelopeKeyring(kek.bytes);
  kek.bytes.fill(0);
  const repository = new PostgresObjectRepository({ database });
  const configuredStorage = await storageConfiguration(environment.TEAMAIBOX_OBJECT_STORAGE_CONFIG_FILE);
  let storageAdministration = null;
  let storageObservationContext = null;
  let rawStore;
  if (configuredStorage) {
    const storageRepository = new PostgresStoragePoolRepository({ database });
    const storageDataPlane = new FilesystemStoragePoolDataPlane({ database, pools: configuredStorage.pools });
    const storagePools = new StoragePoolService({ repository: storageRepository, dataPlane: storageDataPlane });
    const internalPrincipal = Object.freeze({ id: "00000000-0000-4000-8000-000000000001", status: "active",
      identityKind: "service_account", serviceGrants: ["storage:view", "storage:manage"].map((permissionKey) => ({
        permissionKey, resourceKind: "appliance", resourceKey: "*", expiresAt: null, revokedAt: null,
      })) });
    storageObservationContext = Object.freeze({ identityId: internalPrincipal.id,
      permissions: Object.freeze(["storage:view", "storage:manage"]) });
    rawStore = new PooledFilesystemBlobStore({ repository: storageRepository, storagePoolService: storagePools,
      dataPlane: storageDataPlane, principal: internalPrincipal, defaultPoolId: configuredStorage.defaultPoolId });
    storageAdministration = new StorageAdministrationRuntime({ storagePoolService: storagePools,
      dataPlane: storageDataPlane, configuredPools: configuredStorage.pools });
  } else {
    rawStore = new FilesystemBlobStore({ root: requireAbsolute(environment.TEAMAIBOX_OBJECT_BLOB_ROOT, "TEAMAIBOX_OBJECT_BLOB_ROOT") });
  }
  const blobStore = new EnvelopeEncryptedBlobStore({
    rawStore,
    metadataRepository: new PostgresEnvelopeMetadataRepository({ database }), keyring,
  });
  const objectService = new ProtectedObjectService({
    repository, blobStore, referenceSigningKey: reference.bytes,
    grantRepository: new PostgresObjectGrantRepository({ database }),
  });
  reference.bytes.fill(0);
  const provenanceService = new ArtifactProvenanceService({
    repository: new PostgresArtifactProvenanceRepository({ database }),
    objectGateway: objectService.createObjectHandoffGateway(),
  });
  const server = createObjectRpcServer({ token: rpc.encoded, objectService, provenanceService, storageAdministration });
  rpc.bytes.fill(0);
  const port = Number(environment.TEAMAIBOX_OBJECT_SERVICE_PORT || "8080");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new TypeError("object service port is invalid");
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "0.0.0.0", resolve); });
  const storageObservationLoop = storageAdministration
    ? await startStorageObservationLoop({ storageAdministration, context: storageObservationContext }) : null;
  let closing = false;
  const close = () => { if (!closing) { closing = true; server.close(); } };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  server.once("close", () => { storageObservationLoop?.stop(); keyring.close(); void database.close(); });
  return server;
}


if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startObjectRpcService().catch((error) => {
    process.stderr.write(`object service failed: ${error?.message ?? "unknown error"}\n`);
    process.exitCode = 1;
  });
}
