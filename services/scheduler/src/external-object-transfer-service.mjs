import { createHash, randomBytes, randomUUID } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]+)?$/i;
const MAX_LIFETIME_MS = 15 * 60 * 1000;

function fail(code, message, status = 400, retryable = false) {
  throw new PlatformError(code, message, { status, retryable });
}

function id(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) fail("external_object_grant_invalid", `${label} is invalid`);
  return value.toLowerCase();
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function contentDigest(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function expiry(clock, leaseExpiresAt) {
  const now = clock();
  const lease = new Date(leaseExpiresAt);
  if (!Number.isFinite(lease.getTime()) || lease <= now) {
    fail("external_object_grant_window_invalid", "External object grant requires a live attempt lease", 409, true);
  }
  return new Date(Math.min(lease.getTime(), now.getTime() + MAX_LIFETIME_MS));
}

function origin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/"
      || parsed.search || parsed.hash) {
    throw new TypeError("external object proxy public origin must be an HTTPS origin");
  }
  return parsed.origin;
}

function ticket() { return randomBytes(32).toString("base64url"); }

function artifact(value) {
  const object = value?.object;
  if (!value || typeof value.role !== "string" || value.role.length < 1 || value.role.length > 128
      || !UUID.test(object?.objectId ?? "") || !Number.isSafeInteger(object?.objectVersion)
      || object.objectVersion < 1 || !SHA256.test(object?.sha256 ?? "")
      || !Number.isSafeInteger(object?.size) || object.size < 1
      || typeof object?.mediaType !== "string" || !MEDIA_TYPE.test(object.mediaType)) {
    fail("external_object_grant_invalid", "External input artifact is invalid");
  }
  return value;
}

function safeContentType(value) {
  if (typeof value !== "string" || value.length > 255 || !MEDIA_TYPE.test(value)) {
    fail("external_object_grant_invalid", "External output media type is invalid");
  }
  return value.toLocaleLowerCase("en-US");
}

function safeSuffix(value) {
  if (value === undefined || value === null || value === "") return "bin";
  if (typeof value !== "string" || !/^[a-z0-9]{1,16}$/i.test(value)) {
    fail("external_object_grant_invalid", "External output filename suffix is invalid");
  }
  return value.toLocaleLowerCase("en-US");
}

function liveGrant(value, operation, now) {
  if (!value || value.state !== "active" || new Date(value.expiresAt) <= now
      || !value.operations.includes(operation) || value.useCount >= value.maximumUses) {
    fail("external_object_reference_invalid", "External object reference is invalid or expired", 404);
  }
  return value;
}

/**
 * Issues attempt-bound bearer URLs without exposing object keys, namespaces, or storage credentials.
 * The URL token is stored only as a SHA-256 digest and can be revoked independently of the object.
 */
export class ExternalObjectTransferService {
  #repository;
  #objects;
  #publicOrigin;
  #clock;
  #idFactory;
  #audit;

  constructor({ repository, objectGateway, publicOrigin, clock = () => new Date(), idFactory = randomUUID, audit = async () => {} }) {
    const repositoryMethods = ["create", "findByTicketDigest", "authorize", "completeOutput", "failOutput", "revokeAttempt"];
    const gatewayMethods = ["issue", "revoke", "head", "download", "storeOutput"];
    if (!repository || repositoryMethods.some((method) => typeof repository[method] !== "function")) {
      throw new TypeError("external object grant repository is incomplete");
    }
    if (!objectGateway || gatewayMethods.some((method) => typeof objectGateway[method] !== "function")) {
      throw new TypeError("external object handoff gateway is incomplete");
    }
    if (typeof clock !== "function" || typeof idFactory !== "function" || typeof audit !== "function") {
      throw new TypeError("external object transfer dependencies are invalid");
    }
    this.#repository = repository;
    this.#objects = objectGateway;
    this.#publicOrigin = origin(publicOrigin);
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#audit = audit;
  }

  #url(value) { return `${this.#publicOrigin}/api/v1/external-object-proxy/${value}/content`; }

  async issueInputs({ ownerIdentityId, jobId, attemptId, providerId, leaseExpiresAt, inputArtifacts }) {
    const owner = id(ownerIdentityId, "Owner identity");
    const job = id(jobId, "Job");
    const attempt = id(attemptId, "Attempt");
    const provider = id(providerId, "Provider");
    if (!Array.isArray(inputArtifacts)
        || inputArtifacts.some((value) => !artifact(value))) {
      fail("external_object_grant_invalid", "External input artifact list is invalid");
    }
    const expiresAt = expiry(this.#clock, leaseExpiresAt);
    const expiresInSeconds = Math.max(1, Math.ceil((expiresAt.getTime() - this.#clock().getTime()) / 1000));
    const audience = `external-provider:${provider}:${attempt}`;
    const created = [];
    const issuedReferences = [];
    try {
      for (const input of inputArtifacts) {
        const issued = await this.#objects.issue({
          actorIdentityId: owner,
          objectId: input.object.objectId,
          objectVersion: input.object.objectVersion,
          audience,
          operations: ["head", "read", "range"],
          expiresInSeconds,
        });
        issuedReferences.push(issued.referenceId);
        const bearer = ticket();
        const record = await this.#repository.create({
          grantId: this.#idFactory(), ticketDigest: digest(bearer), ownerIdentityId: owner,
          jobId: job, attemptId: attempt, providerId: provider, direction: "input", referenceId: issued.referenceId,
          audience, operations: ["head", "read", "range"], expectedSha256: input.object.sha256,
          expectedSize: input.object.size, maximumBytes: input.object.size,
          mediaType: input.object.mediaType, destinationObjectKey: null,
          // A large ranged download must not exhaust an arbitrary request
          // count. Lease expiry and revocation still terminate access.
          maximumUses: Number.MAX_SAFE_INTEGER, useCount: 0, state: "active", createdAt: this.#clock(),
          expiresAt, lastUsedAt: null, completedAt: null, failedAt: null,
          failureCode: null, revokedAt: null, revokeReason: null,
          completedObjectId: null, completedObjectVersion: null, completedSha256: null,
        });
        created.push({ record, bearer, role: input.role });
      }
    } catch (error) {
      await this.revokeAttempt({ ownerIdentityId: owner, attemptId: attempt, reason: "external_grant_rollback" }).catch(() => {});
      for (const referenceId of issuedReferences) {
        await this.#objects.revoke({ actorIdentityId: owner, referenceId, reason: "external_grant_rollback" }).catch(() => {});
      }
      throw error;
    }
    await this.#audit({ action: "external_object.inputs_issued", ownerIdentityId: owner, jobId: job, attemptId: attempt, providerId: provider, count: created.length });
    return Object.freeze(created.map(({ record, bearer, role }) => Object.freeze({
      role, url: this.#url(bearer), method: "GET", expiresAt: new Date(record.expiresAt).toISOString(),
      size: record.expectedSize, mediaType: record.mediaType,
      integrity: Object.freeze({ algorithm: "sha256", digest: record.expectedSha256 }),
    })));
  }

  async issueOutput({ ownerIdentityId, jobId, attemptId, providerId, leaseExpiresAt, contentType, maximumBytes, expectedSize = null, expectedSha256 = null, suffix = "bin" }) {
    const owner = id(ownerIdentityId, "Owner identity");
    const job = id(jobId, "Job");
    const attempt = id(attemptId, "Attempt");
    const provider = id(providerId, "Provider");
    const mediaType = safeContentType(contentType);
    const limit = Number(maximumBytes);
    if (!Number.isSafeInteger(limit) || limit < 1
        || (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > limit))
        || (expectedSha256 !== null && !SHA256.test(expectedSha256))) {
      fail("external_object_grant_invalid", "External output size or integrity contract is invalid");
    }
    const expiresAt = expiry(this.#clock, leaseExpiresAt);
    const bearer = ticket();
    const objectKey = `ai-outputs/external/${job}/${attempt}/${this.#idFactory()}.${safeSuffix(suffix)}`;
    const record = await this.#repository.create({
      grantId: this.#idFactory(), ticketDigest: digest(bearer), ownerIdentityId: owner,
      jobId: job, attemptId: attempt, providerId: provider, direction: "output", referenceId: null,
      audience: `external-provider:${provider}:${attempt}`, operations: ["write"],
      expectedSha256, expectedSize, maximumBytes: limit, mediaType,
      destinationObjectKey: objectKey, maximumUses: 1, useCount: 0, state: "active",
      createdAt: this.#clock(), expiresAt, lastUsedAt: null, completedAt: null,
      failedAt: null, failureCode: null, revokedAt: null, revokeReason: null,
      completedObjectId: null, completedObjectVersion: null, completedSha256: null,
    });
    await this.#audit({ action: "external_object.output_issued", ownerIdentityId: owner, jobId: job, attemptId: attempt, providerId: provider, grantId: record.grantId });
    return Object.freeze({
      url: this.#url(bearer), method: "PUT", expiresAt: new Date(record.expiresAt).toISOString(),
      contentType: mediaType, maximumBytes: limit,
      requiredHeaders: Object.freeze(["content-type", "x-content-sha256"]),
    });
  }

  async head({ ticket: bearer }) {
    const grant = await this.#authorizeBearer(bearer, "head");
    const metadata = await this.#objects.head({
      actorIdentityId: grant.ownerIdentityId, referenceId: grant.referenceId, audience: grant.audience,
    });
    this.#verifyMetadata(grant, metadata);
    return metadata;
  }

  async download({ ticket: bearer, range = null }) {
    const grant = await this.#authorizeBearer(bearer, range ? "range" : "read");
    const value = await this.#objects.download({
      actorIdentityId: grant.ownerIdentityId, referenceId: grant.referenceId,
      audience: grant.audience, range,
    });
    this.#verifyMetadata(grant, value.metadata);
    if (contentDigest(value.content) !== grant.expectedSha256 && !value.partial) {
      fail("external_object_integrity_failed", "External object content failed integrity verification", 409);
    }
    return value;
  }

  async upload({ ticket: bearer, contentType, content, sha256 }) {
    if (!TOKEN.test(bearer ?? "") || !(content instanceof Uint8Array)) {
      fail("external_object_reference_invalid", "External object reference is invalid or expired", 404);
    }
    const ticketDigest = digest(bearer);
    const now = this.#clock();
    const current = liveGrant(await this.#repository.findByTicketDigest(ticketDigest), "write", now);
    const mediaType = safeContentType(contentType);
    const actualSha256 = contentDigest(content);
    if (!SHA256.test(sha256 ?? "") || sha256 !== actualSha256 || mediaType !== current.mediaType
        || content.byteLength < 1 || content.byteLength > current.maximumBytes
        || (current.expectedSize !== null && content.byteLength !== current.expectedSize)
        || (current.expectedSha256 !== null && actualSha256 !== current.expectedSha256)) {
      fail("external_object_upload_mismatch", "External output does not match its scoped upload contract", 422);
    }
    const grant = await this.#repository.authorize({ ticketDigest, operation: "write", usedAt: now });
    if (!grant) fail("external_object_reference_invalid", "External object reference is invalid or expired", 404);
    try {
      const stored = await this.#objects.storeOutput({
        actorIdentityId: grant.ownerIdentityId, objectKey: grant.destinationObjectKey,
        contentType: grant.mediaType, content, expectedSha256: actualSha256.slice(7),
      });
      const completed = await this.#repository.completeOutput(grant.grantId, {
        completedAt: this.#clock(), objectId: stored.objectId, objectVersion: stored.version,
        sha256: `sha256:${stored.integrity.digest}`,
      });
      if (!completed) fail("external_object_output_reconcile_required", "External output commit requires reconciliation", 409);
      await this.#audit({ action: "external_object.output_completed", ownerIdentityId: grant.ownerIdentityId, jobId: grant.jobId, attemptId: grant.attemptId, providerId: grant.providerId, grantId: grant.grantId, objectId: stored.objectId });
      return Object.freeze({ objectId: stored.objectId, version: stored.version, size: stored.size, contentType: stored.contentType, integrity: stored.integrity });
    } catch (error) {
      await this.#repository.failOutput(grant.grantId, { failedAt: this.#clock(), failureCode: error?.code ?? "storage_failed" }).catch(() => {});
      throw error;
    }
  }

  async #authorizeBearer(bearer, operation) {
    if (!TOKEN.test(bearer ?? "")) fail("external_object_reference_invalid", "External object reference is invalid or expired", 404);
    const grant = await this.#repository.authorize({ ticketDigest: digest(bearer), operation, usedAt: this.#clock() });
    if (!grant) fail("external_object_reference_invalid", "External object reference is invalid or expired", 404);
    return grant;
  }

  #verifyMetadata(grant, metadata) {
    if (metadata.size !== grant.expectedSize || metadata.contentType !== grant.mediaType
        || `sha256:${metadata.integrity?.digest}` !== grant.expectedSha256) {
      fail("external_object_integrity_failed", "External object metadata failed integrity verification", 409);
    }
  }

  async revokeAttempt({ ownerIdentityId, attemptId, reason = "compute_attempt_finished" }) {
    const owner = id(ownerIdentityId, "Owner identity"); id(attemptId, "Attempt");
    if (typeof reason !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(reason)) throw new TypeError("external object revocation reason is invalid");
    const revoked = await this.#repository.revokeAttempt({ ownerIdentityId: owner, attemptId, revokedAt: this.#clock(), reason });
    for (const grant of revoked) {
      if (!grant.referenceId) continue;
      await this.#objects.revoke({ actorIdentityId: owner, referenceId: grant.referenceId, reason }).catch((error) => {
        if (error?.status !== 404) throw error;
      });
    }
    await this.#audit({ action: "external_object.attempt_revoked", ownerIdentityId: owner, attemptId, reason, count: revoked.length });
    return Object.freeze({ revoked: revoked.length });
  }
}

export const externalObjectTransferLimits = Object.freeze({
  maximumLifetimeMilliseconds: MAX_LIFETIME_MS,
  maximumOutputBytes: null,
});
