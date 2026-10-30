import { createHash, randomUUID } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { ArtifactProvenanceRepositoryError } from "./memory-artifact-provenance-repository.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const KEY = /^[a-z][a-z0-9_.:-]{1,190}$/;
const ARTIFACT_KINDS = new Set([
  "chat-attachment", "drive-file", "agent-artifact", "ai-input", "ai-result",
  "model-artifact",
]);
const PARTY_KINDS = new Set(["user", "application", "agent", "compute-job", "worker", "model-registry", "team-drive", "messaging"]);
const RELATIONSHIPS = new Set(["source", "input", "derived-from", "checkpoint-of", "version-of", "export-of", "copy-of"]);
const AUDIENCES = new Set([
  "messaging.attachment", "team-drive.file", "assistant.input", "assistant.artifact",
  "compute:image", "compute:ocr", "compute:asr", "compute:translation",
  "compute.worker-input", "compute.user-result",
  "model-registry.artifact",
]);

function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  throw new PlatformError("artifact_provenance_invalid", "Artifact provenance contains an unsupported value", { status: 400 });
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function identity(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) throw new PlatformError("artifact_provenance_invalid", `${label} is invalid`, { status: 400 });
  return value;
}

function key(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "string" || !KEY.test(value)) throw new PlatformError("artifact_provenance_invalid", `${label} is invalid`, { status: 400 });
  return value;
}

function facts(value) {
  if (!value || !UUID.test(value.objectId ?? "") || !Number.isSafeInteger(value.objectVersion) || value.objectVersion < 1
    || !Number.isSafeInteger(value.size) || value.size < 0 || typeof value.mediaType !== "string" || value.mediaType.length > 256
    || !SHA256.test(value.sha256 ?? "") || (value.objectKey !== undefined && (typeof value.objectKey !== "string" || value.objectKey.length > 1024))) {
    throw new PlatformError("artifact_object_unavailable", "Artifact object facts are unavailable", { status: 409 });
  }
  return Object.freeze({
    objectId: value.objectId,
    objectVersion: value.objectVersion,
    size: value.size,
    mediaType: value.mediaType,
    sha256: value.sha256,
    objectKey: value.objectKey ?? null,
  });
}

function boundedRecord(value, label, maximumBytes = 8192) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlatformError("artifact_provenance_invalid", `${label} is invalid`, { status: 400 });
  const serialized = canonical(value);
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) throw new PlatformError("artifact_provenance_invalid", `${label} exceeds its bounded size`, { status: 413 });
  return structuredClone(value);
}

function party(value, label) {
  if (!value || !PARTY_KINDS.has(value.kind)) throw new PlatformError("artifact_provenance_invalid", `${label} kind is invalid`, { status: 400 });
  return Object.freeze({
    kind: value.kind,
    key: key(value.key, `${label} key`),
    applicationKey: key(value.applicationKey, `${label} application key`, { nullable: true }),
    jobId: value.jobId === null || value.jobId === undefined ? null : identity(value.jobId, `${label} job`),
  });
}

function publicRecord(value) {
  return Object.freeze({
    id: value.id, artifactKind: value.artifactKind, object: Object.freeze(structuredClone(value.object)),
    ownerIdentityId: value.ownerIdentityId, producer: Object.freeze(structuredClone(value.producer)),
    sources: Object.freeze(value.sources.map((source) => Object.freeze(structuredClone(source)))),
    metadata: Object.freeze(structuredClone(value.metadata)), provenanceDigest: value.provenanceDigest,
    createdAt: new Date(value.createdAt).toISOString(),
  });
}

function translated(error) {
  if (!(error instanceof ArtifactProvenanceRepositoryError)) return error;
  return new PlatformError(error.code, error.message, { status: 409 });
}

export class ArtifactProvenanceService {
  #repository;
  #objects;
  #clock;
  #audit;

  constructor({ repository, objectGateway, clock = () => new Date(), audit = async () => {} }) {
    const methods = ["create", "findById", "findLatestByObject", "recordHandoff", "lineage"];
    if (!repository || methods.some((method) => typeof repository[method] !== "function")
      || !objectGateway?.resolve || !objectGateway?.issue || typeof clock !== "function" || typeof audit !== "function") {
      throw new TypeError("artifact provenance dependencies are incomplete");
    }
    this.#repository = repository;
    this.#objects = objectGateway;
    this.#clock = clock;
    this.#audit = audit;
  }

  async #resolve(actorIdentityId, referenceId, audience) {
    identity(actorIdentityId, "Actor identity"); identity(referenceId, "Object reference");
    if (!AUDIENCES.has(audience)) throw new PlatformError("artifact_audience_invalid", "Artifact reference audience is invalid", { status: 400 });
    return facts(await this.#objects.resolve({ actorIdentityId, referenceId, audience, requiredOperation: "read" }));
  }

  async register({ context, referenceId, audience, artifactKind, producer, sources = [], sourceObjects = [], metadata = {} }) {
    const ownerIdentityId = identity(context?.identityId, "Artifact owner");
    if (!ARTIFACT_KINDS.has(artifactKind) || !Array.isArray(sources) || !Array.isArray(sourceObjects)) {
      throw new PlatformError("artifact_provenance_invalid", "Artifact provenance declaration is invalid", { status: 400 });
    }
    const object = await this.#resolve(ownerIdentityId, referenceId, audience);
    const normalizedSources = [];
    for (const [ordinal, source] of sources.entries()) {
      if (!source || !RELATIONSHIPS.has(source.relationship) || !AUDIENCES.has(source.audience)) {
        throw new PlatformError("artifact_provenance_invalid", "Artifact source declaration is invalid", { status: 400 });
      }
      const sourceObject = await this.#resolve(ownerIdentityId, source.referenceId, source.audience);
      const existing = await this.#repository.findLatestByObject(sourceObject.objectId, sourceObject.objectVersion);
      normalizedSources.push(Object.freeze({
        ordinal, relationship: source.relationship,
        objectId: sourceObject.objectId, objectVersion: sourceObject.objectVersion,
        sha256: sourceObject.sha256, provenanceId: existing?.id ?? null,
      }));
    }
    for (const [offset, source] of sourceObjects.entries()) {
      if (!source || !RELATIONSHIPS.has(source.relationship)) {
        throw new PlatformError("artifact_provenance_invalid", "Resolved artifact source declaration is invalid", { status: 400 });
      }
      const sourceObject = facts(source.object);
      let provenanceId = null;
      if (source.provenanceId !== null && source.provenanceId !== undefined) {
        identity(source.provenanceId, "Source provenance");
        const existing = await this.#repository.findById(source.provenanceId);
        if (!existing || existing.ownerIdentityId !== ownerIdentityId
          || existing.object.objectId !== sourceObject.objectId
          || existing.object.objectVersion !== sourceObject.objectVersion
          || existing.object.sha256 !== sourceObject.sha256) {
          throw new PlatformError("artifact_provenance_invalid", "Resolved artifact source does not match durable provenance", { status: 409 });
        }
        provenanceId = existing.id;
      }
      normalizedSources.push(Object.freeze({
        ordinal: sources.length + offset, relationship: source.relationship,
        objectId: sourceObject.objectId, objectVersion: sourceObject.objectVersion,
        sha256: sourceObject.sha256, provenanceId,
      }));
    }
    const normalizedProducer = party(producer, "Artifact producer");
    const normalizedMetadata = boundedRecord(metadata, "Artifact metadata");
    const material = {
      schemaVersion: 1, artifactKind, object, ownerIdentityId, producer: normalizedProducer,
      sources: normalizedSources, metadata: normalizedMetadata,
    };
    const now = this.#clock();
    const record = {
      id: randomUUID(), ...material, provenanceDigest: digest(material), createdAt: now,
    };
    let result;
    try { result = await this.#repository.create(record); } catch (error) { throw translated(error); }
    await this.#audit({
      action: "artifact.provenance_registered", actorIdentityId: ownerIdentityId,
      artifactId: result.record.id, artifactKind, objectId: object.objectId,
      objectVersion: object.objectVersion, provenanceDigest: result.record.provenanceDigest,
      sourceCount: normalizedSources.length, created: result.created, occurredAt: now.toISOString(),
    });
    return Object.freeze({ record: publicRecord(result.record), created: result.created });
  }

  async consume({ context, referenceId, audience, consumer }) {
    const actorIdentityId = identity(context?.identityId, "Artifact consumer");
    const object = await this.#resolve(actorIdentityId, referenceId, audience);
    const provenance = await this.#repository.findLatestByObject(object.objectId, object.objectVersion);
    const normalizedConsumer = party(consumer, "Artifact consumer");
    const now = this.#clock();
    await this.#repository.recordHandoff({
      id: randomUUID(), provenanceId: provenance?.id ?? null,
      objectId: object.objectId, objectVersion: object.objectVersion,
      actorIdentityId, consumer: normalizedConsumer, audience, operation: "read", occurredAt: now,
    });
    await this.#audit({
      action: "artifact.handoff_consumed", actorIdentityId, artifactId: provenance?.id ?? null,
      objectId: object.objectId, objectVersion: object.objectVersion, audience,
      consumerKind: normalizedConsumer.kind, consumerKey: normalizedConsumer.key,
      occurredAt: now.toISOString(),
    });
    return Object.freeze({ object, provenance: provenance ? publicRecord(provenance) : null });
  }

  async issue({ context, artifactId, audience, expiresInSeconds = 600 }) {
    const actorIdentityId = identity(context?.identityId, "Artifact issuer");
    identity(artifactId, "Artifact identity");
    if (!AUDIENCES.has(audience) || !Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 900) {
      throw new PlatformError("artifact_reference_invalid", "Artifact reference request is invalid", { status: 400 });
    }
    const record = await this.#repository.findById(artifactId);
    if (!record || record.ownerIdentityId !== actorIdentityId) throw new PlatformError("artifact_not_found", "Artifact is unavailable", { status: 404 });
    return this.#objects.issue({
      actorIdentityId, objectId: record.object.objectId, objectVersion: record.object.objectVersion,
      audience, operations: ["head", "read", "range"], expiresInSeconds,
    });
  }

  async lineage({ context, artifactId }) {
    const actorIdentityId = identity(context?.identityId, "Artifact owner"); identity(artifactId, "Artifact identity");
    const value = await this.#repository.lineage(artifactId);
    if (!value || value.records[0]?.ownerIdentityId !== actorIdentityId) throw new PlatformError("artifact_not_found", "Artifact is unavailable", { status: 404 });
    return Object.freeze({ rootId: value.rootId, records: Object.freeze(value.records.map(publicRecord)) });
  }

  createMessagingAttachmentVerifier() {
    return Object.freeze({
      resolveAttachment: async ({ actorIdentityId, referenceId, audience, requiredOperation }) => {
        if (audience !== "messaging.attachment" || requiredOperation !== "read") throw new PlatformError("messaging_attachment_invalid", "Message attachment scope is invalid", { status: 400 });
        const value = await this.consume({
          context: { identityId: actorIdentityId }, referenceId, audience,
          consumer: { kind: "messaging", key: "messaging.message" },
        });
        const filename = value.object.objectKey?.split("/").at(-1) ?? "attachment";
        return Object.freeze({
          objectId: value.object.objectId, objectVersion: value.object.objectVersion,
          filename, mediaType: value.object.mediaType, byteSize: value.object.size, sha256: value.object.sha256,
        });
      },
      issueDownloadReference: async ({ actorIdentityId, objectId, objectVersion, expiresInSeconds = 300 }) => {
        identity(actorIdentityId, "Attachment reader");
        identity(objectId, "Attachment object");
        if (!Number.isSafeInteger(objectVersion) || objectVersion < 1
          || !Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 30 || expiresInSeconds > 600) {
          throw new PlatformError("messaging_attachment_invalid", "Message attachment download request is invalid", { status: 400 });
        }
        const issued = await this.#objects.issue({
          actorIdentityId, objectId, objectVersion,
          audience: "messaging.download", operations: ["head", "read", "range"], expiresInSeconds,
        });
        return Object.freeze({ referenceId: issued.referenceId, expiresAt: issued.expiresAt });
      },
    });
  }
}
