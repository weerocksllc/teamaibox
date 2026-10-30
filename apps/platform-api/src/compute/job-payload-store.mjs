import { createHash, randomUUID } from "node:crypto";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELATIONSHIPS = new Set(["input", "output", "error"]);
const DATA_CLASSES = new Set(["public", "internal", "confidential", "restricted"]);
const MAXIMUM_RESULT_DEPTH = 16;

function namespace(ownerIdentityId) {
  if (typeof ownerIdentityId !== "string" || !UUID.test(ownerIdentityId)) {
    throw new TypeError("job payload owner identity is invalid");
  }
  return `user:${ownerIdentityId.toLowerCase()}`;
}

function contextFor(ownerIdentityId, namespaceKey) {
  return Object.freeze({
    identityId: ownerIdentityId,
    identityKind: "local_user",
    namespaceAccess: Object.freeze([Object.freeze({
      namespaceKey,
      operations: Object.freeze(["write", "read", "delete", "reference:create"]),
    })]),
  });
}

function resultObjectTargets(value, targets = [], depth = 0) {
  if (depth > MAXIMUM_RESULT_DEPTH) {
    throw new PlatformError("compute_payload_invalid", "Compute result object graph exceeds its bounded shape", { status: 500 });
  }
  if (!value || typeof value !== "object") return targets;
  if (!Array.isArray(value)) {
    if (UUID.test(value.object_id ?? "")
      && Number.isSafeInteger(value.object_version) && value.object_version > 0) {
      targets.push({
        style: "snake", target: value,
        objectId: value.object_id, objectVersion: value.object_version,
      });
    } else if (UUID.test(value.objectId ?? "")
      && Number.isSafeInteger(value.objectVersion) && value.objectVersion > 0) {
      targets.push({
        style: "camel", target: value,
        objectId: value.objectId, objectVersion: value.objectVersion,
      });
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) resultObjectTargets(item, targets, depth + 1);
  } else {
    for (const item of Object.values(value)) resultObjectTargets(item, targets, depth + 1);
  }
  return targets;
}

export class ObjectJobPayloadStore {
  #objects;
  #clock;

  constructor({ objectService, clock = () => new Date() }) {
    if (!objectService?.upload || !objectService?.download || !objectService?.delete || !objectService?.createScopedReference) {
      throw new TypeError("protected object service is required for compute payloads");
    }
    this.#objects = objectService;
    this.#clock = clock;
  }

  async persist({ ownerIdentityId, jobId, relationship, dataClass, payload, inputArtifacts = [], registeredArtifacts = [] }) {
    if (!UUID.test(jobId) || !RELATIONSHIPS.has(relationship) || !DATA_CLASSES.has(dataClass)) {
      throw new TypeError("job payload identity is invalid");
    }
    if (!Array.isArray(inputArtifacts) || !Array.isArray(registeredArtifacts)) {
      throw new TypeError("job payload artifact lineage is invalid");
    }
    const namespaceKey = namespace(ownerIdentityId);
    const bytes = Buffer.from(JSON.stringify(payload), "utf8");
    if (bytes.byteLength < 1) throw new PlatformError("invalid_compute_payload", "Compute payload is empty", { status: 400 });
    const digest = createHash("sha256").update(bytes).digest("hex");
    const objectKey = `compute/jobs/${jobId}/${relationship}.v1.json`;
    try {
      const context = contextFor(ownerIdentityId, namespaceKey);
      const stored = await this.#objects.upload({
        context,
        namespaceKey,
        objectKey,
        contentType: "application/json",
        content: bytes,
        expectedSha256: digest,
      });
      let reference;
      try {
        reference = await this.#objects.createScopedReference({
          context, namespaceKey, objectId: stored.objectId, version: stored.version,
          audience: relationship === "input" ? "compute.worker-input" : "compute.user-result",
          operations: ["head", "read", "range"],
          expiresAt: new Date(this.#clock().getTime() + 15 * 60 * 1000),
        });
      } catch (error) {
        await this.#objects.delete({ context, namespaceKey, objectId: stored.objectId }).catch(() => {});
        throw error;
      }
      return Object.freeze({
        schemaVersion: 1,
        artifactId: randomUUID(),
        relationship,
        label: `compute.${relationship}`,
        dataClass,
        object: Object.freeze({
          objectId: stored.objectId,
          objectVersion: stored.version,
          referenceId: reference.reference.referenceId,
        }),
        mediaType: "application/json",
        sizeBytes: stored.size,
        integrity: Object.freeze({ algorithm: "sha256", digest: stored.integrity.digest }),
        lifecycleState: "verified",
        createdAt: this.#clock().toISOString(),
        extensions: Object.freeze({
          namespaceKey, objectKey, referenceAudience: reference.reference.audience,
          referenceExpiresAt: reference.reference.expiresAt,
          provenance: Object.freeze({ schemaVersion: 1, producerKind: "compute-job", producerId: jobId, relationship }),
          inputArtifacts: Object.freeze(structuredClone(inputArtifacts)),
          registeredArtifacts: Object.freeze(structuredClone(registeredArtifacts)),
        }),
      });
    } finally {
      bytes.fill(0);
    }
  }

  async refreshReference({ ownerIdentityId, artifact, audience = null, expiresInSeconds = 900 }) {
    const namespaceKey = namespace(ownerIdentityId);
    if (artifact?.extensions?.namespaceKey !== namespaceKey || !UUID.test(artifact?.object?.objectId)
      || !Number.isSafeInteger(artifact?.object?.objectVersion) || artifact.object.objectVersion < 1
      || !Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 900) {
      throw new PlatformError("compute_payload_unavailable", "Compute payload is unavailable", { status: 404 });
    }
    const selectedAudience = audience ?? (artifact.relationship === "input" ? "compute.worker-input" : "compute.user-result");
    if (!new Set(["compute.worker-input", "compute.user-result"]).has(selectedAudience)) {
      throw new PlatformError("compute_payload_reference_invalid", "Compute payload reference audience is invalid", { status: 400 });
    }
    const reference = await this.#objects.createScopedReference({
      context: contextFor(ownerIdentityId, namespaceKey), namespaceKey,
      objectId: artifact.object.objectId, version: artifact.object.objectVersion,
      audience: selectedAudience, operations: ["head", "read", "range"],
      expiresAt: new Date(this.#clock().getTime() + expiresInSeconds * 1000),
    });
    return Object.freeze({
      ...structuredClone(artifact),
      object: Object.freeze({ ...structuredClone(artifact.object), referenceId: reference.reference.referenceId }),
      extensions: Object.freeze({
        ...structuredClone(artifact.extensions), referenceAudience: selectedAudience,
        referenceExpiresAt: reference.reference.expiresAt,
      }),
    });
  }

  async refreshResultReferences({ ownerIdentityId, result, expiresInSeconds = 900 }) {
    const namespaceKey = namespace(ownerIdentityId);
    if (!result || typeof result !== "object" || Array.isArray(result)
      || !Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 900) {
      throw new PlatformError("compute_payload_unavailable", "Compute result is unavailable", { status: 404 });
    }
    const refreshed = structuredClone(result);
    const targets = resultObjectTargets(refreshed);
    const references = new Map();
    for (const item of targets) {
      const key = `${item.objectId}:${item.objectVersion}`;
      let reference = references.get(key);
      if (!reference) {
        const created = await this.#objects.createScopedReference({
          context: contextFor(ownerIdentityId, namespaceKey), namespaceKey,
          objectId: item.objectId, version: item.objectVersion,
          audience: "compute.user-result", operations: ["head", "read", "range"],
          expiresAt: new Date(this.#clock().getTime() + expiresInSeconds * 1000),
        });
        reference = created.reference;
        references.set(key, reference);
      }
      if (item.style === "snake") {
        item.target.reference_id = reference.referenceId;
        if (typeof item.target.preview_path === "string") {
          item.target.preview_path = `/api/v1/objects/references/${reference.referenceId}/content`;
        }
        if (typeof item.target.download_path === "string") {
          item.target.download_path = `/api/v1/objects/references/${reference.referenceId}/content?download=1`;
        }
      } else {
        item.target.referenceId = reference.referenceId;
      }
    }
    return Object.freeze(refreshed);
  }

  async read({ ownerIdentityId, artifact }) {
    const namespaceKey = namespace(ownerIdentityId);
    if (artifact?.extensions?.namespaceKey !== namespaceKey || !UUID.test(artifact?.object?.objectId)) {
      throw new PlatformError("compute_payload_unavailable", "Compute payload is unavailable", { status: 404 });
    }
    const result = await this.#objects.download({
      context: contextFor(ownerIdentityId, namespaceKey),
      namespaceKey,
      objectId: artifact.object.objectId,
      version: artifact.object.objectVersion,
    });
    try {
      return JSON.parse(result.content.toString("utf8"));
    } catch {
      throw new PlatformError("compute_payload_corrupt", "Compute payload is invalid", { status: 500 });
    } finally {
      result.content.fill(0);
    }
  }

  async discard({ ownerIdentityId, artifact }) {
    const namespaceKey = namespace(ownerIdentityId);
    if (artifact?.extensions?.namespaceKey !== namespaceKey || !UUID.test(artifact?.object?.objectId)) return false;
    await this.#objects.delete({
      context: contextFor(ownerIdentityId, namespaceKey),
      namespaceKey,
      objectId: artifact.object.objectId,
    });
    return true;
  }
}
