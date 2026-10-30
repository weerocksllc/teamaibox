import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_.:-]{1,190}$/;
const CAPABILITY_AUDIENCES = Object.freeze({
  "image-generation": "compute:image",
  image: "compute:image",
  ocr: "compute:ocr",
  asr: "compute:asr",
  translation: "compute:translation",
});
const CAPABILITIES = new Set(Object.keys(CAPABILITY_AUDIENCES));

function collect(value, path = "request", result = [], depth = 0) {
  if (depth > 16) throw new PlatformError("compute_artifact_input_invalid", "Compute artifact input exceeds its bounded shape", { status: 400 });
  if (!value || typeof value !== "object") return result;
  if (!Array.isArray(value) && Object.keys(value).length === 1 && typeof value.referenceId === "string") {
    result.push({ referenceId: value.referenceId, role: path });
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collect(item, `${path}.${index}`, result, depth + 1));
  } else {
    for (const [key, item] of Object.entries(value)) collect(item, `${path}.${key}`, result, depth + 1);
  }
  return result;
}

function resultReferences(value, result = new Set(), depth = 0) {
  if (depth > 16 || !value || typeof value !== "object") return result;
  if (typeof value.reference_id === "string" && UUID.test(value.reference_id)) result.add(value.reference_id);
  if (typeof value.referenceId === "string" && UUID.test(value.referenceId)) result.add(value.referenceId);
  if (Array.isArray(value)) value.forEach((item) => resultReferences(item, result, depth + 1));
  else for (const item of Object.values(value)) resultReferences(item, result, depth + 1);
  return result;
}

export class ComputeArtifactHandoff {
  #provenance;

  constructor({ provenanceService }) {
    if (!provenanceService?.consume || !provenanceService?.register) throw new TypeError("compute artifact handoff requires provenance service");
    this.#provenance = provenanceService;
  }

  async resolveInputs({ ownerIdentityId, jobId, capabilityKey, operation, request }) {
    if (!UUID.test(ownerIdentityId ?? "") || !UUID.test(jobId ?? "") || !CAPABILITIES.has(capabilityKey)
      || typeof operation !== "string" || !KEY.test(`compute.${operation}`)) return Object.freeze([]);
    const references = collect(request);
    const resolved = [];
    for (const item of references) {
      if (!UUID.test(item.referenceId)) throw new PlatformError("compute_artifact_input_invalid", "Compute artifact reference is invalid", { status: 400 });
      const value = await this.#provenance.consume({
        context: { identityId: ownerIdentityId }, referenceId: item.referenceId,
        audience: CAPABILITY_AUDIENCES[capabilityKey],
        consumer: { kind: "compute-job", key: `compute.${operation}`, jobId },
      });
      resolved.push(Object.freeze({
        role: item.role, object: value.object,
        provenanceId: value.provenance?.id ?? null,
      }));
    }
    return Object.freeze(resolved);
  }

  async registerResults({ ownerIdentityId, jobId, capabilityKey, operation, result, inputArtifacts = [] }) {
    if (!UUID.test(ownerIdentityId ?? "") || !UUID.test(jobId ?? "") || typeof operation !== "string") {
      throw new PlatformError("compute_artifact_result_invalid", "Compute artifact result identity is invalid", { status: 400 });
    }
    const registered = [];
    for (const referenceId of resultReferences(result)) {
      const value = await this.#provenance.register({
        context: { identityId: ownerIdentityId }, referenceId, audience: "compute.user-result",
        artifactKind: "ai-result",
        producer: { kind: "compute-job", key: `compute.${operation}`, jobId, applicationKey: `official.${capabilityKey}` },
        sourceObjects: inputArtifacts.map((item) => ({
          relationship: "derived-from", object: item.object, provenanceId: item.provenanceId,
        })),
        metadata: { schemaVersion: 1, capabilityKey, operation },
      });
      registered.push(value.record);
    }
    return Object.freeze(registered);
  }
}
