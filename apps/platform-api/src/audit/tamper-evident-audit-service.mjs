import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  currentCorrelationId,
  PlatformError,
  redact,
} from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION = /^[a-z][a-z0-9_.:-]{1,255}$/;
const STABLE = /^[A-Za-z0-9][A-Za-z0-9._:/@+ -]{0,511}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SIGNATURE = /^hmac-sha256:[a-f0-9]{64}$/;
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DOMAINS = Object.freeze(["identity", "data", "plugin", "model", "provider", "routing", "agent_confirmation", "source", "security", "key", "backup", "update", "administrator"]);
const DOMAIN_SET = new Set(DOMAINS);
const OUTCOMES = new Set(["succeeded", "failed", "denied"]);
const ACTOR_KINDS = new Set(["user", "administrator", "service", "system"]);
const TOP_LEVEL = new Set(["action", "event", "operation", "eventId", "occurredAt", "actorIdentityId", "actorId", "ownerIdentityId", "operatorId", "actorKind", "domain", "outcome", "correlationId", "resource", "resourceKind", "resourceId"]);
const SENSITIVE_NAME = /(?:password|passphrase|authorization|cookie|private|plaintext|prompt|content|body|message|filename|filePath|endpoint|url|uri|command|stdout|stderr)|(?:^|_)(?:secret|token|credential|key_material)(?:$|_)|(?:Secret|Token|Credential|KeyMaterial)$/i;
const SAFE_METADATA_NAME = /(?:(?:^|_)(?:id|ids|key|keys|kind|digest|digests|fingerprint|version|revision|state|status|outcome|reason|code|count|bytes|milliseconds|seconds|at|permission|scope|operation|action|mode|environment|architecture|ecosystem|disposition|tool|enabled|configured|success|passed|retryable|automatic|stage|slot|class|type|attempt|sequence|generation|priority|direction|lifecycle|from|to)(?:$|_)|(?:Id|Ids|Key|Keys|Kind|Digest|Digests|Fingerprint|Version|Revision|State|Status|Outcome|Reason|Code|Count|Bytes|Milliseconds|Seconds|At|Permission|Scope|Operation|Action|Mode|Environment|Architecture|Ecosystem|Disposition|Tool|Enabled|Configured|Success|Passed|Retryable|Automatic|Stage|Slot|Class|Type|Attempt|Sequence|Generation|Priority|Direction|Lifecycle|From|To)$)/;
const RESOURCE_FIELDS = Object.freeze([
  ["providerId", "provider"], ["pluginId", "plugin"], ["profileId", "model_profile"], ["modelProfileId", "model_profile"],
  ["policyId", "policy"], ["sourceId", "software_source"], ["storagePoolId", "storage_pool"], ["poolId", "storage_pool"],
  ["objectId", "object"], ["artifactId", "artifact"], ["fileId", "file"], ["entryId", "file_entry"], ["jobId", "job"],
  ["operationId", "agent_operation"], ["identityId", "identity"], ["ownerIdentityId", "identity"], ["nodeId", "node"],
  ["recoveryId", "recovery"], ["planId", "security_plan"], ["sandboxId", "agent_sandbox"], ["sessionId", "session"],
  ["conversationId", "conversation"], ["exportId", "diagnostic_export"], ["requestId", "request"],
]);

function fail(code, message, status = 400) { throw new PlatformError(code, message, { status }); }
function date(value, fallback) { const result = value == null ? new Date(fallback) : new Date(value); if (!Number.isFinite(result.getTime())) throw new TypeError("audit occurredAt is invalid"); return result; }
function stable(value, name, maximum = 512) { if (typeof value !== "string" || value.length > maximum || !STABLE.test(value)) throw new TypeError(`${name} is invalid`); return value; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function serialized(value) { return JSON.stringify(canonical(value)); }
function hashPayload(event, previousEventHash) { return `sha256:${createHash("sha256").update(serialized({ event, previousEventHash })).digest("hex")}`; }
function scalar(value) {
  const safe = redact(value);
  if (safe === null || typeof safe === "boolean") return safe;
  if (typeof safe === "number" && Number.isFinite(safe) && Math.abs(safe) <= Number.MAX_SAFE_INTEGER) return safe;
  if (safe instanceof Date) return safe.toISOString();
  if (typeof safe === "string" && safe.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(safe)) return safe;
  if (Array.isArray(safe) && safe.length <= 64) {
    const values = safe.map(scalar);
    return values.some((item) => item === undefined) ? undefined : values;
  }
  return undefined;
}

export function projectAuditMetadata(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("audit event must be an object");
  const output = {};
  for (const [name, value] of Object.entries(input)) {
    if (TOP_LEVEL.has(name) || SENSITIVE_NAME.test(name) || !SAFE_METADATA_NAME.test(name)) continue;
    const projected = scalar(value);
    if (projected !== undefined) output[name] = projected;
    if (Object.keys(output).length >= 64) break;
  }
  return Object.freeze(output);
}

export function classifyAuditDomain(action) {
  if (/^agent\.operation_/.test(action)) return "agent_confirmation";
  if (/^(?:identity\.|auth(?:entication)?\.|authorization\.|credential\.|api_credential\.|session\.)/.test(action)) return "identity";
  if (/^(?:files\.|file\.|object\.|artifact\.|storage\.|messaging\.|team_drive\.|external_object\.)/.test(action)) return "data";
  if (/^(?:plugin\.|plugins\.|sandbox\.|register-compute-capabilities|retire-compute-capabilities|revoke-plugin-delegations|delegated)/.test(action)) return "plugin";
  if (/^(?:model)/.test(action)) return "model";
  if (/^(?:provider\.|compute\.external|external_provider\.|external_usage\.)/.test(action)) return "provider";
  if (/^routing/.test(action)) return "routing";
  if (/^(?:source|pip_gateway\.|npm_gateway\.|apt_gateway\.|agent\.egress_)/.test(action)) return "source";
  if (/^(?:security\.|unlock\.|usb\.|luks)/.test(action)) return "security";
  if (/^(?:secret\.|key\.|encryption_key\.)/.test(action)) return "key";
  if (/^backup\./.test(action)) return "backup";
  if (/^(?:update\.|platform_update\.|host_maintenance\.)/.test(action)) return "update";
  return "administrator";
}

function actionFor(input) {
  const value = [input.action, input.event, input.operation].find((item) => typeof item === "string" && ACTION.test(item));
  if (!value) throw new TypeError("audit action is invalid");
  return value;
}
function outcomeFor(input, action) {
  if (OUTCOMES.has(input.outcome)) return input.outcome;
  if (input.success === false || /(?:^|[._-])failed$/.test(action)) return "failed";
  if (/(?:^|[._-])denied$/.test(action) || /(?:^|[._-])rejected$/.test(action)) return "denied";
  return "succeeded";
}
function actorFor(input, domain) {
  const candidate = [input.actorIdentityId, input.actorId, input.ownerIdentityId, input.operatorId].find((item) => UUID.test(item ?? ""));
  const kind = ACTOR_KINDS.has(input.actorKind) ? input.actorKind : candidate ? (domain === "administrator" || domain === "provider" || domain === "routing" || domain === "source" || domain === "security" || domain === "backup" || domain === "update" ? "administrator" : "user") : "system";
  return Object.freeze({ identityId: candidate?.toLowerCase() ?? null, kind });
}
function resourceFor(input, domain, action) {
  if (input.resource && typeof input.resource === "object" && !Array.isArray(input.resource)) {
    const key = input.resource.id ?? input.resource.key;
    if (typeof input.resource.kind === "string" && typeof key === "string") return Object.freeze({ kind: stable(input.resource.kind, "resource.kind", 128), id: stable(key, "resource.id") });
  }
  if (typeof input.resourceKind === "string" && typeof input.resourceId === "string") return Object.freeze({ kind: stable(input.resourceKind, "resourceKind", 128), id: stable(input.resourceId, "resourceId") });
  for (const [field, kind] of RESOURCE_FIELDS) if (typeof input[field] === "string" && STABLE.test(input[field])) return Object.freeze({ kind, id: input[field] });
  for (const field of ["providerKey", "pluginKey", "profileKey", "policyKey", "sourceKey", "nodeKey", "name"]) {
    if (typeof input[field] === "string" && STABLE.test(input[field])) return Object.freeze({ kind: domain, id: input[field] });
  }
  return Object.freeze({ kind: domain, id: action });
}
function requireViewer(context) {
  const identityId = context?.identityId ?? context?.identity?.id;
  if (!UUID.test(identityId ?? "")) fail("invalid_session", "Authentication is required", 401);
  if (!context.permissions?.includes("audit:view")) fail("audit_permission_required", "Audit view permission is required", 403);
}
function publicEvent(value) { const { canonicalEvent: _canonicalEvent, ...safe } = structuredClone(value); return Object.freeze({ ...safe, occurredAt: new Date(value.occurredAt).toISOString() }); }

export class HmacAuditSigner {
  #key;
  constructor({ key, keyId = "audit.primary.v1" }) {
    if (!(key instanceof Uint8Array) || key.byteLength < 32 || key.byteLength > 128 || !/^[a-z][a-z0-9._-]{2,127}$/.test(keyId)) throw new TypeError("audit signer key is invalid");
    this.#key = Buffer.from(key); this.keyId = keyId; this.algorithm = "hmac-sha256";
  }
  async sign(eventHash) { if (!SHA256.test(eventHash ?? "")) throw new TypeError("audit event hash is invalid"); return `hmac-sha256:${createHmac("sha256", this.#key).update(eventHash).digest("hex")}`; }
  async signCheckpoint(eventHash) {
    return Object.freeze({ algorithm: this.algorithm, keyId: this.keyId, signature: await this.sign(eventHash) });
  }
  async verify(eventHash, signature, keyId = this.keyId) {
    if (keyId !== this.keyId || !SHA256.test(eventHash ?? "") || !SIGNATURE.test(signature ?? "")) return false;
    const expected = Buffer.from((await this.sign(eventHash)).slice(12), "hex"), actual = Buffer.from(signature.slice(12), "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  close() { this.#key.fill(0); }
}

export class HmacAuditKeyring {
  #keys = new Map(); #activeKeyId;
  constructor({ keys, activeKeyId }) {
    if (!keys || typeof keys !== "object" || Array.isArray(keys) || Object.keys(keys).length < 1 || Object.keys(keys).length > 16) throw new TypeError("audit keyring is invalid");
    for (const [keyId, key] of Object.entries(keys)) {
      if (!/^[a-z][a-z0-9._-]{2,127}$/.test(keyId) || !(key instanceof Uint8Array) || key.byteLength < 32 || key.byteLength > 128) throw new TypeError("audit keyring entry is invalid");
      this.#keys.set(keyId, Buffer.from(key));
    }
    if (!this.#keys.has(activeKeyId)) throw new TypeError("active audit key is unavailable");
    this.#activeKeyId = activeKeyId; this.algorithm = "hmac-sha256";
  }
  get keyId() { return this.#activeKeyId; }
  activate(keyId) { if (!this.#keys.has(keyId)) throw new TypeError("audit key is unavailable"); this.#activeKeyId = keyId; }
  async sign(eventHash) {
    return (await this.signCheckpoint(eventHash)).signature;
  }
  async signCheckpoint(eventHash) {
    if (!SHA256.test(eventHash ?? "")) throw new TypeError("audit event hash is invalid");
    const keyId = this.#activeKeyId, key = this.#keys.get(keyId);
    const signature = `hmac-sha256:${createHmac("sha256", key).update(eventHash).digest("hex")}`;
    return Object.freeze({ algorithm: this.algorithm, keyId, signature });
  }
  async verify(eventHash, signature, keyId) {
    const key = this.#keys.get(keyId);
    if (!key || !SHA256.test(eventHash ?? "") || !SIGNATURE.test(signature ?? "")) return false;
    const expected = createHmac("sha256", key).update(eventHash).digest(), actual = Buffer.from(signature.slice(12), "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  close() { for (const key of this.#keys.values()) key.fill(0); this.#keys.clear(); }
}

export class TamperEvidentAuditService {
  #repository; #signer; #clock; #idFactory;
  constructor({ repository, signer, clock = () => new Date(), idFactory = randomUUID }) {
    if (!repository || ["head", "append", "list", "scan"].some((method) => typeof repository[method] !== "function") || typeof signer?.signCheckpoint !== "function" || typeof signer.verify !== "function" || typeof clock !== "function" || typeof idFactory !== "function") throw new TypeError("tamper-evident audit dependencies are incomplete");
    this.#repository = repository; this.#signer = signer; this.#clock = clock; this.#idFactory = idFactory;
  }

  async record(input) {
    const action = actionFor(input), domain = input.domain == null ? classifyAuditDomain(action) : input.domain;
    if (!DOMAIN_SET.has(domain)) throw new TypeError("audit domain is invalid");
    // A durable producer may supply its own UUID (for example an outbox event
    // id).  The audit table's existing UNIQUE(event_id) constraint then acts
    // as the cross-process idempotency fence.  Ordinary callers keep the
    // original random-id behaviour.
    const eventId = input.eventId ?? this.#idFactory();
    if (!UUID.test(eventId ?? "")) throw new TypeError("audit event identifier must be a UUID");
    const occurredAt = date(input.occurredAt, this.#clock()).toISOString();
    const correlationId = input.correlationId ?? currentCorrelationId() ?? eventId;
    const event = Object.freeze({ schemaVersion: 1, eventId: eventId.toLowerCase(), occurredAt, actor: actorFor(input, domain), action, domain,
      outcome: outcomeFor(input, action), resource: resourceFor(input, domain, action), correlationId: stable(correlationId, "correlationId", 384), metadata: projectAuditMetadata(input) });
    for (let attempt = 0; attempt < 1024; attempt += 1) {
      const head = await this.#repository.head(), previousEventHash = head?.eventHash ?? null, eventHash = hashPayload(event, previousEventHash);
      const checkpoint = await this.#signer.signCheckpoint(eventHash);
      if (checkpoint?.algorithm !== "hmac-sha256" || !/^[a-z][a-z0-9._-]{2,127}$/.test(checkpoint.keyId ?? "") || !SIGNATURE.test(checkpoint.signature ?? "")) {
        throw new TypeError("audit signer checkpoint is invalid");
      }
      const result = await this.#repository.append({ event, previousEventHash, eventHash, checkpoint });
      if (result) return publicEvent(result);
    }
    fail("audit_chain_conflict", "Audit chain changed too frequently", 503);
  }

  async listEvents({ context, domain = null, correlationId = null, cursor = null, limit = 100 }) {
    requireViewer(context);
    if (domain !== null && !DOMAIN_SET.has(domain)) fail("audit_domain_invalid", "Audit domain is invalid");
    if (correlationId !== null && !CORRELATION.test(correlationId)) fail("audit_correlation_invalid", "Audit correlation identifier is invalid");
    const afterSequence = cursor === null || cursor === "" ? null : Number(cursor);
    if (afterSequence !== null && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) fail("audit_cursor_invalid", "Audit cursor is invalid");
    const boundedLimit = Number(limit); if (!Number.isInteger(boundedLimit) || boundedLimit < 1 || boundedLimit > 500) fail("audit_limit_invalid", "Audit limit is invalid");
    const values = await this.#repository.list({ domain, correlationId, afterSequence, limit: boundedLimit + 1 });
    return Object.freeze({ object: "list", data: Object.freeze(values.slice(0, boundedLimit).map(publicEvent)), hasMore: values.length > boundedLimit,
      nextCursor: values.length > boundedLimit ? String(values[boundedLimit - 1].sequenceId) : null });
  }

  async verifyChain({ context }) {
    requireViewer(context);
    // Verify an immutable prefix captured before scanning. Legitimate appends
    // can continue while pages are read; comparing against a newer head after
    // the last page incorrectly reports those appends as tampering.
    const head = await this.#repository.head();
    if (head !== null && (!Number.isSafeInteger(head?.sequenceId) || head.sequenceId < 1
        || !SHA256.test(head.eventHash ?? ""))) throw new TypeError("audit repository head is invalid");
    const throughSequence = head?.sequenceId ?? 0;
    let afterSequence = 0, previousEventHash = null, verifiedEvents = 0, last = null;
    for (;;) {
      const batch = await this.#repository.scan({ afterSequence, throughSequence, limit: 1000 });
      if (!Array.isArray(batch) || batch.length > 1000) throw new TypeError("audit repository scan is invalid");
      for (const value of batch) {
        if (!Number.isSafeInteger(value.sequenceId) || value.sequenceId <= afterSequence
            || value.sequenceId > throughSequence) throw new TypeError("audit repository scan crossed its captured head");
        const expectedHash = hashPayload(value.canonicalEvent, previousEventHash);
        let reasonCode = null;
        if (value.previousEventHash !== previousEventHash) reasonCode = "previous_hash_mismatch";
        else if (value.eventHash !== expectedHash) reasonCode = "event_hash_mismatch";
        else if (!await this.#signer.verify(value.eventHash, value.checkpoint.signature, value.checkpoint.keyId)) reasonCode = "checkpoint_signature_invalid";
        if (reasonCode) return Object.freeze({ valid: false, verifiedEvents, failedSequenceId: value.sequenceId, reasonCode, headEventHash: previousEventHash, verifiedAt: this.#clock().toISOString() });
        previousEventHash = value.eventHash; afterSequence = value.sequenceId; verifiedEvents += 1; last = value;
      }
      if (batch.length < 1000) break;
      // Bound each page's memory/work, not the lifetime number of events.
      // Yield even when the repository and signer resolve synchronously.
      await new Promise((resolve) => setImmediate(resolve));
    }
    if ((head?.eventHash ?? null) !== (last?.eventHash ?? null)
        || (last?.sequenceId ?? 0) !== throughSequence) return Object.freeze({ valid: false, verifiedEvents, failedSequenceId: head?.sequenceId ?? null, reasonCode: "head_mismatch", headEventHash: last?.eventHash ?? null, verifiedAt: this.#clock().toISOString() });
    return Object.freeze({ valid: true, verifiedEvents, failedSequenceId: null, reasonCode: null, headEventHash: last?.eventHash ?? null, verifiedAt: this.#clock().toISOString() });
  }
}

export const auditDomains = DOMAINS;
