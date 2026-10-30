import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isAbsolute } from "node:path";
import { checkServerIdentity } from "node:tls";

import { PostgresClusterMetricRepository } from "../../../services/scheduler/src/postgres-cluster-metric-repository.mjs";
import { PostgresAppliancePlacementRepository } from "../../../services/scheduler/src/postgres-appliance-placement-repository.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RUN_ID = /^protected-office-set-deployment(?:-v5)?-[0-9]{8}-a[1-9][0-9]*$/;
const TOKEN = /^taib_sk_[A-Za-z0-9_-]{43,171}$/;
const ABSOLUTE_BOUNDARY_CONFIG = "/run/teamaibox/protected-office-set/production-boundary.v1.json";
const ABSOLUTE_PROBE_CREDENTIAL = "/run/secrets/protected-office-set-probe";
const MAXIMUM_CONFIG_BYTES = 1024 * 1024;
const GiB = 2 ** 30;
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired", "incomplete"]);
const CAPABILITY_SLOTS = Object.freeze({
  "assistant.answer": "assistant-qwen38",
  "assistant.agent": "assistant-qwen38",
  translation: "translation-lmt4",
  "drawing.generate": "drawing-flux2",
  ocr: "ocr-hunyuan",
  embeddings: "embedding-qwen3",
  "asr.realtime": "asr-whisper",
});
const REQUEST_KEYS = Object.freeze([...Object.keys(CAPABILITY_SLOTS), "ordinary-conflict"]);
const COMPUTE_REQUEST_PROFILE_SLOTS = Object.freeze({
  "assistant.answer": "assistant-qwen38",
  translation: "translation-lmt4",
  "drawing.generate": "drawing-flux2",
  ocr: "ocr-hunyuan",
  embeddings: "embedding-qwen3",
  "ordinary-conflict": "assistant-qwen38",
});
const EXECUTION_KINDS = Object.freeze({
  "assistant.answer": "compute-job",
  "assistant.agent": "assistant-run",
  translation: "compute-job",
  "drawing.generate": "compute-job",
  ocr: "compute-job",
  embeddings: "compute-job",
  "asr.realtime": "realtime-session",
  "ordinary-conflict": "compute-job",
});
const PROTOCOL_PATHS = Object.freeze({
  "assistant.answer": "/v1/chat/completions",
  "assistant.agent": "/api/v1/assistant/conversations/",
  translation: "/api/v1/ai/translations",
  "drawing.generate": "/v1/images/generations",
  ocr: "/api/v1/ai/ocr",
  embeddings: "/v1/embeddings",
  "asr.realtime": "/api/v1/realtime/sessions",
});
const REQUIRED_ROUTER_METHODS = Object.freeze([
  "executeApplianceRuntimeRestart",
  "executeProtectedSetTransition",
  "inspectProtectedSetTransition",
]);
const RESTART_PROTOCOL = "teamaibox.protected-office-set-restart.v1";
const RESTART_COMMAND_TYPE = "appliance.runtime.restart";
const RESTART_TARGETS = Object.freeze(["platform-api", "node-agent"]);
const RESTART_OPERATION_ORDER = Object.freeze([
  "platform.restart", "platform.health", "node-agent.restart", "recovery.verify",
]);
const ACTIVE_CAST_STATES = Object.freeze(["requested", "starting", "pairing", "paired", "streaming", "stopping"]);
const MAXIMUM_RESTART_WINDOW_MILLISECONDS = 15 * 60_000;
const defaultFileSystem = Object.freeze({ lstat, readFile, realpath });

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function exactKeys(value, keys, label) {
  object(value, label);
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return value;
}

function positive(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is outside its production envelope`);
  }
  return value;
}

function serviceKeyList(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64
      || value.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(item))
      || new Set(value).size !== value.length
      || JSON.stringify(value) !== JSON.stringify([...value].sort())) {
    throw new TypeError(`${label} must be a sorted unique service-key list`);
  }
  return Object.freeze([...value]);
}

function absoluteFile(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value === "/" || value.includes("\0")) {
    throw new TypeError(`${label} must be a bounded absolute file`);
  }
  return value;
}

async function regularFile(path, label, fileSystem, { minimum = 1, maximum = MAXIMUM_CONFIG_BYTES, privateFile = false } = {}) {
  absoluteFile(path, label);
  if (!fileSystem?.realpath || !fileSystem?.lstat || !fileSystem?.readFile) {
    throw new TypeError("protected office production boundary filesystem is incomplete");
  }
  if (await fileSystem.realpath(path) !== path) throw new TypeError(`${label} cannot be a symbolic link`);
  const stat = await fileSystem.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < minimum || stat.size > maximum
      || (privateFile && typeof stat.mode === "number" && (stat.mode & 0o077) !== 0)) {
    throw new TypeError(`${label} is not a bounded${privateFile ? " private" : ""} regular file`);
  }
  const bytes = await fileSystem.readFile(path);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== stat.size) {
    bytes?.fill?.(0);
    throw new TypeError(`${label} changed while it was read`);
  }
  return bytes;
}

async function jsonDocument(path, label, fileSystem) {
  const bytes = await regularFile(path, label, fileSystem);
  try {
    return object(JSON.parse(bytes.toString("utf8")), label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError(`${label} is not valid JSON`, { cause: error });
    throw error;
  } finally { bytes.fill(0); }
}

async function probeCredential(path, fileSystem) {
  const bytes = await regularFile(path, "protected office HTTPS credential", fileSystem, {
    minimum: 32, maximum: 512, privateFile: true,
  });
  try {
    const value = bytes.toString("utf8").trim();
    if (!TOKEN.test(value)) throw new TypeError("protected office HTTPS credential is invalid");
    return value;
  } finally { bytes.fill(0); }
}

function jsonPointer(document, path, label) {
  if (typeof path !== "string" || !/^\/(?:[^~\/]|~[01])+(?:\/(?:[^~\/]|~[01])+)*$/.test(path)) {
    throw new TypeError(`${label} JSON pointer is invalid`);
  }
  let value = document;
  for (const encoded of path.slice(1).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) {
      throw new TypeError(`${label} JSON pointer is missing`);
    }
    value = value[key];
  }
  return value;
}

function requestDeclaration(value, key) {
  exactKeys(value, ["method", "path", "body", "identityKind", "identityPointer"], `protected office ${key} request`);
  const prefix = PROTOCOL_PATHS[key];
  if (value.method !== "POST" || typeof value.path !== "string" || !value.path.startsWith("/")
      || value.path.includes("?") || value.path.includes("#") || value.path.includes("\\")
      || value.path.includes("..") || (prefix && !value.path.startsWith(prefix))
      || !value.body || typeof value.body !== "object" || Array.isArray(value.body)) {
    throw new TypeError(`protected office ${key} request is invalid`);
  }
  if (value.identityKind !== EXECUTION_KINDS[key]
      || typeof value.identityPointer !== "string"
      || !/^\/(?:[^~\/]|~[01])+(?:\/(?:[^~\/]|~[01])+)*$/.test(value.identityPointer)) {
    throw new TypeError(`protected office ${key} execution identity is invalid`);
  }
  if (key === "ocr") {
    const input = value.body.input;
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).join(",") !== "object_id" || !UUID.test(input.object_id ?? "")) {
      throw new TypeError("protected office OCR request must bind a durable source object");
    }
  }
  if (key === "asr.realtime") {
    const lifetime = value.body.expires_in_seconds;
    if (!Number.isSafeInteger(lifetime) || lifetime < 30 || lifetime > 3600) {
      throw new TypeError("protected office realtime request lifetime is invalid");
    }
  }
  return Object.freeze(structuredClone(value));
}

function placementDeclaration(value, index) {
  exactKeys(value, [
    "capability", "model", "route", "resources", "codecDirections",
    "latencyBudgetMilliseconds", "observedLatencyMilliseconds", "warm",
  ], `protected office realtime placement ${index}`);
  if (!Object.hasOwn(CAPABILITY_SLOTS, value.capability) || (value.model !== null && typeof value.model !== "string")
      || typeof value.route !== "string" || value.route.length < 3 || value.route.length > 256
      || typeof value.warm !== "boolean") {
    throw new TypeError(`protected office realtime placement ${index} is invalid`);
  }
  exactKeys(value.resources, ["unifiedMemoryBytes", "codecSessions"], `protected office realtime placement ${index}.resources`);
  positive(value.resources.unifiedMemoryBytes, `protected office realtime placement ${index}.resources.unifiedMemoryBytes`, 1, 16 * GiB);
  positive(value.resources.codecSessions, `protected office realtime placement ${index}.resources.codecSessions`, 0, 64);
  if (!Array.isArray(value.codecDirections) || value.codecDirections.length > 4
      || value.codecDirections.some((item) => !new Set(["encode", "decode"]).has(item))) {
    throw new TypeError(`protected office realtime placement ${index}.codecDirections is invalid`);
  }
  positive(value.latencyBudgetMilliseconds, `protected office realtime placement ${index}.latencyBudgetMilliseconds`, 1, 60_000);
  positive(value.observedLatencyMilliseconds, `protected office realtime placement ${index}.observedLatencyMilliseconds`, 0, 60_000);
  return Object.freeze(structuredClone(value));
}

function boundaryConfig(value) {
  exactKeys(value, ["schemaVersion", "coreProbe", "publicHttps", "realtime"], "protected office production boundary config");
  if (value.schemaVersion !== 1) throw new TypeError("protected office production boundary config schema is unsupported");
  exactKeys(value.coreProbe, ["maximumAgeMilliseconds", "requiredServiceKeys"], "protected office core probe config");
  positive(value.coreProbe.maximumAgeMilliseconds, "protected office core probe maximum age", 1_000, 60_000);
  const requiredServiceKeys = serviceKeyList(value.coreProbe.requiredServiceKeys,
    "protected office required core services");
  exactKeys(value.publicHttps, [
    "requestTimeoutMilliseconds", "completionTimeoutMilliseconds", "pollIntervalMilliseconds", "requests",
  ], "protected office public HTTPS config");
  positive(value.publicHttps.requestTimeoutMilliseconds, "protected office HTTPS request timeout", 1_000, 120_000);
  positive(value.publicHttps.completionTimeoutMilliseconds, "protected office HTTPS completion timeout", 1_000, 900_000);
  positive(value.publicHttps.pollIntervalMilliseconds, "protected office HTTPS poll interval", 100, 10_000);
  exactKeys(value.publicHttps.requests, REQUEST_KEYS, "protected office public HTTPS requests");
  const requests = Object.fromEntries(REQUEST_KEYS.map((key) => [key, requestDeclaration(value.publicHttps.requests[key], key)]));
  exactKeys(value.realtime, ["placements"], "protected office realtime config");
  if (!Array.isArray(value.realtime.placements) || value.realtime.placements.length < 1
      || value.realtime.placements.length > 16) {
    throw new TypeError("protected office realtime placements are invalid");
  }
  const placements = value.realtime.placements.map(placementDeclaration);
  const identities = placements.map((item) => `${item.capability}\0${item.model ?? ""}`);
  if (new Set(identities).size !== identities.length) throw new TypeError("protected office realtime placements are duplicated");
  return Object.freeze({
    schemaVersion: 1,
    coreProbe: Object.freeze({ maximumAgeMilliseconds: value.coreProbe.maximumAgeMilliseconds,
      requiredServiceKeys }),
    publicHttps: Object.freeze({ ...value.publicHttps, requests: Object.freeze(requests) }),
    realtime: Object.freeze({ placements: Object.freeze(placements) }),
  });
}

function rows(result, label) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError(`${label} PostgreSQL result is invalid`);
  return result.rows;
}

function iso(value, label) {
  const result = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new TypeError(`${label} is invalid`);
  return result.toISOString();
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function storedDigest(value, label) {
  if (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) return `sha256:${value}`;
  if (Buffer.isBuffer(value) && value.byteLength === 32) return `sha256:${value.toString("hex")}`;
  throw new TypeError(`${label} digest is invalid`);
}

function executionIdentity(value, pointer, label) {
  const identityId = jsonPointer(value, pointer, label);
  if (!UUID.test(identityId ?? "")) throw new TypeError(`${label} did not return a durable execution identity`);
  return identityId.toLowerCase();
}

async function boundedResponse(response, label) {
  if (!response || typeof response.arrayBuffer !== "function") throw new TypeError(`${label} response is invalid`);
  const bytes = Buffer.from(await response.arrayBuffer());
  try {
    if (bytes.byteLength < 2 || bytes.byteLength > 2 * 1024 * 1024) throw new TypeError(`${label} response is outside its bounded envelope`);
    return object(JSON.parse(bytes.toString("utf8")), `${label} response`);
  } finally { bytes.fill(0); }
}

function fetchOptions(credential, declaration, idempotencyKey, timeoutMilliseconds, requestOrigin) {
  return {
    method: declaration.method,
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      ...(requestOrigin ? { origin: requestOrigin } : {}),
    },
    body: JSON.stringify(declaration.body),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMilliseconds),
  };
}

export async function pinnedPublicHttpsFetcher({
  connectOrigin,
  publicOrigin,
  caFile,
  fileSystem,
  request: requestFactory = httpsRequest,
}) {
  let connect;
  let publicEndpoint;
  try {
    connect = new URL(connectOrigin);
    publicEndpoint = new URL(publicOrigin);
  } catch {
    throw new TypeError("protected office HTTPS connection endpoint is invalid");
  }
  if (connect.protocol !== "https:" || connect.username || connect.password || connect.pathname !== "/"
      || connect.search || connect.hash || publicEndpoint.protocol !== "https:"
      || publicEndpoint.username || publicEndpoint.password || publicEndpoint.pathname !== "/"
      || publicEndpoint.search || publicEndpoint.hash) {
    throw new TypeError("protected office HTTPS connection endpoint must be exact HTTPS");
  }
  const ca = await regularFile(caFile, "protected office public HTTPS CA", fileSystem, {
    minimum: 256, maximum: 64 * 1024,
  });
  return async (input, options = {}) => {
    const requested = new URL(input);
    if (requested.origin !== publicEndpoint.origin || requested.username || requested.password) {
      throw new TypeError("protected office HTTPS request escaped the public origin");
    }
    return new Promise((resolve, reject) => {
      const request = requestFactory({
        hostname: connect.hostname,
        port: connect.port || 443,
        method: options.method ?? "GET",
        path: `${requested.pathname}${requested.search}`,
        headers: { ...(options.headers ?? {}), host: requested.host },
        ca,
        servername: connect.hostname,
        rejectUnauthorized: true,
        checkServerIdentity: (_hostname, certificate) => checkServerIdentity(publicEndpoint.hostname, certificate),
      }, (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.byteLength;
          if (size > 2 * 1024 * 1024) {
            request.destroy(new TypeError("protected office HTTPS response exceeded its bounded envelope"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve(Object.freeze({
            status: response.statusCode ?? 0,
            ok: Number(response.statusCode) >= 200 && Number(response.statusCode) < 300,
            headers: Object.freeze({
              get(name) {
                const value = response.headers[String(name).toLowerCase()];
                return Array.isArray(value) ? value.join(", ") : (value ?? null);
              },
            }),
            async arrayBuffer() { return body; },
          }));
        });
      });
      request.on("error", reject);
      const abort = () => request.destroy(options.signal?.reason ?? new Error("protected office HTTPS request aborted"));
      options.signal?.addEventListener("abort", abort, { once: true });
      request.setTimeout(120_000, () => request.destroy(new Error("protected office HTTPS request timed out")));
      if (options.body !== undefined) request.write(options.body);
      request.end();
    });
  };
}

function protectedOcrReferenceIssuer({ database, objectService, clock }) {
  if (typeof objectService?.createObjectHandoffGateway !== "function") {
    throw new TypeError("protected office OCR object gateway is unavailable");
  }
  const gateway = objectService.createObjectHandoffGateway();
  if (typeof gateway?.issue !== "function") {
    throw new TypeError("protected office OCR object reference issuer is unavailable");
  }
  return Object.freeze({
    async issue({ objectId, expiresInSeconds }) {
      if (!UUID.test(objectId ?? "") || !Number.isSafeInteger(expiresInSeconds)
          || expiresInSeconds < 1 || expiresInSeconds > 600) {
        throw new TypeError("protected office OCR source reference request is invalid");
      }
      const result = await database.query(`SELECT entry.namespace_key,entry.current_version,
          identity.id AS owner_identity_id,identity.identity_kind,identity.status
        FROM objects.object_entries entry
        JOIN iam.identities identity ON entry.namespace_key=('user:' || identity.id::text)
        WHERE entry.id=$1 AND entry.deleted_at IS NULL`, [objectId.toLowerCase()]);
      const records = rows(result, "protected office OCR source object");
      if (records.length !== 1) throw new TypeError("protected office OCR source object is unavailable");
      const record = records[0];
      const ownerIdentityId = String(record.owner_identity_id ?? "").toLowerCase();
      const objectVersion = Number(record.current_version);
      if (!UUID.test(ownerIdentityId) || record.namespace_key !== `user:${ownerIdentityId}`
          || record.identity_kind !== "local_user" || record.status !== "active"
          || !Number.isSafeInteger(objectVersion) || objectVersion < 1) {
        throw new TypeError("protected office OCR source object authority drifted");
      }
      const issued = await gateway.issue({
        actorIdentityId: ownerIdentityId,
        objectId: objectId.toLowerCase(),
        objectVersion,
        audience: "compute:ocr",
        operations: ["head", "read", "range"],
        expiresInSeconds,
      });
      const expiresAt = new Date(issued?.expiresAt);
      if (!UUID.test(issued?.referenceId ?? "") || !Number.isFinite(expiresAt.getTime())
          || expiresAt.getTime() <= clock().getTime()) {
        throw new TypeError("protected office OCR source reference could not be refreshed");
      }
      return Object.freeze({ referenceId: issued.referenceId.toLowerCase(), expiresAt: expiresAt.toISOString() });
    },
  });
}

function publicHttpsClient({ config, plan, fetcher, credentialFile, fileSystem, ocrReferenceIssuer }) {
  const profileBySlot = new Map(plan.set.profiles.map((profile) => [profile.slot, profile.modelProfileId]));
  if (profileBySlot.size !== plan.set.profiles.length
      || Object.values(COMPUTE_REQUEST_PROFILE_SLOTS).some((slot) => !UUID.test(profileBySlot.get(slot) ?? ""))) {
    throw new TypeError("protected office public HTTPS profile binding is incomplete");
  }
  return Object.freeze({
    async runConcurrentOffice(request) {
      let origin;
      try { origin = new URL(request.publicOrigin); } catch { throw new TypeError("protected office public origin is invalid"); }
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/"
          || origin.search || origin.hash) throw new TypeError("protected office public origin must be exact HTTPS");
      const credential = await probeCredential(credentialFile, fileSystem);
      // A retained probe conversation may contain an interrupted OpenCode
      // retry. Each qualification owns a fresh conversation; never append a
      // new proof to a predecessor's pending upstream session.
      const conversationResponse = await fetcher(new URL("/api/v1/assistant/conversations", origin),
        fetchOptions(credential, { method: "POST", body: { title: "Protected office qualification" } },
          `${request.idempotencyKey.slice(7, 47)}-conversation`,
          config.publicHttps.requestTimeoutMilliseconds, origin.origin));
      const conversationBody = await boundedResponse(conversationResponse, "protected office fresh conversation");
      if (!conversationResponse.ok || !UUID.test(conversationBody.id ?? "")) {
        throw Object.assign(new TypeError("protected office fresh Agent conversation could not be created"),
          { code: "protected_office_agent_conversation_failed" });
      }
      const agentConversationPath = `/api/v1/assistant/conversations/${conversationBody.id}`;
      const requestBody = async (key, declaration) => {
        const body = structuredClone(declaration.body);
        if (key === "ocr") {
          const objectId = declaration.body.input.object_id;
          const reference = await ocrReferenceIssuer.issue({ objectId, expiresInSeconds: 600 });
          body.input = Object.freeze({ reference_id: reference.referenceId });
        }
        const slot = COMPUTE_REQUEST_PROFILE_SLOTS[key];
        if (slot) {
          const extension = body.x_teamaibox == null ? {} : object(body.x_teamaibox,
            `protected office ${key} x_teamaibox`);
          body.x_teamaibox = Object.freeze({
            ...structuredClone(extension),
            model_profile_id: profileBySlot.get(slot),
          });
        }
        if (key === "drawing.generate") body.model = "drawing.automatic";
        return Object.freeze(body);
      };
      const submit = async (key) => {
        const declaration = config.publicHttps.requests[key];
        const idempotencyKey = `${request.idempotencyKey.slice(7, 47)}-${key.replaceAll(".", "-")}`;
        const materializedBody = await requestBody(key, declaration);
        const submissionPath = key === "assistant.agent" ? `${agentConversationPath}/messages` : declaration.path;
        const response = await fetcher(new URL(submissionPath, origin), fetchOptions(
          credential, { ...declaration, body: materializedBody }, idempotencyKey,
          config.publicHttps.requestTimeoutMilliseconds,
          origin.origin,
        ));
        const body = await boundedResponse(response, `protected office ${key}`);
        if (!response.ok) throw Object.assign(new TypeError(`protected office ${key} HTTPS request failed closed`),
          { code: `protected_office_${key.replaceAll(".", "_").replaceAll("-", "_")}_submission_failed` });
        const identityId = executionIdentity(body, declaration.identityPointer, `protected office ${key}`);
        const expiresAt = key === "asr.realtime" ? body.expires_at : null;
        if (key === "asr.realtime" && (!Number.isFinite(new Date(expiresAt).getTime())
            || new Date(expiresAt).getTime() <= Date.now())) {
          throw new TypeError("protected office realtime admission did not return a future expiry");
        }
        return Object.freeze({ key, identityKind: declaration.identityKind, identityId, expiresAt });
      };
      try {
        const answer = await submit("assistant.answer");
        const deadline = Date.now() + config.publicHttps.completionTimeoutMilliseconds;
        // The contention proof needs actual overlap, not two requests which
        // merely happen to be submitted together. No artificial Worker delay
        // or reservation is introduced: observe the real public job first.
        while (true) {
          const response = await fetcher(new URL(`/api/v1/jobs/${answer.identityId}`, origin), {
            method: "GET", headers: { authorization: `Bearer ${credential}` }, redirect: "error",
            signal: AbortSignal.timeout(config.publicHttps.requestTimeoutMilliseconds),
          });
          const body = await boundedResponse(response, "protected office answer overlap poll");
          if (!response.ok || body.job_id !== answer.identityId || typeof body.status !== "string") {
            throw Object.assign(new TypeError("protected office answer overlap poll drifted"),
              { code: "protected_office_overlap_poll_invalid" });
          }
          if (body.status === "running" && UUID.test(body.x_teamaibox?.attempt_id ?? "")) break;
          if (TERMINAL.has(body.status) || Date.now() >= deadline) {
            throw Object.assign(new TypeError("protected office answer fixture did not expose a running attempt"),
              { code: "protected_office_overlap_fixture_too_short" });
          }
          await new Promise((resolve) => setTimeout(resolve, config.publicHttps.pollIntervalMilliseconds));
        }
        const submitted = [answer, ...await Promise.all(REQUEST_KEYS
          .filter((key) => key !== "assistant.answer").map(submit))];
        const byKey = new Map(submitted.map((item) => [item.key, item]));
        const jobIds = Object.fromEntries(submitted
          .filter((item) => item.identityKind === "compute-job" && item.key !== "ordinary-conflict")
          .map((item) => [item.key, item.identityId]));
        const assistantRunId = byKey.get("assistant.agent").identityId;
        const realtimeSessionId = byKey.get("asr.realtime").identityId;
        const ordinaryConflictingJobId = byKey.get("ordinary-conflict").identityId;
        let ordinaryConflictObservedQueued = false;
        while (!ordinaryConflictObservedQueued) {
          if (Date.now() >= deadline) {
            throw new TypeError("protected office ordinary conflict did not expose protected Worker contention in time");
          }
          const response = await fetcher(new URL(`/api/v1/jobs/${ordinaryConflictingJobId}`, origin), {
            method: "GET", headers: { authorization: `Bearer ${credential}` }, redirect: "error",
            signal: AbortSignal.timeout(config.publicHttps.requestTimeoutMilliseconds),
          });
          const body = await boundedResponse(response, "protected office ordinary conflict poll");
          if (!response.ok || body.job_id !== ordinaryConflictingJobId || typeof body.status !== "string") {
            throw new TypeError("protected office ordinary conflict poll drifted");
          }
          if (body.status === "queued" && body.waiting_reason === "protected_worker_busy"
              && body.x_teamaibox?.attempt_id === null) {
            ordinaryConflictObservedQueued = true;
            break;
          }
          if (TERMINAL.has(body.status) || body.x_teamaibox?.attempt_id) {
            throw Object.assign(new TypeError("protected office ordinary conflict acquired protected execution capacity"),
              { code: "protected_office_conflict_overlap_missed" });
          }
          await new Promise((resolve) => setTimeout(resolve, config.publicHttps.pollIntervalMilliseconds));
        }
        const cancelled = await fetcher(new URL(`/api/v1/jobs/${ordinaryConflictingJobId}/cancel`, origin), {
          method: "POST", headers: { authorization: `Bearer ${credential}`, origin: origin.origin,
            accept: "application/json", "content-type": "application/json", "content-length": "2" },
          body: "{}", redirect: "error",
          signal: AbortSignal.timeout(config.publicHttps.requestTimeoutMilliseconds),
        });
        const cancelledBody = await boundedResponse(cancelled, "protected office ordinary conflict cancellation");
        if (!cancelled.ok || cancelledBody.job_id !== ordinaryConflictingJobId
            || cancelledBody.status !== "cancelled" || cancelledBody.x_teamaibox?.attempt_id !== null) {
          throw new TypeError("protected office ordinary conflict cleanup did not remain attempt-free");
        }
        for (const jobId of Object.values(jobIds)) {
          while (true) {
            if (Date.now() >= deadline) throw new TypeError("protected office public HTTPS jobs did not complete in time");
            const response = await fetcher(new URL(`/api/v1/jobs/${jobId}`, origin), {
              method: "GET", headers: { authorization: `Bearer ${credential}` }, redirect: "error",
              signal: AbortSignal.timeout(config.publicHttps.requestTimeoutMilliseconds),
            });
            const body = await boundedResponse(response, "protected office job poll");
            if (!response.ok || body.job_id !== jobId || typeof body.status !== "string") {
              throw new TypeError("protected office public HTTPS job poll drifted");
            }
            if (body.status === "succeeded") break;
            if (TERMINAL.has(body.status)) throw new TypeError("protected office public HTTPS job failed");
            await new Promise((resolve) => setTimeout(resolve, config.publicHttps.pollIntervalMilliseconds));
          }
        }
        while (true) {
          if (Date.now() >= deadline) throw new TypeError("protected office Assistant Agent run did not complete in time");
          const response = await fetcher(new URL(agentConversationPath, origin), {
            method: "GET", headers: { authorization: `Bearer ${credential}` }, redirect: "error",
            signal: AbortSignal.timeout(config.publicHttps.requestTimeoutMilliseconds),
          });
          const body = await boundedResponse(response, "protected office Assistant Agent poll");
          const message = Array.isArray(body.messages)
            ? body.messages.find((item) => item?.runId === assistantRunId && item?.role === "assistant") : null;
          if (!response.ok || !message || typeof message.status !== "string") {
            throw new TypeError("protected office Assistant Agent poll drifted");
          }
          if (message.status === "completed") break;
          if (new Set(["failed", "cancelled"]).has(message.status)) {
            throw Object.assign(new TypeError("protected office Assistant Agent run failed"),
              { code: "protected_office_agent_execution_failed" });
          }
          await new Promise((resolve) => setTimeout(resolve, config.publicHttps.pollIntervalMilliseconds));
        }
        const realtimeExpiry = new Date(byKey.get("asr.realtime").expiresAt).getTime();
        while (Date.now() <= realtimeExpiry) {
          if (Date.now() >= deadline) throw new TypeError("protected office realtime reservation did not expire in time");
          await new Promise((resolve) => setTimeout(resolve, Math.min(
            config.publicHttps.pollIntervalMilliseconds, Math.max(1, realtimeExpiry - Date.now() + 1),
          )));
        }
        return Object.freeze({
          transport: "authenticated-public-https",
          jobIds: Object.freeze(jobIds),
          assistantRunId,
          realtimeSessionId,
          ordinaryConflictingJobId,
          ordinaryConflictObservedQueued,
          ordinaryConflictCleanupStatus: "cancelled",
        });
      } finally {
        // Strings cannot be zeroed; keep the credential scoped to this call and never return or log it.
      }
    },
  });
}

function validatorRunner(execFile = nodeExecFile) {
  return Object.freeze({
    runStrictValidator({ validatorPath, evidencePath, repositoryRoot, timeoutMilliseconds }) {
      return new Promise((resolve) => {
        execFile("python3", [validatorPath, "--evidence", evidencePath], {
          cwd: repositoryRoot, timeout: timeoutMilliseconds, maxBuffer: 4 * 1024 * 1024,
          windowsHide: true, shell: false,
        }, (error) => resolve(Object.freeze({
          status: error == null ? "passed" : "failed",
          exitCode: error == null ? 0 : (Number.isSafeInteger(error.code) ? error.code : 1),
          validatorPath,
          evidencePath,
        })));
      });
    },
  });
}

function leaseAuthorityProvider(database) {
  return Object.freeze({
    async getAuthority(request) {
      return database.transaction(async (transaction) => {
        const node = rows(await transaction.query(`SELECT id,generation,lifecycle_state
          FROM compute.nodes WHERE id=$1 FOR UPDATE`, [request.nodeId]), "protected office authority node")[0];
        if (!node || Number(node.generation) !== request.nodeGeneration || node.lifecycle_state !== "ready") {
          throw new TypeError("protected office authority target is not the exact ready node generation");
        }
        const fence = rows(await transaction.query(`INSERT INTO compute.node_lease_fences (node_id,next_fencing_token)
          VALUES ($1,2) ON CONFLICT (node_id) DO UPDATE
          SET next_fencing_token=compute.node_lease_fences.next_fencing_token+1,updated_at=clock_timestamp()
          RETURNING next_fencing_token-1 AS fencing_token`, [request.nodeId]), "protected office authority fence")[0];
        const fencingToken = Number(fence?.fencing_token);
        if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
          throw new TypeError("protected office authority fence was not durably allocated");
        }
        return Object.freeze({ leaseId: request.attemptId, fencingToken, nodeGeneration: request.nodeGeneration });
      });
    },
  });
}

function realtimeResolver({ config, plan, placementRepository }) {
  const profileBySlot = new Map(plan.set.profiles.map((profile) => [profile.slot, profile]));
  return Object.freeze({
    async resolve(request) {
      const declaration = config.realtime.placements.find((item) =>
        item.capability === request.capability && item.model === (request.model ?? null));
      if (!declaration) return Object.freeze([]);
      const profile = profileBySlot.get(CAPABILITY_SLOTS[request.capability]);
      const placement = await placementRepository.getModelProfilePlacement(profile.modelProfileId);
      const nodes = await placementRepository.listNodePlacements();
      const target = nodes.find((item) => item.node?.nodeId === plan.target.nodeId);
      if (!placement || placement.profile?.placementClass !== "protected-resident"
          || placement.profile.maintenanceGeneration !== plan.set.maintenanceGeneration
          || placement.currentRevision?.configurationDigest !== profile.configurationDigest
          || placement.currentRevision?.placementState !== "active"
          || target?.node?.recoveryState !== "healthy"
          || target.node.maintenanceGeneration !== plan.set.maintenanceGeneration) return Object.freeze([]);
      return Object.freeze([Object.freeze({
        nodeId: plan.target.nodeId,
        nodeGeneration: plan.target.nodeGeneration,
        modelProfileId: profile.modelProfileId,
        route: declaration.route,
        resources: Object.freeze(structuredClone(declaration.resources)),
        codecDirections: Object.freeze([...declaration.codecDirections]),
        latencyBudgetMilliseconds: declaration.latencyBudgetMilliseconds,
        observedLatencyMilliseconds: declaration.observedLatencyMilliseconds,
        warm: declaration.warm,
      })]);
    },
  });
}

function healthyCoreService(service) {
  const errorRate = service?.errorRatePercent;
  const errorRateAccepted = (errorRate?.status === "measured" && errorRate.value === 0)
    || (errorRate?.status === "unavailable" && errorRate.value == null
      && errorRate.reasonCode === "service_error_rate_not_collected_at_node");
  return service?.state === "healthy"
    && service.availabilityPercent?.status === "measured"
    && Number.isSafeInteger(service.availabilityPercent.value)
    && service.availabilityPercent.value > 0
    && errorRateAccepted;
}

function coreServiceProbe({ database, metricRepository, nodeAgentRouter, maximumAgeMilliseconds,
  requiredServiceKeys, clock }) {
  return Object.freeze({
    async probe(request) {
      const [metric, agent] = await Promise.all([
        metricRepository.latestForNode(request.nodeId),
        nodeAgentRouter.inspectAppliance({
          nodeId: request.nodeId,
          nodeGeneration: Number((await database.query("SELECT generation FROM compute.nodes WHERE id=$1", [request.nodeId]))?.rows?.[0]?.generation),
          correlationId: `protected-office:core-probe:${request.phase}`,
        }),
      ]);
      const observedAt = new Date(metric?.observedAt);
      const available = metric?.snapshot?.domains?.unifiedMemory?.availableBytes;
      const total = metric?.snapshot?.domains?.unifiedMemory?.totalBytes;
      const coreServices = metric?.snapshot?.coreServices;
      const measured = (item) => item?.status === "measured" && Number.isSafeInteger(item.value);
      const serviceEntries = Array.isArray(coreServices) ? coreServices : [];
      const serviceKeys = serviceEntries.map((service) => service?.serviceKey);
      const duplicated = new Set(serviceKeys).size !== serviceKeys.length;
      const serviceByKey = new Map(serviceEntries.map((service) => [service?.serviceKey, service]));
      if (!metric || !Number.isFinite(observedAt.getTime()) || clock().getTime() - observedAt.getTime() > maximumAgeMilliseconds
          || metric.nodeGeneration !== agent?.nodeGeneration || metric.nodeGeneration < 1
          || !measured(total) || !measured(available) || available.value > total.value
          || serviceEntries.length < requiredServiceKeys.length || duplicated
          || requiredServiceKeys.some((key) => !healthyCoreService(serviceByKey.get(key)))) {
        throw new TypeError("protected office authenticated core-service probe failed closed");
      }
      return Object.freeze({
        healthy: true, nodeId: request.nodeId, setId: request.setId, phase: request.phase,
        requiredServiceKeys,
        source: "authenticated-core-service-probe", observedAt: observedAt.toISOString(),
      });
    },
  });
}

function maintenanceAllocator({ database, nodeId, nodeGeneration, clock, idFactory }) {
  return Object.freeze({
    async create(request) {
      return database.transaction(async (transaction) => {
        const node = rows(await transaction.query(`SELECT id,generation,lifecycle_state
          FROM compute.nodes WHERE id=$1 FOR UPDATE`, [nodeId]), "protected office maintenance node")[0];
        if (!node || Number(node.generation) !== nodeGeneration
            || !new Set(["ready", "draining"]).has(node.lifecycle_state)) {
          throw new TypeError("protected office maintenance target is unavailable");
        }
        const fence = rows(await transaction.query(`INSERT INTO compute.node_lease_fences (node_id,next_fencing_token)
          VALUES ($1,2) ON CONFLICT (node_id) DO UPDATE
          SET next_fencing_token=compute.node_lease_fences.next_fencing_token+1,updated_at=clock_timestamp()
          RETURNING next_fencing_token-1 AS fencing_token`, [nodeId]), "protected office maintenance fence")[0];
        const journalRevision = Number(fence?.fencing_token);
        if (!Number.isSafeInteger(journalRevision) || journalRevision < 1) {
          throw new TypeError("protected office maintenance journal fence was not persisted");
        }
        const issuedAt = clock();
        return Object.freeze({
          transactionId: idFactory(), journalRevision, workerIds: Object.freeze([...request.workerIds]),
          allowedOperations: Object.freeze(["protected-set.maintenance"]),
          maintenanceGeneration: request.maintenanceGeneration,
          issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + 15 * 60_000).toISOString(),
        });
      });
    },
  });
}

function restartRequest(value, plan, { identities = false } = {}) {
  object(value, "protected office restart request");
  const command = object(value.command, "protected office restart command");
  if (!RUN_ID.test(value.runId ?? "") || !UUID.test(value.actionId ?? "")
      || !SHA256.test(value.idempotencyKey ?? "") || !UUID.test(value.lifecycleCommandId ?? "")
      || !UUID.test(value.platformOperationId ?? "") || !UUID.test(value.nodeAgentOperationId ?? "")
      || !SHA256.test(value.requestDigest ?? "") || command.schemaVersion !== 1
      || command.protocol !== RESTART_PROTOCOL || command.runId !== value.runId
      || command.action !== "restart-verify" || command.actionId !== value.actionId
      || command.idempotencyKey !== value.idempotencyKey
      || !sameJson(command.restartTargets, RESTART_TARGETS)
      || command.mutationAuthority !== "node-agent-mtls-hmac"
      || command.dockerMutationAuthority !== "node-agent-only"
      || command.lifecycleCommandType !== RESTART_COMMAND_TYPE
      || command.lifecycleCommandId !== value.lifecycleCommandId
      || !sameJson(command.operationOrder, RESTART_OPERATION_ORDER)
      || (identities && (!sameJson(value.expectedPlatformIdentity, plan.target.platformIdentity)
        || !sameJson(value.expectedNodeAgentIdentity, plan.target.nodeAgentIdentity)))) {
    throw new TypeError("protected office restart request identity drifted");
  }
  return value;
}

async function restartAction(database, request) {
  const row = rows(await database.query(`SELECT run_id,action,action_id,idempotency_key,revision,
      action_state,recovery_count,created_at,updated_at
    FROM compute.protected_office_deployment_actions
    WHERE run_id=$1 AND action='restart-verify'`, [request.runId]), "protected office restart action")[0];
  if (!row || row.action !== "restart-verify" || row.action_id !== request.actionId
      || storedDigest(row.idempotency_key, "protected office restart action") !== request.idempotencyKey
      || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1
      || !Number.isSafeInteger(Number(row.recovery_count)) || Number(row.recovery_count) < 0
      || !new Set(["running", "recovering"]).has(row.action_state)) {
    throw new TypeError("protected office restart action journal identity drifted");
  }
  return Object.freeze({
    revision: Number(row.revision), state: row.action_state,
    recoveryCount: Number(row.recovery_count), createdAt: iso(row.created_at, "protected office restart createdAt"),
    updatedAt: iso(row.updated_at, "protected office restart updatedAt"),
  });
}

async function restartSessionCounts(database, plan, at) {
  const [castResult, mediaResult] = await Promise.all([
    database.query(`SELECT count(*)::integer AS active_count
      FROM platform.cast_sessions
      WHERE appliance_node_id=$1 AND created_at<=$2
        AND ((expires_at>$2 AND (terminal_at IS NULL OR terminal_at>$2))
          false)`, [plan.target.nodeId, at]),
    database.query(`SELECT count(*) FILTER (WHERE capability_key IN ('codec','webrtc-gateway')
        OR coalesce((codec_directions->>'encodeSessions')::integer,0)>0
        OR coalesce((codec_directions->>'decodeSessions')::integer,0)>0)::integer AS media_count
      FROM compute.realtime_sessions
      WHERE node_id=$1 AND node_generation=$2 AND admitted_at<=$3 AND expires_at>$3
        AND (released_at IS NULL OR released_at>$3)`, [plan.target.nodeId, plan.target.nodeGeneration, at]),
  ]);
  const casting = Number(rows(castResult, "protected office restart casting count")[0]?.active_count ?? 0);
  const media = Number(rows(mediaResult, "protected office restart media count")[0]?.media_count ?? 0);
  if (!Number.isSafeInteger(casting) || casting < 0 || !Number.isSafeInteger(media) || media < 0) {
    throw new TypeError("protected office restart session counts are invalid");
  }
  return Object.freeze({ casting, media });
}

function restartObservation(value, expected, label) {
  object(value, label);
  if (!expected || value.containerId !== expected.containerId || value.imageId !== expected.imageId
      || value.imageReference !== expected.imageReference
      || value.configurationDigest !== expected.configDigest || value.status !== "running"
      || value.health !== "healthy" || !Number.isFinite(Date.parse(value.startedAt ?? ""))) {
    throw new TypeError(`${label} identity drifted`);
  }
  return Object.freeze({
    containerName: expected.containerName, containerId: value.containerId,
    imageId: value.imageId, imageReference: value.imageReference, configDigest: value.configurationDigest,
    startedAt: iso(value.startedAt, `${label}.startedAt`), status: value.status, health: value.health,
  });
}

async function exactRestartedSet(database, plan, runId) {
  // Reconcile increments desired revisions before this action. Bind restart
  // recovery to this run's durable maintenance checkpoint, not the initial
  // deployment-plan revision. Missing/stale predecessor facts fail closed.
  const predecessor = rows(await database.query(`SELECT result
    FROM compute.protected_office_deployment_actions
    WHERE run_id=$1 AND action='bounded-maintenance' AND action_state='succeeded'`,
    [runId]), "protected office pre-restart checkpoint")[0];
  let result = predecessor?.result;
  if (typeof result === "string") result = JSON.parse(result);
  const before = result?.proof?.setState;
  if (!before || !Number.isSafeInteger(before.desiredStateRevision)
      || before.desiredStateRevision < plan.set.desiredStateRevision
      || before.observedStateRevision !== before.desiredStateRevision
      || before.recoveryState !== "healthy" || !UUID.test(before.lastTransactionId ?? "")) return false;
  const row = rows(await database.query(`SELECT node_id,desired_state_revision,observed_state_revision,
      maintenance_generation,recovery_state,healthy_identities,last_transaction_id
    FROM compute.protected_office_sets WHERE set_id=$1`, [plan.set.setId]), "protected office restarted set")[0];
  let identities = row?.healthy_identities;
  if (typeof identities === "string") identities = JSON.parse(identities);
  const expected = new Map(plan.set.profiles.map((profile) => [profile.workerId, profile]));
  return row?.node_id === plan.target.nodeId
    && Number(row.desired_state_revision) === before.desiredStateRevision
    && Number(row.observed_state_revision) === before.observedStateRevision
    && row.last_transaction_id === before.lastTransactionId
    && Number(row.maintenance_generation) === plan.set.maintenanceGeneration
    && row.recovery_state === "healthy" && Array.isArray(identities) && identities.length === expected.size
    && new Set(identities.map((identity) => identity?.workerId)).size === expected.size
    && identities.every((identity) => {
      const profile = expected.get(identity?.workerId);
      const imageDigest = /^.+@(sha256:[a-f0-9]{64})$/.exec(profile?.imageReference ?? "")?.[1];
      return profile && identity.modelProfileId === profile.modelProfileId
        && identity.imageDigest === imageDigest
        && identity.configurationDigest === profile.configurationDigest
        && identity.maintenanceGeneration === plan.set.maintenanceGeneration && identity.healthy === true;
    });
}

function canonicalFaultController({ database, qualificationId, qualificationDigest, protectedTargetPolicyDigest }) {
  return Object.freeze({
    async executeMidSequenceFailure(request) {
      object(request, "protected office qualification fault request");
      const { plan, manifest, maintenanceContext, coordinator, nodeAgentRuntime } = request;
      const declaration = plan?.qualification?.faultInjection;
      const profile = plan?.set?.profiles?.find((item) => item.slot === declaration?.slot);
      if (!RUN_ID.test(request.runId ?? "") || !UUID.test(request.actionId ?? "")
          || !SHA256.test(request.idempotencyKey ?? "") || plan?.deploymentId !== "teamaibox.protected-office-set-deployment.v5"
          || declaration?.expectedFailureCode !== "protected_set_transition_stage_failed"
          || declaration?.requiresNodeAgentJournal !== true || declaration?.requiresAutomaticExactRollback !== true
          || declaration?.oomAllowed !== false || !Number.isSafeInteger(declaration?.failAfterStageOrder)
          || profile?.targetKey !== "office.drawing-flux2"
          || profile.stageOrder !== declaration.failAfterStageOrder + 1
          || manifest?.setId !== plan.set.setId || manifest?.nodeId !== plan.target.nodeId
          || manifest?.maintenanceGeneration !== plan.set.maintenanceGeneration
          || !Number.isSafeInteger(manifest?.desiredStateRevision) || manifest.desiredStateRevision < plan.set.desiredStateRevision
          || !Array.isArray(manifest?.profiles) || manifest.profiles.length !== 6
          || !UUID.test(maintenanceContext?.transactionId ?? "")
          || maintenanceContext?.maintenanceGeneration !== plan.set.maintenanceGeneration
          || !Array.isArray(maintenanceContext?.workerIds) || maintenanceContext.workerIds.length !== 6
          || !sameJson(maintenanceContext.workerIds, plan.set.profiles.map((item) => item.workerId).sort())
          || !sameJson(maintenanceContext.allowedOperations, ["protected-set.maintenance"])
          || typeof coordinator?.boot !== "function"
          || typeof nodeAgentRuntime?.inspectProtectedSetQualificationFault !== "function") {
        throw new TypeError("protected office qualification fault binding is invalid");
      }
      const faultInjection = Object.freeze({
        stageOrder: profile.stageOrder, targetKey: profile.targetKey,
        injectionPoint: "after-stage-health", failureCode: declaration.expectedFailureCode, oneShot: true,
      });
      const qualificationFault = Object.freeze({
        qualificationId, qualificationDigest, protectedTargetPolicyDigest, faultInjection,
      });
      const existing = rows(await database.query(`SELECT id,set_id,node_id,desired_state_revision,
          maintenance_generation,transaction_state,failure_code
        FROM compute.protected_office_set_transactions WHERE id=$1`,
      [maintenanceContext.transactionId]), "protected office qualification transaction")[0];
      if (existing == null) {
        let observedError;
        try {
          const result = await coordinator.boot({ manifest: structuredClone(manifest),
            maintenanceContext: structuredClone(maintenanceContext), qualificationFault });
          throw new TypeError(`protected office qualification fault unexpectedly returned ${result?.state ?? "unknown"}`);
        } catch (error) {
          observedError = error;
        }
        // A lost mTLS response can hide the expected Agent error. The following
        // read-only, policy-bound inspection is the authority in that case.
        // Baseline rejection happens before the Agent transition is dispatched;
        // inspecting a nonexistent fault journal would hide the actual cause.
        if (observedError?.code === "protected_set_qualification_baseline_drift") throw observedError;
        if (observedError instanceof TypeError
            && /unexpectedly returned/.test(observedError.message ?? "")) throw observedError;
      }
      const inspection = await nodeAgentRuntime.inspectProtectedSetQualificationFault({
        transactionId: maintenanceContext.transactionId, ...qualificationFault,
      });
      const transaction = rows(await database.query(`SELECT id,set_id,node_id,desired_state_revision,
          maintenance_generation,transaction_state,failure_code
        FROM compute.protected_office_set_transactions WHERE id=$1`,
      [maintenanceContext.transactionId]), "protected office qualification transaction")[0];
      if (!transaction || transaction.id !== maintenanceContext.transactionId
          || transaction.set_id !== manifest.setId || transaction.node_id !== manifest.nodeId
          || Number(transaction.desired_state_revision) !== manifest.desiredStateRevision
          || Number(transaction.maintenance_generation) !== manifest.maintenanceGeneration
          || transaction.transaction_state !== "rolled-back"
          || inspection?.runtimeState !== "canonical-exact"
          || inspection?.journal?.phase !== "recovered"
          || inspection.journal.failureCode !== declaration.expectedFailureCode
          || inspection.journal.faultInjectionConsumed !== true
          || inspection.oomKilled !== false) {
        throw new TypeError("protected office qualification fault did not durably roll back the canonical set");
      }
      return Object.freeze({
        observedFailureCode: declaration.expectedFailureCode,
        failedTransactionId: transaction.id,
        failedJournalRevision: inspection.journal.journalRevision,
        oomKilled: false,
      });
    },
  });
}

function restartBoundary(request, action, state) {
  return Object.freeze({
    schemaVersion: 1, protocol: RESTART_PROTOCOL, phase: "restart-requested",
    runId: request.runId, action: "restart-verify", actionId: request.actionId,
    idempotencyKey: request.idempotencyKey, requestPersisted: true, replayRequired: true,
    restartTargets: [...RESTART_TARGETS], mutationAuthority: "node-agent-mtls-hmac",
    dockerMutationAuthority: "node-agent-only", lifecycleCommandType: RESTART_COMMAND_TYPE,
    lifecycleCommandId: request.lifecycleCommandId, operationOrder: [...RESTART_OPERATION_ORDER],
    lifecycleJournalFsyncedBeforeMutation: state.journalRevisions.prepared >= 1,
    lifecycleJournalRevision: state.journalRevisions.prepared,
    requestDigest: request.requestDigest, requestedAt: action.createdAt,
  });
}

function lifecycleClient({ database, nodeAgentRouter, plan, policyDigest, clock }) {
  const execute = async (request, action) => nodeAgentRouter.executeApplianceRuntimeRestart({
    nodeId: plan.target.nodeId, nodeGeneration: plan.target.nodeGeneration,
    restartId: request.lifecycleCommandId, journalRevision: 1, policyDigest,
    idempotencyKey: request.idempotencyKey, issuedAt: action.createdAt,
    deadlineAt: new Date(new Date(action.createdAt).getTime() + MAXIMUM_RESTART_WINDOW_MILLISECONDS).toISOString(),
    correlationId: `protected-office:restart:${request.actionId}`,
  });
  const completed = async (request, action, state) => {
    if (state.phase !== "complete") return Object.freeze({ phase: "restart-requested" });
    const platformBefore = restartObservation(state.pre?.platform, plan.target.platformIdentity,
      "protected office pre-Platform restart");
    const platformAfter = restartObservation(state.post?.platform, plan.target.platformIdentity,
      "protected office post-Platform restart");
    const nodeAgentBefore = restartObservation(state.pre?.nodeAgent, plan.target.nodeAgentIdentity,
      "protected office pre-Node-Agent restart");
    const nodeAgentAfter = restartObservation(state.post?.nodeAgent, plan.target.nodeAgentIdentity,
      "protected office post-Node-Agent restart");
    if (new Date(platformAfter.startedAt) <= new Date(platformBefore.startedAt)
        || new Date(nodeAgentAfter.startedAt) <= new Date(nodeAgentBefore.startedAt)) {
      throw new TypeError("protected office restart did not advance both runtime start times");
    }
    const [before, after, desiredStateRecovered] = await Promise.all([
      restartSessionCounts(database, plan, action.createdAt),
      restartSessionCounts(database, plan, iso(clock(), "protected office restart recovery time")),
      exactRestartedSet(database, plan, request.runId),
    ]);
    if (before.casting !== 0 || before.media !== 0 || after.casting !== 0 || after.media !== 0
        || desiredStateRecovered !== true || action.recoveryCount < 1 || action.revision <= 1) {
      throw new TypeError("protected office restart recovery facts are incomplete");
    }
    return Object.freeze({
      phase: "complete", restartBoundary: restartBoundary(request, action, state),
      platformBefore, platformAfter, nodeAgentBefore, nodeAgentAfter,
      lifecycleCommandId: request.lifecycleCommandId,
      platformOperationId: request.platformOperationId, nodeAgentOperationId: request.nodeAgentOperationId,
      journalRevisionBefore: 1, journalRevisionAfter: action.revision,
      lifecycleJournalRevisionBefore: state.journalRevisions.prepared,
      lifecycleJournalRevisionAfter: state.journalRevisions.complete,
      journalRecovered: true, lifecycleJournalRecovered: true,
      desiredStateRecovered: true, exactIdentityRetained: true,
      activeCastingSessionsBefore: before.casting, activeCastingSessionsAfter: after.casting,
      activeMediaReservationsBefore: before.media, activeMediaReservationsAfter: after.media,
    });
  };
  return Object.freeze({
    async inspect(input) {
      const request = restartRequest(input, plan);
      const action = await restartAction(database, request);
      if (action.recoveryCount === 0 && action.state === "running" && action.revision === 1) {
        return Object.freeze({ phase: "ready" });
      }
      return completed(request, action, await execute(request, action));
    },
    async beginPlatformRestart(input) {
      const request = restartRequest(input, plan, { identities: true });
      const action = await restartAction(database, request);
      if (action.state !== "running" || action.recoveryCount !== 0 || action.revision !== 1) {
        throw new TypeError("protected office restart may begin only from its first durable action revision");
      }
      const before = await restartSessionCounts(database, plan, action.createdAt);
      if (before.casting !== 0 || before.media !== 0) {
        throw new TypeError("protected office restart requires an exact inactive media baseline");
      }
      const state = await execute(request, action);
      if (state.phase !== "agent_restart_armed") {
        throw new TypeError("protected office restart completed without disconnecting the initiating Platform process");
      }
      // The real Platform container is restarted before the Node Agent can arm
      // its own restart. If this JavaScript frame still exists after receiving
      // the durable response, keep the action open; a normal return would let
      // the pre-restart process claim its own recovery.
      return new Promise(() => {});
    },
    async recoverPlatformRestart(input) {
      const request = restartRequest(input, plan, { identities: true });
      const action = await restartAction(database, request);
      if (action.state !== "recovering" || action.recoveryCount < 1 || action.revision <= 1) {
        throw new TypeError("protected office restart recovery requires the durable recovering action journal");
      }
      return completed(request, action, await execute(request, action));
    },
  });
}

/**
 * Builds the mandatory production adapters. No adapter manufactures a
 * success result: PostgreSQL, authenticated Node-Agent calls, strict process
 * execution and public HTTPS are the only authorities.
 */
export async function createProtectedOfficeSetProductionBoundaryFromEnvironment(environment = process.env, services = {}) {
  if (!services.database?.query || !services.database?.transaction
      || typeof services.nodeAgentRouter?.inspectAppliance !== "function"
      || !services.jobService?.submit || !services.jobService?.get
      || typeof services.objectService?.createObjectHandoffGateway !== "function"
      || typeof services.audit !== "function" || typeof services.fetcher !== "function") {
    throw new TypeError("protected office production boundary services are incomplete");
  }
  if (REQUIRED_ROUTER_METHODS.some((method) => typeof services.nodeAgentRouter[method] !== "function")) {
    throw new TypeError("managed Node Agent router lacks protected office lifecycle/fault production methods");
  }
  const configFile = environment.PLATFORM_PROTECTED_OFFICE_SET_PRODUCTION_BOUNDARY_CONFIG_FILE;
  const credentialFile = environment.PLATFORM_PROTECTED_OFFICE_SET_PROBE_CREDENTIAL_FILE;
  const restartPolicyDigest = environment.PLATFORM_PROTECTED_OFFICE_SET_RESTART_POLICY_DIGEST;
  const qualificationId = environment.PLATFORM_PROTECTED_OFFICE_SET_QUALIFICATION_ID;
  const qualificationDigest = environment.PLATFORM_PROTECTED_OFFICE_SET_QUALIFICATION_POLICY_DIGEST;
  const protectedTargetPolicyDigest = environment.PLATFORM_PROTECTED_OFFICE_SET_TARGET_POLICY_DIGEST;
  if (configFile !== ABSOLUTE_BOUNDARY_CONFIG || credentialFile !== ABSOLUTE_PROBE_CREDENTIAL) {
    throw new TypeError("protected office production boundary file environment is not exact");
  }
  if (!SHA256.test(restartPolicyDigest ?? "") || !/^[a-z][a-z0-9_.-]{2,127}$/.test(qualificationId ?? "")
      || !SHA256.test(qualificationDigest ?? "") || !SHA256.test(protectedTargetPolicyDigest ?? "")) {
    throw new TypeError("protected office lifecycle/qualification policy binding is invalid");
  }
  const fileSystem = services.fileSystem ?? defaultFileSystem;
  const [configValue, plan] = await Promise.all([
    jsonDocument(configFile, "protected office production boundary config", fileSystem),
    jsonDocument(services.bundle?.planFile, "protected office production boundary plan", fileSystem),
    probeCredential(credentialFile, fileSystem),
  ]);
  const config = boundaryConfig(configValue);
  if (plan?.deploymentId !== "teamaibox.protected-office-set-deployment.v5"
      || plan?.target?.nodeId !== environment.PLATFORM_PROTECTED_OFFICE_SET_NODE_ID
      || String(plan?.target?.nodeGeneration) !== environment.PLATFORM_PROTECTED_OFFICE_SET_NODE_GENERATION
      || !Array.isArray(plan?.set?.profiles) || plan.set.profiles.length !== 6) {
    throw new TypeError("protected office production boundary plan identity drifted");
  }
  const placementRepository = new PostgresAppliancePlacementRepository({ database: services.database, localNodeId: plan.target.nodeId });
  const metricRepository = new PostgresClusterMetricRepository({ database: services.database });
  const clock = services.clock ?? (() => new Date());
  const idFactory = services.idFactory ?? randomUUID;
  const connectOrigin = environment.PLATFORM_PROTECTED_OFFICE_SET_HTTPS_CONNECT_ORIGIN;
  const caFile = environment.PLATFORM_PROTECTED_OFFICE_SET_HTTPS_CA_FILE;
  if (Boolean(connectOrigin) !== Boolean(caFile)) {
    throw new TypeError("protected office internal HTTPS connection binding must be complete");
  }
  const scenarioFetcher = connectOrigin
    ? await pinnedPublicHttpsFetcher({
      connectOrigin,
      publicOrigin: services.publicOrigin,
      caFile,
      fileSystem,
      request: services.httpsRequest ?? httpsRequest,
    })
    : services.fetcher;
  const ocrReferenceIssuer = protectedOcrReferenceIssuer({
    database: services.database,
    objectService: services.objectService,
    clock,
  });
  return Object.freeze({
    leaseAuthorityProvider: leaseAuthorityProvider(services.database),
    realtimePlacementResolver: realtimeResolver({ config, plan, placementRepository }),
    coreServiceProbe: coreServiceProbe({ database: services.database, metricRepository,
      nodeAgentRouter: services.nodeAgentRouter, maximumAgeMilliseconds: config.coreProbe.maximumAgeMilliseconds,
      requiredServiceKeys: config.coreProbe.requiredServiceKeys, clock }),
    requiredCoreServiceKeys: config.coreProbe.requiredServiceKeys,
    validatorRunner: validatorRunner(services.execFile ?? nodeExecFile),
    publicHttpsInspectionFetcher: scenarioFetcher,
    publicHttpsScenarioClient: publicHttpsClient({
      config, plan, fetcher: scenarioFetcher, credentialFile, fileSystem, ocrReferenceIssuer,
    }),
    maintenanceContextAllocator: maintenanceAllocator({ database: services.database,
      nodeId: plan.target.nodeId, nodeGeneration: plan.target.nodeGeneration, clock, idFactory }),
    platformLifecycleClient: lifecycleClient({ database: services.database, nodeAgentRouter: services.nodeAgentRouter,
      plan, policyDigest: restartPolicyDigest, clock }),
    faultController: canonicalFaultController({ database: services.database, qualificationId,
      qualificationDigest, protectedTargetPolicyDigest }),
  });
}

export const protectedOfficeSetProductionBoundaryContract = Object.freeze({
  configPath: ABSOLUTE_BOUNDARY_CONFIG,
  probeCredentialPath: ABSOLUTE_PROBE_CREDENTIAL,
  requiredRouterMethods: REQUIRED_ROUTER_METHODS,
  adapters: Object.freeze([
    "leaseAuthorityProvider", "realtimePlacementResolver", "coreServiceProbe", "requiredCoreServiceKeys", "validatorRunner",
    "publicHttpsInspectionFetcher", "publicHttpsScenarioClient", "maintenanceContextAllocator",
    "platformLifecycleClient", "faultController",
  ]),
  successFallbacks: false,
});
